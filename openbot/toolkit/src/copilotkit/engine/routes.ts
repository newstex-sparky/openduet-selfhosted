/**
 * The routes the protocol engine answers, and the HTTP methods each one takes.
 *
 * Ported from the CopilotKit runtime package, 1.77.0 (`dist/v2/runtime/core/fetch-router.mjs`, MIT), which this
 * fork used to depend on for its whole HTTP surface. The paths are the wire contract the browser
 * half of OpenDuet speaks, so they are kept exactly: an engine that answered a different path would
 * be a different protocol, not a reimplementation of this one.
 *
 * Matching is by trailing segments rather than by a router table, which is what the vendor did and
 * what lets the handler be mounted under any base path without re-registering every route.
 */

/** One route, named by what the handler does rather than by its path. */
export type Route =
  | { method: "info" }
  | { method: "inspector/metadata" }
  | { method: "inspector/learning" }
  | { method: "transcribe" }
  | { method: "cpk-debug-events" }
  | { method: "agent/run"; agentId: string }
  | { method: "agent/suggest"; agentId: string }
  | { method: "agent/connect"; agentId: string }
  | { method: "agent/stop"; agentId: string; threadId: string }
  | { method: "trajectory/connect"; trajectoryId: string }
  | { method: "threads/subscribe" }
  | { method: "threads/messages"; threadId: string }
  | { method: "threads/events"; threadId: string }
  | { method: "threads/state"; threadId: string }
  | { method: "threads/archive"; threadId: string }
  | { method: "threads/clear" }
  | { method: "threads/update"; threadId: string }
  | { method: "threads/list" }
  | { method: "memories/recall" }
  | { method: "memories/subscribe" }
  | { method: "memories/mutate"; memoryId: string }
  | { method: "memories/list" }
  | { method: "annotate" };

export function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Match a request path against the known routes.
 *
 * `basePath` is stripped first when it is given, so the engine can sit under `/api/copilotkit` while
 * the patterns below only ever describe what comes after it.
 */
export function matchRoute(pathname: string, basePath?: string): Route | null {
  let remainder: string;
  if (basePath) {
    const normalizedBase =
      basePath.length > 1 && basePath.endsWith("/")
        ? basePath.slice(0, -1)
        : basePath;
    if (normalizedBase === "/") {
      remainder = pathname;
    } else {
      if (!pathname.startsWith(normalizedBase)) return null;
      const afterBase = pathname.slice(normalizedBase.length);
      if (afterBase.length > 0 && !afterBase.startsWith("/")) return null;
      remainder = afterBase || "/";
    }
  } else {
    remainder = pathname;
  }
  return matchSegments(remainder);
}

function matchSegments(path: string): Route | null {
  const segments = path.split("/").filter(Boolean);
  const len = segments.length;

  if (len >= 1 && segments[len - 1] === "info") return { method: "info" };
  if (len >= 1 && segments[len - 1] === "inspector-metadata")
    return { method: "inspector/metadata" };
  if (len >= 1 && segments[len - 1] === "inspector-learning")
    return { method: "inspector/learning" };
  if (len >= 1 && segments[len - 1] === "transcribe")
    return { method: "transcribe" };
  if (len >= 1 && segments[len - 1] === "cpk-debug-events")
    return { method: "cpk-debug-events" };
  if (
    len >= 3 &&
    segments[len - 3] === "agent" &&
    segments[len - 1] === "run"
  ) {
    const agentId = safeDecodeURIComponent(segments[len - 2] ?? "");
    if (!agentId) return null;
    return { method: "agent/run", agentId };
  }
  if (
    len >= 3 &&
    segments[len - 3] === "agent" &&
    segments[len - 1] === "suggest"
  ) {
    const agentId = safeDecodeURIComponent(segments[len - 2] ?? "");
    if (!agentId) return null;
    return { method: "agent/suggest", agentId };
  }
  if (
    len >= 3 &&
    segments[len - 3] === "agent" &&
    segments[len - 1] === "connect"
  ) {
    const agentId = safeDecodeURIComponent(segments[len - 2] ?? "");
    if (!agentId) return null;
    return { method: "agent/connect", agentId };
  }
  if (
    len >= 3 &&
    segments[len - 3] === "trajectory" &&
    segments[len - 1] === "connect"
  ) {
    const trajectoryId = safeDecodeURIComponent(segments[len - 2] ?? "");
    if (!trajectoryId) return null;
    return { method: "trajectory/connect", trajectoryId };
  }
  if (
    len >= 4 &&
    segments[len - 4] === "agent" &&
    segments[len - 2] === "stop"
  ) {
    const agentId = safeDecodeURIComponent(segments[len - 3] ?? "");
    const threadId = safeDecodeURIComponent(segments[len - 1] ?? "");
    if (!agentId || !threadId) return null;
    return { method: "agent/stop", agentId, threadId };
  }
  if (len >= 2 && segments[len - 2] === "threads" && segments[len - 1] === "subscribe")
    return { method: "threads/subscribe" };
  if (
    len >= 3 &&
    segments[len - 3] === "threads" &&
    segments[len - 1] === "messages"
  ) {
    const threadId = safeDecodeURIComponent(segments[len - 2] ?? "");
    if (!threadId) return null;
    return { method: "threads/messages", threadId };
  }
  if (
    len >= 3 &&
    segments[len - 3] === "threads" &&
    segments[len - 1] === "events"
  ) {
    const threadId = safeDecodeURIComponent(segments[len - 2] ?? "");
    if (!threadId) return null;
    return { method: "threads/events", threadId };
  }
  if (
    len >= 3 &&
    segments[len - 3] === "threads" &&
    segments[len - 1] === "state"
  ) {
    const threadId = safeDecodeURIComponent(segments[len - 2] ?? "");
    if (!threadId) return null;
    return { method: "threads/state", threadId };
  }
  if (
    len >= 3 &&
    segments[len - 3] === "threads" &&
    segments[len - 1] === "archive"
  ) {
    const threadId = safeDecodeURIComponent(segments[len - 2] ?? "");
    if (!threadId) return null;
    return { method: "threads/archive", threadId };
  }
  if (len >= 2 && segments[len - 2] === "threads" && segments[len - 1] === "clear")
    return { method: "threads/clear" };
  if (
    len >= 2 &&
    segments[len - 2] === "threads" &&
    segments[len - 1] !== "subscribe" &&
    segments[len - 1] !== "clear"
  ) {
    const threadId = safeDecodeURIComponent(segments[len - 1] ?? "");
    if (!threadId) return null;
    return { method: "threads/update", threadId };
  }
  if (len >= 1 && segments[len - 1] === "threads")
    return { method: "threads/list" };
  if (len >= 2 && segments[len - 2] === "memories" && segments[len - 1] === "recall")
    return { method: "memories/recall" };
  if (
    len >= 2 &&
    segments[len - 2] === "memories" &&
    segments[len - 1] === "subscribe"
  )
    return { method: "memories/subscribe" };
  if (
    len >= 2 &&
    segments[len - 2] === "memories" &&
    segments[len - 1] !== "subscribe"
  ) {
    const memoryId = safeDecodeURIComponent(segments[len - 1] ?? "");
    if (!memoryId) return null;
    return { method: "memories/mutate", memoryId };
  }
  if (len >= 1 && segments[len - 1] === "memories")
    return { method: "memories/list" };
  if (len >= 1 && segments[len - 1] === "annotate") return { method: "annotate" };
  return null;
}

/** The `405` a route answers when it is asked for a method it does not take. */
export function validateHttpMethod(
  httpMethod: string,
  route: Route,
): Response | null {
  const method = httpMethod.toUpperCase();
  switch (route.method) {
    case "info":
    case "inspector/metadata":
    case "inspector/learning":
    case "threads/list":
    case "threads/messages":
    case "threads/events":
    case "threads/state":
    case "cpk-debug-events":
      if (method === "GET") return null;
      return jsonResponse({ error: "Method not allowed" }, 405, {
        Allow: "GET",
      });
    case "memories/list":
      if (method === "GET" || method === "POST") return null;
      return jsonResponse({ error: "Method not allowed" }, 405, {
        Allow: "GET, POST",
      });
    case "memories/mutate":
      if (method === "PATCH" || method === "DELETE") return null;
      return jsonResponse({ error: "Method not allowed" }, 405, {
        Allow: "PATCH, DELETE",
      });
    case "memories/recall":
      if (method === "POST") return null;
      return jsonResponse({ error: "Method not allowed" }, 405, {
        Allow: "POST",
      });
    case "threads/update":
      if (method === "PATCH" || method === "DELETE") return null;
      return jsonResponse({ error: "Method not allowed" }, 405, {
        Allow: "PATCH, DELETE",
      });
    default:
      if (method === "POST") return null;
      return jsonResponse({ error: "Method not allowed" }, 405, {
        Allow: "POST",
      });
  }
}
