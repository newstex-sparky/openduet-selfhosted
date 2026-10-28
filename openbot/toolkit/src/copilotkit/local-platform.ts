/**
 * The thread platform for LOCAL MODE: everything this deployment otherwise asks CopilotKit
 * Intelligence for, held in this process instead.
 *
 * WHAT THIS IS. Phase 1 of running OpenDuet without Intelligence (see `RuntimeCapabilities` in
 * `server/src/config.ts`, `mode: "local"`). One object answers the three questions the rest of the
 * server puts to Intelligence:
 *
 *   - the runner (`runner`): an `AgentRunner` for `new CopilotRuntime({ runner })` in SSE mode, and
 *     the same object every headless turn (`toolkit/run-turn.ts`) drives;
 *   - the thread record and its history (`getOrCreateThread`, `getThread`, `getThreadMessages`),
 *     shaped like `CopilotKitIntelligence`'s answers so the existing call sites read it unchanged;
 *   - the per-thread run lock (`ɵacquireThreadLock`, `ɵrenewThreadLock`, `ɵcleanupThreadLock`), with
 *     Intelligence's error contract: a conflict is a `PlatformRequestError` with status 409, a thread
 *     that is not there (or not yours) is one with status 404. `isLockConflict` and
 *     `historyOrEmpty` therefore behave exactly as they do against the platform.
 *
 * WHAT THIS IS NOT. Durable. Every thread, message and lock lives in this process and is gone on
 * restart; a second replica sees none of it. That is the Phase 1 contract (`docs/local-mode.md`).
 * Phase 2 replaces this module's storage with Postgres (threads, messages, events, and an advisory
 * lock or `SELECT … FOR UPDATE` thread lock) behind the same surface. Keep the surface narrow so
 * that swap stays mechanical.
 *
 * WHO OWNS A THREAD. Intelligence scopes every thread to the user `identifyUser` returns. SSE mode
 * gives the runner no user at all, so the server wraps the CopilotKit handler in
 * {@link runAsLocalUser} (see `server/src/copilot.ts`) and every runner entry point reads the person
 * from there. A thread belongs to whoever first touched it; anyone else gets the answer a missing
 * thread gets, so a thread id is not an oracle for whether somebody else's conversation exists.
 * Server-side callers (headless turns) carry no request user and are trusted, exactly as they are
 * when they hold the deployment's Intelligence key.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AbstractAgent,
  BaseEvent,
  Message,
  RunAgentInput,
} from "@ag-ui/client";
import { compactEvents, EventType } from "@ag-ui/client";
import { type Observable, ReplaySubject } from "rxjs";

/**
 * Named `PlatformRequestError` on purpose: `isLockConflict` (lease.ts) and `isMissingThread`
 * (thread-history.ts) recognise the platform's errors by name and status, and a local conflict has
 * to read as the same "not now" a platform 409 does.
 */
export class LocalPlatformRequestError extends Error {
  override name = "PlatformRequestError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

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

/** The thread summary Intelligence returns, restated: the same fields the server reads. */
export type LocalThreadSummary = {
  id: string;
  name: string | null;
  agentId: string;
  organizationId: string;
  createdById: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

/** One row of history in Intelligence's shape (`ThreadMessage`), which every reader here expects. */
export type LocalThreadMessage = {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
};

type ThreadRow = {
  id: string;
  /** Null only for a thread a server path created without naming anybody. Nobody can read it. */
  userId: string | null;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  /** The conversation as the agent held it at the end of the last run. */
  messages: Message[];
  /** Every run's events, compacted, for `connect` to replay into a page that reloads. */
  events: BaseEvent[];
};

type ActiveRun = {
  runId: string;
  agent: AbstractAgent;
  subject: ReplaySubject<BaseEvent>;
  stopRequested: boolean;
};

type Lock = { runId: string; expiresAt: number };

/** The bounds of this process's memory for threads. Generous; they exist so it is not unbounded. */
export const LOCAL_PLATFORM_DEFAULTS = {
  maxThreads: 2_000,
  defaultLockTtlSeconds: 120,
} as const;

/** AG-UI's message, in the platform's history shape: tool calls flattened, as the runtime does. */
function toPlatformMessage(message: Message): LocalThreadMessage {
  const base = { id: message.id, role: message.role };
  if (message.role === "assistant") {
    const calls = message.toolCalls ?? [];
    return {
      ...base,
      ...(message.content !== undefined ? { content: message.content } : {}),
      ...(calls.length > 0
        ? {
            toolCalls: calls.map((call) => ({
              id: call.id,
              name: call.function.name,
              args: call.function.arguments,
            })),
          }
        : {}),
    };
  }
  if (message.role === "tool")
    return {
      ...base,
      content: message.content,
      toolCallId: message.toolCallId,
    };
  return {
    ...base,
    ...("content" in message && message.content !== undefined
      ? { content: message.content }
      : {}),
  };
}

function messageIdOf(event: BaseEvent): string | undefined {
  const id = (event as { messageId?: unknown }).messageId;
  return typeof id === "string" ? id : undefined;
}

const TERMINAL = new Set<string>([EventType.RUN_FINISHED, EventType.RUN_ERROR]);

export type LocalThreadPlatform = ReturnType<typeof createLocalThreadPlatform>;

export function createLocalThreadPlatform(
  options: {
    maxThreads?: number;
    now?: () => number;
    log?: (line: string) => void;
  } = {},
) {
  const maxThreads = options.maxThreads ?? LOCAL_PLATFORM_DEFAULTS.maxThreads;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const threads = new Map<string, ThreadRow>();
  const active = new Map<string, ActiveRun>();
  const locks = new Map<string, Lock>();

  const missing = (threadId: string) =>
    new LocalPlatformRequestError(`Thread ${threadId} not found`, 404);
  const busy = (threadId: string) =>
    new LocalPlatformRequestError(`Thread ${threadId} is already running`, 409);

  /** Least-recently-touched idle threads go first; a running or locked one is never dropped. */
  function evict() {
    if (threads.size <= maxThreads) return;
    for (const id of threads.keys()) {
      if (threads.size <= maxThreads) break;
      if (active.has(id) || liveLock(id)) continue;
      threads.delete(id);
    }
  }

  function touch(row: ThreadRow) {
    row.updatedAt = now();
    threads.delete(row.id);
    threads.set(row.id, row);
  }

  function liveLock(threadId: string): Lock | undefined {
    const lock = locks.get(threadId);
    if (!lock) return undefined;
    if (lock.expiresAt <= now()) {
      locks.delete(threadId);
      return undefined;
    }
    return lock;
  }

  /** The thread if `userId` may see it. A server path (no user) sees every thread. */
  function visible(threadId: string, userId: string | undefined) {
    const row = threads.get(threadId);
    if (!row) return undefined;
    if (userId !== undefined && row.userId !== userId) return undefined;
    return row;
  }

  function ensure(
    threadId: string,
    userId: string | undefined,
    agentId: string,
  ): { row: ThreadRow; created: boolean } {
    const existing = threads.get(threadId);
    if (existing) {
      if (userId !== undefined && existing.userId !== userId)
        throw missing(threadId);
      return { row: existing, created: false };
    }
    const at = now();
    const row: ThreadRow = {
      id: threadId,
      userId: userId ?? null,
      agentId,
      createdAt: at,
      updatedAt: at,
      messages: [],
      events: [],
    };
    threads.set(threadId, row);
    evict();
    return { row, created: true };
  }

  function summary(row: ThreadRow): LocalThreadSummary {
    return {
      id: row.id,
      name: null,
      agentId: row.agentId,
      organizationId: "",
      createdById: row.userId ?? "",
      archived: false,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  /**
   * The runner. Structurally `AgentRunner` from `@copilotkit/runtime/v2` (the runtime duck-types it;
   * nothing checks `instanceof`), declared without importing the runtime so the toolkit's tests do
   * not have to load it.
   */
  const runner = {
    /** Turns on the runtime's `GET /threads` family in SSE mode; every answer is scoped below. */
    ɵsupportsLocalThreadEndpoints: true as const,

    run(request: {
      threadId: string;
      agent: AbstractAgent;
      input: RunAgentInput;
      persistedInputMessages?: Message[];
    }): Observable<BaseEvent> {
      const { threadId, agent, input } = request;
      const runId = input.runId;
      const { row } = ensure(
        threadId,
        currentLocalUser(),
        agent.agentId ?? "default",
      );
      if (active.has(threadId)) throw busy(threadId);
      const lock = liveLock(threadId);
      if (lock && lock.runId !== runId) throw busy(threadId);

      const subject = new ReplaySubject<BaseEvent>(Infinity);
      const run: ActiveRun = { runId, agent, subject, stopRequested: false };
      active.set(threadId, run);
      touch(row);

      // A user message lives only in RUN_STARTED's input, so a replay that carried every message
      // on every run would show the whole conversation again each turn. Only this run's new ones.
      const historic = new Set(row.messages.map((message) => message.id));
      const events: BaseEvent[] = [];
      const emit = (event: BaseEvent) => {
        events.push(event);
        subject.next(event);
      };

      void (async () => {
        let failure: string | undefined;
        try {
          await agent.runAgent(input, {
            onEvent: ({ event }) => {
              if (event.type === EventType.RUN_STARTED) {
                const started = event as BaseEvent & { input?: RunAgentInput };
                const source = started.input ?? input;
                emit({
                  ...started,
                  input: {
                    ...source,
                    messages: (source.messages ?? []).filter(
                      (message) => !historic.has(message.id),
                    ),
                  },
                } as BaseEvent);
                return;
              }
              emit(event);
            },
          });
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        // Every run ends in a terminal event, as the Intelligence runner's does, so a headless turn
        // settles and a browser stops showing a spinner whether the agent finished, failed or was
        // stopped.
        if (!events.some((event) => TERMINAL.has(event.type))) {
          emit(
            failure !== undefined && !run.stopRequested
              ? ({
                  type: EventType.RUN_ERROR,
                  message: failure,
                } as BaseEvent)
              : ({
                  type: EventType.RUN_FINISHED,
                  threadId,
                  runId,
                } as BaseEvent),
          );
        }
        const current = threads.get(threadId);
        if (current) {
          if (Array.isArray(agent.messages) && agent.messages.length > 0)
            current.messages = [...agent.messages];
          try {
            current.events = compactEvents([...current.events, ...events]);
          } catch (error) {
            log(
              JSON.stringify({
                type: "local-thread-compaction-failed",
                threadId,
                reason: error instanceof Error ? error.message : String(error),
              }),
            );
            current.events = [...current.events, ...events];
          }
          touch(current);
        }
        if (active.get(threadId) === run) active.delete(threadId);
        subject.complete();
      })();

      return subject.asObservable();
    },

    connect(request: {
      threadId: string;
      agentId?: string;
    }): Observable<BaseEvent> {
      const connection = new ReplaySubject<BaseEvent>(Infinity);
      const row = visible(request.threadId, currentLocalUser());
      if (!row) {
        connection.complete();
        return connection.asObservable();
      }
      const emitted = new Set<string>();
      for (const event of compactEvents(row.events)) {
        connection.next(event);
        const id = messageIdOf(event);
        if (id) emitted.add(id);
      }
      const run = active.get(request.threadId);
      if (run) {
        run.subject.subscribe({
          next: (event) => {
            const id = messageIdOf(event);
            if (id && emitted.has(id)) return;
            connection.next(event);
          },
          complete: () => connection.complete(),
          error: (error) => connection.error(error),
        });
      } else {
        connection.complete();
      }
      return connection.asObservable();
    },

    async isRunning(request: { threadId: string }): Promise<boolean> {
      return active.has(request.threadId);
    },

    async stop(request: {
      threadId: string;
      runId?: string;
    }): Promise<boolean | undefined> {
      const run = active.get(request.threadId);
      if (!run) return false;
      const user = currentLocalUser();
      if (user !== undefined && !visible(request.threadId, user)) return false;
      if (request.runId !== undefined && request.runId !== run.runId)
        return false;
      if (run.stopRequested) return false;
      run.stopRequested = true;
      try {
        run.agent.abortRun();
        return true;
      } catch {
        run.stopRequested = false;
        return false;
      }
    },

    /* The runtime's local thread endpoints. Scoped to the request's person; none without one. */
    listThreads(): LocalThreadSummary[] {
      const user = currentLocalUser();
      if (user === undefined) return [];
      return [...threads.values()]
        .filter((row) => row.userId === user && row.events.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(summary);
    },
    getThreadMessages(threadId: string): Message[] {
      const user = currentLocalUser();
      if (user === undefined) return [];
      return [...(visible(threadId, user)?.messages ?? [])];
    },
    getThreadEvents(threadId: string): BaseEvent[] {
      const user = currentLocalUser();
      if (user === undefined) return [];
      const row = visible(threadId, user);
      return row ? compactEvents(row.events) : [];
    },
    getThreadState(threadId: string): Record<string, unknown> | null {
      const events = runner.getThreadEvents(threadId);
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index] as BaseEvent & { snapshot?: unknown };
        if (event.type !== EventType.STATE_SNAPSHOT) continue;
        const snapshot = event.snapshot;
        return snapshot &&
          typeof snapshot === "object" &&
          !Array.isArray(snapshot)
          ? { ...(snapshot as Record<string, unknown>) }
          : null;
      }
      return null;
    },
    /** `POST /threads/clear`: the caller's own idle threads, never anybody else's. */
    clearThreads(): void {
      const user = currentLocalUser();
      if (user === undefined) return;
      for (const [id, row] of threads) {
        if (row.userId !== user || active.has(id) || liveLock(id)) continue;
        threads.delete(id);
      }
    },
  };

  return {
    mode: "local" as const,
    runner,

    async getOrCreateThread(params: {
      threadId: string;
      userId: string;
      agentId: string;
      learningContainerId?: string;
    }): Promise<{ thread: LocalThreadSummary; created: boolean }> {
      const { row, created } = ensure(
        params.threadId,
        params.userId,
        params.agentId,
      );
      return { thread: summary(row), created };
    },

    async getThread(params: {
      threadId: string;
      userId: string;
    }): Promise<LocalThreadSummary> {
      const row = visible(params.threadId, params.userId);
      if (!row) throw missing(params.threadId);
      return summary(row);
    },

    async getThreadMessages(params: {
      threadId: string;
      userId: string;
    }): Promise<{ messages: LocalThreadMessage[] }> {
      const row = visible(params.threadId, params.userId);
      if (!row) throw missing(params.threadId);
      return { messages: row.messages.map(toPlatformMessage) };
    },

    async ɵacquireThreadLock(params: {
      threadId: string;
      runId: string;
      userId: string;
      agentId: string;
      ttlSeconds?: number;
      learningContainerId?: string;
    }): Promise<{ threadId: string; runId: string; joinToken: string }> {
      ensure(params.threadId, params.userId, params.agentId);
      const run = active.get(params.threadId);
      if (run && run.runId !== params.runId) throw busy(params.threadId);
      const held = liveLock(params.threadId);
      if (held && held.runId !== params.runId) throw busy(params.threadId);
      const ttl =
        params.ttlSeconds ?? LOCAL_PLATFORM_DEFAULTS.defaultLockTtlSeconds;
      locks.set(params.threadId, {
        runId: params.runId,
        expiresAt: now() + ttl * 1000,
      });
      // No join token: nobody joins a local run over a socket. Empty, as the type requires a string.
      return { threadId: params.threadId, runId: params.runId, joinToken: "" };
    },

    async ɵrenewThreadLock(params: {
      threadId: string;
      runId: string;
      ttlSeconds: number;
    }): Promise<{ threadId: string; runId: string }> {
      const held = liveLock(params.threadId);
      if (!held || held.runId !== params.runId) throw busy(params.threadId);
      held.expiresAt = now() + params.ttlSeconds * 1000;
      return { threadId: params.threadId, runId: params.runId };
    },

    async ɵcleanupThreadLock(params: {
      threadId: string;
      runId: string;
    }): Promise<void> {
      if (locks.get(params.threadId)?.runId === params.runId)
        locks.delete(params.threadId);
    },

    /** For diagnostics and tests: how much this process is holding. */
    stats() {
      return { threads: threads.size, running: active.size, locks: locks.size };
    },
  };
}
