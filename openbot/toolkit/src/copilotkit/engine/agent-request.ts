/**
 * What a run request means: which Bot, which conversation, and what the vendor protocol allows.
 *
 * Ported from the CopilotKit runtime package, 1.77.0: `handlers/shared/agent-utils.mjs` and
 * `handlers/header-utils.mjs` (MIT), with the vendor-only branches removed: there is no vendor
 * client in this deployment, so nothing here resolves a user, attaches a vendor's MCP tools or
 * reads a licence.
 *
 * TWO THINGS ARE KEPT EXACTLY AS THE VENDOR HAD THEM, because OpenDuet's behaviour depends on them:
 *
 *   1. THE CLONE. Every run gets `agents[agentId].clone()`, never the registered instance. Middleware
 *      and headers are attached to the clone, so one person's run cannot configure the next
 *      person's. Everything downstream that assumed a fresh agent per request assumes it still.
 *   2. THE GUARD. An unknown `agentId` is a 404 `Response` returned in the agent's place. Both the
 *      run and the connect path depend on that shape, so callers must `instanceof Response`-check.
 */
import type { AbstractAgent, Message, RunAgentInput } from "@ag-ui/client";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import {
  A2UIMiddleware,
  OpenGenerativeUIMiddleware,
} from "@copilotkit/shared/event-transforms";

/** Exact header names (lowercased) this engine never forwards to a Bot's endpoint. */
const DEFAULT_DENY_HEADER_NAMES = new Set([
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-server",
  "x-real-ip",
  "x-amzn-trace-id",
  "x-amz-cf-id",
  "x-cloud-trace-context",
  "x-cache",
  "x-served-by",
  "x-request-id",
  "x-copilotcloud-public-api-key",
]);

/** Header-name prefixes (lowercased) stripped for the same reason as the exact names above. */
const DEFAULT_DENY_HEADER_PREFIXES = [
  "x-amz-",
  "x-azure-",
  "x-fastly-",
  "x-vercel-",
  "x-middleware-",
  "x-copilotcloud-",
];

/** Whether one header is forwarded: `authorization` and `x-*`, minus the infrastructure families. */
function shouldForwardHeader(headerName: string): boolean {
  const lower = headerName.toLowerCase();
  if (!(lower === "authorization" || lower.startsWith("x-"))) return false;
  if (DEFAULT_DENY_HEADER_NAMES.has(lower)) return false;
  return !DEFAULT_DENY_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * The Bot's own headers, plus whatever this request may pass through.
 *
 * Kept so a Bot pointed at somebody else's endpoint still receives the person's `authorization`
 * without the browser's proxy headers riding along.
 */
export function mergeForwardableHeaders(
  existing: Record<string, string> | undefined,
  request: Request,
): Record<string, string> | undefined {
  const forwarded: Record<string, string> = { ...existing };
  let any = existing !== undefined;
  for (const [name, value] of request.headers) {
    if (!shouldForwardHeader(name)) continue;
    forwarded[name] = value;
    any = true;
  }
  return any ? forwarded : undefined;
}

/** What the engine's agents option is: a record, or a factory resolved per request. */
export type AgentsSource =
  | Record<string, AbstractAgent>
  | ((input: { request: Request }) => Promise<Record<string, AbstractAgent>>);

/** Resolve the agents for one request. A factory is how a Bot registered at runtime is reachable. */
export async function resolveAgents(
  agents: AgentsSource,
  request: Request,
): Promise<Record<string, AbstractAgent>> {
  if (typeof agents === "function") return agents({ request });
  return agents;
}

/** An unknown Bot, as both the run and the connect path answer it. */
function agentNotFound(agentId: string): Response {
  return new Response(
    JSON.stringify({
      error: "Agent not found",
      message: `Agent '${agentId}' does not exist`,
    }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
}

/** The per-request clone of a registered Bot, or the 404 that replaces it. */
export async function cloneAgentForRequest(
  agents: AgentsSource,
  agentId: string,
  request: Request,
): Promise<AbstractAgent | Response> {
  const resolved = await resolveAgents(agents, request);
  const found = resolved[agentId];
  if (!found) return agentNotFound(agentId);
  return found.clone();
}

/** What the run path may attach to a cloned Bot before it runs. */
export type RequestConfiguration = {
  /** The browser says it has an A2UI catalog, which turns the A2UI tool on for this run. */
  providerA2uiHasCatalog: boolean;
  /** Whether this deployment offers Bots the ability to draw their own interface. */
  openGenerativeUi: boolean;
  /** The deployment's A2UI setting; `enabled: false` keeps stale clients from reactivating it. */
  a2ui: { enabled: boolean } | undefined;
};

/**
 * Attach the middleware a run needs, and the headers it may forward.
 *
 * The A2UI and generative-UI middleware are not ours — they are the browser-facing halves of those
 * two features and they ride on the agent, so a Bot can only draw if it is given them. Everything
 * else the vendor attached here was Intelligence's, and this deployment has none.
 */
export function configureAgentForRequest(input: {
  configuration: RequestConfiguration;
  request: Request;
  agentId: string;
  agent: AbstractAgent;
}): void {
  const { configuration, request, agentId, agent } = input;
  type MiddlewareHost = { use?: (middleware: unknown) => void; headers?: Record<string, string> };
  const host = agent as unknown as MiddlewareHost;

  const a2uiEnabledByCatalog =
    configuration.providerA2uiHasCatalog &&
    configuration.a2ui?.enabled !== false;
  if (configuration.a2ui?.enabled || a2uiEnabledByCatalog) {
    if (typeof host.use === "function")
      host.use(
        new A2UIMiddleware({
          injectA2UITool: configuration.providerA2uiHasCatalog ? true : undefined,
        }),
      );
  }
  if (configuration.openGenerativeUi && typeof host.use === "function")
    host.use(new OpenGenerativeUIMiddleware());

  host.headers = mergeForwardableHeaders(host.headers, request);
}

/**
 * The 0.x `{ type: "binary" }` content part, which AG-UI 1.0 retired.
 *
 * Old clients still send it, and a run that refused them would be a run that broke on a client
 * upgrade rather than on anything the person did. Data or url becomes the media part its mime type
 * names; a binary part that only mirrors a modern part already in the message is dropped.
 */
function upgradeLegacyBinaryParts(content: unknown[]): unknown[] {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const mediaTypeFor = (mimeType: string): string => {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.startsWith("video/")) return "video";
    return "document";
  };
  return content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "binary") return [part];
    const mimeType = part.mimeType;
    if (typeof mimeType !== "string") return [part];
    const kind = typeof part.data === "string" ? "data" : typeof part.url === "string" ? "url" : null;
    if (kind === null) {
      console.warn(
        "[engine] Dropping a legacy binary content part that has no data or url; AG-UI 1.0 has no equivalent for it.",
      );
      return [];
    }
    const converted = {
      type: mediaTypeFor(mimeType),
      source: {
        type: kind,
        value: kind === "data" ? part.data : part.url,
        mimeType,
      },
    };
    const alreadyPresent = content.some((other) => {
      if (!isRecord(other) || other.type !== converted.type) return false;
      const source = other.source;
      return (
        isRecord(source) &&
        source.type === converted.source.type &&
        source.value === converted.source.value &&
        source.mimeType === converted.source.mimeType
      );
    });
    return alreadyPresent ? [] : [converted];
  });
}

/** `omitLegacyNull`: a field AG-UI used to send as `null`, which 1.0 requires to be absent. */
function omitLegacyNull(
  value: unknown,
  field: string,
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (record[field] === null) delete record[field];
  return record;
}

function mapArrayField(
  value: unknown,
  field: string,
  normalize: (entry: unknown) => unknown,
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const original = record[field];
  if (!Array.isArray(original)) return value;
  const entries = original.map(normalize);
  const changed = entries.some((entry, index) => entry !== original[index]);
  return changed ? { ...record, [field]: entries } : value;
}

/** Normalize the deprecated shapes a 0.x client may still send into what AG-UI 1.0 declares. */
function normalizeLegacyRunAgentInput(input: unknown): unknown {
  let normalized = omitLegacyNull(input, "forwardedProps");
  normalized = mapArrayField(normalized, "tools", (tool) =>
    omitLegacyNull(tool, "parameters"),
  );
  normalized = mapArrayField(normalized, "resume", (entry) =>
    omitLegacyNull(entry, "payload"),
  );
  return mapArrayField(normalized, "messages", (message) => {
    if (typeof message !== "object" || message === null) return message;
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record.content)) return message;
    const hasLegacyBinary = record.content.some(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "binary",
    );
    const upgraded = hasLegacyBinary
      ? { ...record, content: upgradeLegacyBinaryParts(record.content) }
      : message;
    return mapArrayField(upgraded, "content", (part) => {
      if (typeof part !== "object" || part === null) return part;
      const kind = (part as { type?: unknown }).type;
      if (kind === "image" || kind === "audio" || kind === "video" || kind === "document")
        return omitLegacyNull(part, "metadata");
      return part;
    });
  });
}

/** Parse a run body, or the 400 that says why it is not one. */
export async function parseRunRequest(
  request: Request,
): Promise<RunAgentInput | Response> {
  try {
    return RunAgentInputSchema.parse(
      normalizeLegacyRunAgentInput(await request.json()),
    ) as RunAgentInput;
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: "Invalid request body",
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
}

/** Parse a connect body: the run input plus the last event the caller already has. */
export async function parseConnectRequest(
  request: Request,
): Promise<{ input: RunAgentInput; lastSeenEventId: string | null } | Response> {
  try {
    const body: unknown = await request.json();
    const input = RunAgentInputSchema.parse(
      normalizeLegacyRunAgentInput(body),
    ) as RunAgentInput;
    let lastSeenEventId: string | null = null;
    if (
      typeof body === "object" &&
      body !== null &&
      "lastSeenEventId" in body
    ) {
      const raw = (body as { lastSeenEventId?: unknown }).lastSeenEventId;
      if (typeof raw === "string" || raw === null) lastSeenEventId = raw ?? null;
    }
    return { input, lastSeenEventId };
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: "Invalid request body",
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
}

/** `Message` is re-exported so a caller can name what a connect carries without importing AG-UI. */
export type EngineMessage = Message;
