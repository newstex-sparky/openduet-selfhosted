/**
 * The protocol engine: the HTTP surface OpenDuet's browser half speaks, owned by this repository.
 *
 * WHY THIS EXISTS. Until now this fork mounted `createCopilotHonoHandler` from the CopilotKit
 * runtime package and handed it a `CopilotRuntime`. Everything the fork actually exercised in
 * that package is here instead: the route table (`./routes.ts`), the SSE response (`./sse.ts`), the
 * per-request agent clone and middleware attach (`./agent-request.ts`), the thread reads and the run
 * lifecycle. The run pipeline itself was never the vendor's here — local mode drives the fork's own
 * Postgres runner — so this engine keeps that seam and only takes over the parts above it.
 *
 * WHAT IS NOT PORTED, DELIBERATELY. The vendor's Intelligence branches (channels, memories,
 * annotations, trajectories, inspector learning, licence checks, telemetry capture) have no meaning
 * in a deployment with no vendor client. Each corresponding route still ANSWERS, with the answer
 * the vendor gave in SSE mode, because a browser or a health check that probes them must not hang.
 *
 * THE WIRE CONTRACT IS UNCHANGED. Same paths, same methods, same SSE framing through
 * `@ag-ui/encoder`, same `mode: "sse"` in `/info`. The browser half was written against those, and
 * this rewrite is not allowed to be a protocol change.
 */
import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { Observable, type Subject } from "rxjs";
import {
  type AgentsSource,
  cloneAgentForRequest,
  configureAgentForRequest,
  mergeForwardableHeaders,
  parseConnectRequest,
  parseRunRequest,
  resolveAgents,
} from "./agent-request";
import {
  jsonResponse,
  matchRoute,
  type Route,
  validateHttpMethod,
} from "./routes";
import { createSseEventResponse } from "./sse";

/**
 * A thread as the thread list shows it.
 *
 * Structural rather than imported from the platform, so this engine can be driven by any store that
 * answers the same fields — the Postgres platform does, and so does a test double.
 */
export type ThreadSummary = {
  id: string;
  name?: string | null;
  agentId?: string;
  createdById?: string;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
};

/** What the engine needs from a run store: the run lifecycle, plus the thread reads the REST family serves. */
export type EngineRunner = {
  /** One run of one Bot into one conversation, as AG-UI events. */
  run(request: {
    threadId: string;
    agent: AbstractAgent;
    input: RunAgentInput;
    persistedInputMessages?: RunAgentInput["messages"];
  }): Observable<BaseEvent>;
  /** Replay and tail the events of a conversation whose run this process can see. */
  connect(request: {
    threadId: string;
    agentId: string;
    headers?: Record<string, string>;
  }): Observable<BaseEvent>;
  stop(request: { threadId: string; runId?: string }): Promise<boolean | undefined>;
  /** Set on a runner that can answer the `/threads` family synchronously; see `supportsThreads`. */
  listThreads?(): ThreadSummary[];
  getThreadMessages?(threadId: string): RunAgentInput["messages"];
  getThreadEvents?(threadId: string): BaseEvent[];
  getThreadState?(threadId: string): Record<string, unknown> | null;
  clearThreads?(): void;
};

/** Everything one deployment tells the engine. */
export type EngineOptions = {
  /** The Bots, or a factory resolved per request so a Bot registered later is reachable. */
  agents: AgentsSource;
  runner: EngineRunner;
  /**
   * Silence, in seconds, before an event stream writes an SSE comment.
   *
   * Set below the host's idle timeout or a slow model loses its stream; see `./sse.ts`.
   */
  sseKeepAliveIntervalSeconds?: number;
  /** Whether Bots may answer with an interface they wrote themselves. */
  openGenerativeUi?: boolean;
  /** The deployment's A2UI setting, echoed in `/info` so the browser can mount or skip the renderer. */
  a2ui?: { enabled: boolean };
};

/** The engine, as the handler sees it. */
export type Engine = EngineOptions;

/** The one version string `/info` reports. Bumped only for a wire-visible change. */
const ENGINE_VERSION = "openduet-engine/1";

/** Whether a runner can answer the `/threads` family, i.e. holds threads this engine can read. */
export function supportsThreads(
  runner: EngineRunner,
): runner is EngineRunner &
  Required<
    Pick<
      EngineRunner,
      | "listThreads"
      | "getThreadMessages"
      | "getThreadEvents"
      | "getThreadState"
      | "clearThreads"
    >
  > {
  return typeof runner.listThreads === "function";
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * `/{agentId}/suggest`: a stateless run whose events never touch a thread.
 *
 * The client forces `toolChoice: copilotkitSuggest` in the body, so the run is a provider call and
 * nothing else. It deliberately does NOT go through the runner: a suggestion is not a turn, and
 * persisting one would put a throwaway exchange in the person's history.
 */
async function handleSuggest(
  engine: Engine,
  request: Request,
  agentId: string,
): Promise<Response> {
  const agent = await cloneAgentForRequest(engine.agents, agentId, request);
  if (agent instanceof Response) return agent;
  agent.agentId = agentId;
  const input = await parseRunRequest(request);
  if (input instanceof Response) return input;
  const host = agent as unknown as { headers?: Record<string, string> };
  host.headers = mergeForwardableHeaders(host.headers, request);
  agent.setMessages(input.messages);
  agent.setState(input.state);
  agent.threadId = input.threadId;
  return createSseEventResponse({
    request,
    keepAliveIntervalSeconds: engine.sseKeepAliveIntervalSeconds,
    observableFactory: () =>
      new Observable<BaseEvent>((subscriber) => {
        let settled = false;
        agent
          .runAgent(input, {
            onEvent: ({ event }) => {
              subscriber.next(event);
            },
          })
          .then(() => {
            settled = true;
            subscriber.complete();
          })
          .catch((error: unknown) => {
            settled = true;
            subscriber.error(error);
          });
        return () => {
          if (!settled) {
            try {
              agent.abortRun();
            } catch {
              // A run that has already settled its model call has nothing to abort.
            }
          }
        };
      }),
  });
}

/** `POST /agent/:id/run`: the person's turn. */
async function handleRun(
  engine: Engine,
  request: Request,
  agentId: string,
): Promise<Response> {
  const agent = await cloneAgentForRequest(engine.agents, agentId, request);
  if (agent instanceof Response) return agent;
  agent.agentId = agentId;
  const input = await parseRunRequest(request);
  if (input instanceof Response) return input;
  configureAgentForRequest({
    configuration: {
      providerA2uiHasCatalog: input.forwardedProps?.a2uiCatalogAvailable === true,
      openGenerativeUi: engine.openGenerativeUi === true,
      a2ui: engine.a2ui,
    },
    request,
    agentId,
    agent,
  });
  agent.setMessages(input.messages);
  agent.setState(input.state);
  agent.threadId = input.threadId;
  return createSseEventResponse({
    request,
    keepAliveIntervalSeconds: engine.sseKeepAliveIntervalSeconds,
    observableFactory: () =>
      engine.runner.run({ threadId: input.threadId, agent, input }),
  });
}

/** `POST /agent/:id/connect`: replay a conversation's events and tail the run that is live. */
async function handleConnect(
  engine: Engine,
  request: Request,
  agentId: string,
): Promise<Response> {
  const agent = await cloneAgentForRequest(engine.agents, agentId, request);
  if (agent instanceof Response) return agent;
  const connectRequest = await parseConnectRequest(request);
  if (connectRequest instanceof Response) return connectRequest;
  const headers = mergeForwardableHeaders(
    (agent as unknown as { headers?: Record<string, string> }).headers,
    request,
  );
  return createSseEventResponse({
    request,
    keepAliveIntervalSeconds: engine.sseKeepAliveIntervalSeconds,
    observableFactory: () =>
      engine.runner.connect({
        threadId: connectRequest.input.threadId,
        agentId,
        ...(headers === undefined ? {} : { headers }),
      }),
  });
}

/** Read `{ runId? }` from a stop body; a Response when the body is not a valid scope. */
async function parseStopScope(
  request: Request,
): Promise<{ runId?: string } | Response> {
  try {
    const raw = await request.text();
    const body: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return jsonResponse({ error: "Invalid stop request" }, 400);
    if (Object.keys(body).some((key) => key !== "runId"))
      return jsonResponse({ error: "Invalid stop request" }, 400);
    if (!("runId" in body)) return {};
    const runId = (body as { runId?: unknown }).runId;
    if (typeof runId !== "string" || !runId.trim())
      return jsonResponse({ error: "Invalid runId" }, 400);
    return { runId };
  } catch {
    return jsonResponse({ error: "Invalid stop request" }, 400);
  }
}

/** `POST /agent/:id/stop/:threadId`: stop that conversation's live run. */
async function handleStop(
  engine: Engine,
  request: Request,
  agentId: string,
  threadId: string,
): Promise<Response> {
  const scope = await parseStopScope(request.clone());
  if (scope instanceof Response) return scope;
  const agents = await resolveAgents(engine.agents, request);
  if (!agents[agentId])
    return new Response(
      JSON.stringify({
        error: "Agent not found",
        message: `Agent '${agentId}' does not exist`,
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  const stopped = await engine.runner.stop({
    threadId,
    ...(scope.runId === undefined ? {} : { runId: scope.runId }),
  });
  if (!stopped)
    return jsonResponse(
      {
        stopped: false,
        message:
          scope.runId === undefined
            ? `No active run for thread '${threadId}'.`
            : `Run '${scope.runId}' is not the active run for thread '${threadId}'.`,
      },
      200,
    );
  return jsonResponse(
    {
      stopped: true,
      interrupt: {
        type: "RUN_ERROR",
        message: "Run stopped by user",
        code: "STOPPED",
      },
    },
    200,
  );
}

/** `GET /info`: what this deployment offers, which is how the browser half configures itself. */
async function handleInfo(
  engine: Engine,
  request: Request,
): Promise<Response> {
  try {
    const agents = await resolveAgents(engine.agents, request);
    const entries = await Promise.all(
      Object.entries(agents).map(async ([name, agent]) => {
        let capabilities: unknown;
        try {
          capabilities = agent.getCapabilities
            ? await agent.getCapabilities()
            : undefined;
        } catch {
          capabilities = undefined;
        }
        return [
          name,
          {
            name,
            description: agent.description,
            className: agent.constructor.name,
            ...(capabilities ? { capabilities } : {}),
          },
        ] as const;
      }),
    );
    const threads = supportsThreads(engine.runner);
    const a2uiEnabled = engine.a2ui?.enabled === true;
    return jsonResponse(
      {
        version: ENGINE_VERSION,
        agents: Object.fromEntries(entries),
        audioFileTranscriptionEnabled: false,
        mode: "sse",
        threadEndpoints: {
          list: threads,
          inspect: threads,
          mutations: false,
          realtimeMetadata: false,
        },
        suggestions: true,
        a2uiEnabled,
        ...(a2uiEnabled ? { a2ui: { enabled: true } } : {}),
        openGenerativeUIEnabled: engine.openGenerativeUi === true,
        telemetryDisabled: true,
      },
      200,
    );
  } catch (error) {
    return jsonResponse(
      {
        error: "Failed to retrieve runtime information",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
}

/**
 * The `/threads` family, answered from the runner's own reads.
 *
 * SYNCHRONOUS BY CONTRACT. These read a mirror the platform loaded for this request before the
 * engine was called (`primeThread` in `server/src/copilot.ts`), because a promise here would be
 * serialized as `{}`. The scoping is the runner's: every read is filtered by the person the request
 * runs as, so one person's list is never another's.
 */
function handleThreads(
  engine: Engine,
  request: Request,
  route: Route & { method: `threads/${string}` },
): Response {
  if (!supportsThreads(engine.runner))
    return errorResponse(
      "This engine's runner does not hold threads these endpoints can read.",
      422,
    );
  const runner = engine.runner;
  switch (route.method) {
    case "threads/list": {
      const agentId = new URL(request.url).searchParams.get("agentId");
      let threads = runner.listThreads();
      if (agentId) threads = threads.filter((t) => t.agentId === agentId);
      return jsonResponse({ threads, nextCursor: null }, 200);
    }
    case "threads/messages": {
      const mapped = runner.getThreadMessages(route.threadId).map((msg) => {
        switch (msg.role) {
          case "assistant": {
            const toolCalls = msg.toolCalls ?? [];
            return {
              id: msg.id,
              role: msg.role,
              ...(msg.content !== undefined ? { content: msg.content } : {}),
              ...(toolCalls.length > 0
                ? {
                    toolCalls: toolCalls.map((call) => ({
                      id: call.id,
                      name: call.function.name,
                      args: call.function.arguments,
                    })),
                  }
                : {}),
            };
          }
          case "tool":
            return {
              id: msg.id,
              role: msg.role,
              content: msg.content,
              toolCallId: msg.toolCallId,
            };
          default:
            return {
              id: msg.id,
              role: msg.role,
              ...("content" in msg && msg.content !== undefined
                ? { content: msg.content }
                : {}),
            };
        }
      });
      return jsonResponse({ messages: mapped }, 200);
    }
    case "threads/events":
      return jsonResponse(
        { events: runner.getThreadEvents(route.threadId) },
        200,
      );
    case "threads/state":
      return jsonResponse(
        { state: runner.getThreadState(route.threadId) },
        200,
      );
    case "threads/clear": {
      runner.clearThreads();
      return new Response(null, { status: 204 });
    }
    case "threads/subscribe":
      return errorResponse(
        "Thread subscriptions need a realtime backend this deployment does not have.",
        422,
      );
    case "threads/update":
    case "threads/archive":
      return errorResponse(
        "Thread mutations need a thread backend that can write them.",
        422,
      );
  }
}

/** Dispatch one matched route. `undefined` never reaches here. */
async function dispatchRoute(
  engine: Engine,
  request: Request,
  route: Route,
): Promise<Response> {
  switch (route.method) {
    case "agent/run":
      return handleRun(engine, request, route.agentId);
    case "agent/suggest":
      return handleSuggest(engine, request, route.agentId);
    case "agent/connect":
      return handleConnect(engine, request, route.agentId);
    case "agent/stop":
      return handleStop(engine, request, route.agentId, route.threadId);
    case "info":
      return handleInfo(engine, request);
    case "threads/list":
    case "threads/messages":
    case "threads/events":
    case "threads/state":
    case "threads/clear":
    case "threads/subscribe":
    case "threads/update":
    case "threads/archive":
      return handleThreads(engine, request, route);
    /*
     * The vendor's answers in SSE mode, kept so a probe or a stale client gets the same result it
     * used to rather than a hang or a 500. None of these has a meaning without a vendor client.
     */
    case "inspector/metadata":
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store, private" },
      });
    case "inspector/learning":
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: {
          "Cache-Control": "no-store, private",
          "Content-Type": "application/json",
        },
      });
    case "transcribe":
      return jsonResponse(
        {
          error: "SERVICE_NOT_CONFIGURED",
          message: "Audio transcription is not configured for this deployment.",
        },
        503,
      );
    case "trajectory/connect":
      return jsonResponse(
        {
          code: "CONNECTION_FAILED",
          message: "Trajectory capture requires a backend this deployment does not have",
        },
        503,
        { "Cache-Control": "no-store" },
      );
    case "annotate":
      return jsonResponse(
        {
          error:
            "annotate needs a learning backend this deployment does not have.",
        },
        422,
      );
    case "memories/list":
    case "memories/recall":
    case "memories/subscribe":
    case "memories/mutate":
      return jsonResponse({ error: "Not found" }, 404);
    case "cpk-debug-events":
      return new Response("Not Found", { status: 404 });
  }
}

/** A handler that answers the engine's routes for one base path. */
export type EngineHandler = {
  fetch(request: Request): Promise<Response>;
};

/**
 * The `fetch`-shaped handler to mount under `basePath`.
 *
 * Every route the vendor mounted in multi-route mode is matched here; the single-route envelope and
 * the CORS/hook configuration the vendor also offered are not, because this deployment mounts one
 * Hono route behind its own gate and passes neither.
 */
export function createEngineHandler(options: {
  engine: Engine;
  basePath?: string;
}): EngineHandler {
  const { engine, basePath } = options;
  return {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url, "http://localhost").pathname;
      const matched = matchRoute(path, basePath);
      if (!matched) return jsonResponse({ error: "Not found" }, 404);
      if (matched.method.startsWith("memories/"))
        return jsonResponse({ error: "Not found" }, 404);
      const methodError = validateHttpMethod(request.method, matched);
      if (methodError) return methodError;
      try {
        return await dispatchRoute(engine, request, matched);
      } catch (error) {
        console.error("Unhandled error in the protocol engine:", error);
        return jsonResponse({ error: "internal_error" }, 500);
      }
    },
  };
}

/** A subject type kept exported so a caller can hand the engine a live event source in tests. */
export type EventStream = Subject<BaseEvent>;
