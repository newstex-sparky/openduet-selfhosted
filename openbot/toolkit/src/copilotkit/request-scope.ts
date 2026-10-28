/**
 * Who a request is running as, for a runner that is not handed a user.
 *
 * Intelligence scopes every thread to the person `identifyUser` returns, and the runtime calls that
 * itself. The runtime's SSE mode does not call it at all: it gives the runner a thread id and no
 * user, so the server wraps the whole CopilotKit handler in {@link runAsLocalUser} and every runner
 * entry point reads the person from here.
 *
 * THE STORAGE DOES NOT MATTER, which is why this is its own module: the in-memory platform and the
 * Postgres one must see the same person for the same request, or a request that wrote a thread
 * through one and read it through the other would be looking at somebody else's conversation.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The person a request is running as. Set by the server around the CopilotKit handler. */
const requestScope = new AsyncLocalStorage<{ userId: string }>();

/** Run `fn` as `userId`, so the runner can scope what it reads and writes to that person. */
export function runAsLocalUser<T>(userId: string, fn: () => T): T {
  return requestScope.run({ userId }, fn);
}

/** The person the current request runs as, or undefined on a server-side (trusted) path. */
export function currentLocalUser(): string | undefined {
  return requestScope.getStore()?.userId;
}
