/**
 * The one agent class this app runs: an AG-UI HTTP agent that talks to this deployment's own
 * CopilotKit-compatible runtime.
 *
 * `@ag-ui/client`'s `HttpAgent` already speaks `POST {url}` + SSE for a run. Two things in this
 * product do not fit its defaults, and both are here rather than in a subclass of a subclass:
 *
 * 1. The runtime has no single `/run` endpoint. Every route names the agent and the operation —
 *    `/agent/:id/run`, `/agent/:id/connect` — so `url` is the run endpoint and `connect` builds its
 *    own, POSTing the same `RunAgentInput` and reading the same event stream.
 * 2. The request must carry the session cookie. `credentials: "include"` is added to every request
 *    this class makes, including the ones `HttpAgent` builds for a run, which is why it is done in
 *    `requestInit` and not at the call site.
 *
 * `AbstractAgent.connect()` throws `AGUIConnectNotImplementedError`, so `connect` is the only gap
 * that has to be filled; the event stream it returns is transformed, enforced and applied by the
 * base class exactly as a run's is.
 */
import {
  HttpAgent,
  enforceOutgoingInput,
  runHttpRequest,
  transformHttpEventStream,
  type RunAgentInput,
} from "@ag-ui/client";

export interface RuntimeAgentConfig {
  /** The runtime's own base URL, such as `/api/copilotkit`. */
  runtimeUrl: string;
  /** The agent to address at the runtime, such as a channel's Bot id. */
  runtimeAgentId: string;
  /** The name this agent is registered under in the browser. Defaults to the runtime id. */
  agentId?: string;
  /** The thread this agent's runs belong to. */
  threadId?: string;
  initialMessages?: RunAgentInput["messages"];
  headers?: Record<string, string>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** The endpoint that starts a run for one agent. */
export function runUrl(runtimeUrl: string, runtimeAgentId: string): string {
  return `${runtimeBase(runtimeUrl)}/agent/${encodeURIComponent(runtimeAgentId)}/run`;
}

/** The endpoint that attaches to a thread, replaying it and then following the live run. */
export function connectUrl(runtimeUrl: string, runtimeAgentId: string): string {
  return `${runtimeBase(runtimeUrl)}/agent/${encodeURIComponent(runtimeAgentId)}/connect`;
}

/** The endpoint that asks the server to stop a thread's run. */
export function stopUrl(
  runtimeUrl: string,
  runtimeAgentId: string,
  threadId: string,
): string {
  return `${runtimeBase(runtimeUrl)}/agent/${encodeURIComponent(runtimeAgentId)}/stop/${encodeURIComponent(threadId)}`;
}

/** Trailing slashes are the one thing a base URL gets wrong at every call site, so they go once. */
function runtimeBase(runtimeUrl: string): string {
  return runtimeUrl.replace(/\/+$/, "");
}

export class RuntimeAgent extends HttpAgent {
  readonly runtimeUrl: string;
  readonly runtimeAgentId: string;
  /**
   * What went wrong on this agent's last run, or null.
   *
   * The base agent reports a failure through its subscribers and keeps nothing, which leaves a
   * surface that mounts after the failure with no way to say what happened. Held here so a reload of
   * the same screen — or a second card on it — reads the same sentence the first one saw. Cleared
   * when the next run begins, because a sentence about a turn that is over should stay until there is
   * something newer to look at.
   */
  error: Error | null = null;

  constructor(config: RuntimeAgentConfig) {
    const { runtimeUrl, runtimeAgentId } = config;
    super({
      // `url` is the run endpoint. `HttpAgent.run` posts to it.
      url: runUrl(runtimeUrl, runtimeAgentId),
      agentId: config.agentId ?? runtimeAgentId,
      threadId: config.threadId,
      initialMessages: config.initialMessages,
      headers: config.headers,
      fetch: config.fetch,
    });
    // Assigned after `super`, because `super` is called before these fields exist.
    this.runtimeUrl = runtimeBase(runtimeUrl);
    this.runtimeAgentId = runtimeAgentId;
    this.subscribe({
      onRunInitialized: () => {
        this.error = null;
      },
      onRunErrorEvent: ({ event }) => {
        this.error = new Error(
          typeof event.message === "string" && event.message.trim()
            ? event.message
            : "The run failed.",
        );
      },
      onRunFailed: ({ error }) => {
        this.error = error;
      },
    });
  }

  /** Every request this agent makes carries the session cookie. */
  protected requestInit(input: RunAgentInput): RequestInit {
    return {
      ...super.requestInit(input),
      credentials: "include",
    };
  }

  /**
   * Attach to the thread instead of starting a run in it.
   *
   * The same `RunAgentInput` goes on the wire as for a run, because the server resumes the thread
   * from the input it is given; what differs is that the answer is a replay followed by the live
   * run, not a fresh turn. `HttpAgent`'s helpers build and parse the exchange, so this cannot drift
   * from what a run does with cookies, headers or the SSE accept.
   */
  protected connect(input: RunAgentInput) {
    const url = connectUrl(this.runtimeUrl, this.runtimeAgentId);
    return transformHttpEventStream(
      runHttpRequest(() =>
        this.fetch(url, this.requestInit(enforceOutgoingInput(input))),
      ),
      this.debugLogger,
    );
  }
}
