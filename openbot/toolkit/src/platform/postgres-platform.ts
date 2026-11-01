/**
 * The thread platform for LOCAL MODE, on Postgres: durable threads, messages, an event log and the
 * per-thread run lock.
 *
 * WHY. Phase 1 ran local mode on process memory (`./local-platform.ts`), which meant a restart
 * forgot every conversation and a second replica saw none of the first one's. A deployment without
 * CopilotKit Intelligence still needs what Intelligence was holding: somewhere for a conversation to
 * live, something for a reloaded page to replay, and one run at a time per conversation. This module
 * is that, on the Postgres the deployment already has.
 *
 * THE SAME SURFACE, DELIBERATELY. `getOrCreateThread` / `getThread` / `getThreadMessages`,
 * `acquireThreadLock` / `renewThreadLock` / `cleanupThreadLock`, and a runner with
 * `run` / `connect` / `isRunning` / `stop` plus the runtime's local thread endpoints. Every caller —
 * the turn code, the thread lock, the history readers, the runtime — is written against those names
 * and does not learn where the rows are.
 *
 * TWO THINGS THE RUNTIME FORCES, and they shape the design:
 *
 *   1. `listThreads`, `getThreadMessages`, `getThreadEvents` and `getThreadState` are declared
 *      SYNCHRONOUS by `LocalThreadEndpointRunner`, and the runtime calls `.map`/`JSON.stringify` on
 *      what they return. A promise would be stringified as `{}`. So those four read a per-process
 *      MIRROR that `prime(threadId)` and `refresh()` load from Postgres — awaited by the local-mode
 *      gate in `server/src/copilot.ts` before it hands a `/threads…` request to the runtime. The
 *      mirror is a read cache with an explicit loader, never the source of truth: every write goes
 *      to Postgres first.
 *   2. `run` and `connect` return observables, which is where the async work happens. Nothing is
 *      buffered in memory for replay: `connect` reads the event log, tails it, and completes when
 *      the run it was watching ends. That is what makes a reconnect after a restart return the
 *      conversation rather than a blank screen.
 *
 * THE CLOCK IS POSTGRES'S. Every lease comparison happens in SQL — `now()` on the server — for the
 * reason `server/src/work/queue.ts` spells out at length: two clocks pretending to be one lets a
 * replica whose clock runs slow take a lock another replica still believes it holds. Nothing here
 * compares a timestamp it read against a clock it owns.
 */
import type {
  AbstractAgent,
  BaseEvent,
  Message,
  RunAgentInput,
} from "@ag-ui/client";
import { compactEvents, EventType } from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  missingThread,
  PlatformRequestError,
  threadBusy,
} from "./platform-errors";
import { currentLocalUser } from "./request-scope";
import { THREAD_LOCK_TTL_SECONDS } from "./thread-lock";
import {
  type LocalThreadMessage,
  type LocalThreadSummary,
  toAgentMessage,
  toPlatformMessage,
} from "./thread-records";

/**
 * The one thing this module needs from a database: a tagged template that runs SQL and answers rows.
 *
 * Structural rather than a driver type, so the toolkit keeps no database dependency at all — the
 * server hands in its `postgres` client and its tests hand in whatever they have. `postgres`'s own
 * `sql` satisfies this shape, and so does a test double.
 */
export type PlatformSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<readonly unknown[]>;

/** Await a query and name what it returned. The driver's rows are only checked for being rows. */
async function read<Row>(
  query: PromiseLike<readonly unknown[]>,
): Promise<Row[]> {
  return (await query) as Row[];
}

/** One thread row, as Postgres hands it back (snake_case, `Date` for timestamps). */
type ThreadRow = {
  id: string;
  user_id: string | null;
  agent_id: string;
  name: string | null;
  organization_id: string;
  archived: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

/** The same row plus whether it has anything in its log, for the thread list. */
type ListedThreadRow = ThreadRow & { has_events: boolean };

type MessageRow = {
  seq: number | string;
  message_id: string;
  role: string;
  content: unknown;
  tool_calls: { id: string; name: string; args: string }[] | null;
  tool_call_id: string | null;
};

type EventRow = { seq: number | string; event: unknown };

/** What a run in this process holds, so `stop` can abort it and the heartbeat can notice. */
type ActiveRun = {
  threadId: string;
  runId: string;
  agent: AbstractAgent;
  stopRequested: boolean;
  lockLost: boolean;
};

/** One thread in the read mirror: metadata always, payload once `prime` has loaded it. */
type Mirrored = {
  summary: LocalThreadSummary;
  hasEvents: boolean;
  /** Undefined until `prime`; the sync readers answer `[]` for a thread nobody loaded. */
  messages?: Message[];
  events?: BaseEvent[];
};

/** What the store holds for one thread beyond its metadata. */
export type PostgresThreadPlatformOptions = {
  sql: PlatformSql;
  /**
   * How long a run's lock lasts without renewal, in seconds.
   *
   * The same 120 the platform uses (`THREAD_LOCK_TTL_SECONDS`), because the turn code renews on its
   * own heartbeat and this only decides how long a conversation stays stuck after a process dies
   * mid-run.
   */
  lockTtlSeconds?: number;
  /**
   * How long an acquire waits for somebody else's run before it refuses.
   *
   * ZERO, and that is the platform's own semantics: a conversation somebody is already running in
   * answers "not now" and the caller comes back rather than queueing behind an unknown number of
   * turns. `server/src/run-turn.ts` and the browser both rely on that. A test that wants to prove
   * two requests SERIALIZE (rather than that the second is refused) sets this, and then the second
   * request starts exactly when the first releases.
   */
  lockWaitMs?: number;
  /** How often `connect` looks for new events, in milliseconds. */
  eventPollMs?: number;
  /** How often a running turn renews its lock, in milliseconds. Defaults to a third of the TTL. */
  heartbeatMs?: number;
  /** How long events may sit unsent before they are written. */
  eventFlushMs?: number;
  /** The most threads `refresh` loads metadata for, newest first. */
  listedThreads?: number;
  log?: (line: string) => void;
};

export const POSTGRES_PLATFORM_DEFAULTS = {
  lockTtlSeconds: THREAD_LOCK_TTL_SECONDS,
  lockWaitMs: 0,
  eventPollMs: 400,
  eventFlushMs: 200,
  listedThreads: 200,
} as const;

const TERMINAL = new Set<string>([EventType.RUN_FINISHED, EventType.RUN_ERROR]);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/** `Date` or string in, ISO string out: the platform's own timestamp shape. */
const iso = (value: Date | string) => new Date(value).toISOString();

function summaryOf(row: ThreadRow): LocalThreadSummary {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    organizationId: row.organization_id,
    createdById: row.user_id ?? "",
    archived: row.archived,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function messageOf(row: MessageRow): Message {
  return toAgentMessage({
    id: row.message_id,
    role: row.role,
    ...(row.content !== null && row.content !== undefined
      ? { content: row.content }
      : {}),
    ...(row.tool_calls ? { toolCalls: row.tool_calls } : {}),
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
  });
}

export type PostgresThreadPlatform = ReturnType<
  typeof createPostgresThreadPlatform
>;

export function createPostgresThreadPlatform(
  options: PostgresThreadPlatformOptions,
) {
  const { sql } = options;
  const lockTtlSeconds =
    options.lockTtlSeconds ?? POSTGRES_PLATFORM_DEFAULTS.lockTtlSeconds;
  const lockWaitMs =
    options.lockWaitMs ?? POSTGRES_PLATFORM_DEFAULTS.lockWaitMs;
  const eventPollMs =
    options.eventPollMs ?? POSTGRES_PLATFORM_DEFAULTS.eventPollMs;
  const eventFlushMs =
    options.eventFlushMs ?? POSTGRES_PLATFORM_DEFAULTS.eventFlushMs;
  const listedThreads =
    options.listedThreads ?? POSTGRES_PLATFORM_DEFAULTS.listedThreads;
  const heartbeatMs =
    options.heartbeatMs ?? Math.max(1_000, (lockTtlSeconds * 1000) / 3);
  const log = options.log ?? ((line: string) => console.warn(line));

  /** Runs this process is driving, so `stop` and the heartbeat have something to act on. */
  const active = new Map<string, ActiveRun>();
  /** The read mirror the runtime's synchronous endpoints answer from. See the header. */
  const mirror = new Map<string, Mirrored>();

  /* ---------------------------------------------------------------------------------------------
   * Threads
   * ------------------------------------------------------------------------------------------- */

  /**
   * Create the thread, or hand back the one that is there.
   *
   * ONE STATEMENT IN THE ORDINARY CASE. The `where` on the conflict path is what makes a thread id
   * safe to guess: a row that exists and belongs to somebody else is not updated (and so not
   * returned), and the caller gets the same 404 a missing thread gets. Nothing here distinguishes
   * "not yours" from "not there", on purpose.
   */
  async function ensureThread(
    threadId: string,
    userId: string | undefined,
    agentId: string,
  ): Promise<LocalThreadSummary> {
    const rows = await read<ThreadRow>(sql`
      insert into copilotkit_threads (id, user_id, agent_id, organization_id, name, archived)
      values (${threadId}, ${userId ?? null}, ${agentId}, '', null, false)
      on conflict (id) do update set updated_at = now()
        where copilotkit_threads.user_id is not distinct from excluded.user_id
      returning id, user_id, agent_id, name, organization_id, archived, created_at, updated_at
    `);
    const row = rows[0];
    if (!row) throw missingThread(threadId);
    return summaryOf(row);
  }

  /**
   * The thread if this person may see it.
   *
   * A server-side caller (no request user) sees every thread, exactly as it does when it holds the
   * deployment's Intelligence key: a routine reading its own conversation carries no request.
   */
  async function readThread(
    threadId: string,
    userId: string | undefined,
  ): Promise<LocalThreadSummary | undefined> {
    const rows =
      userId === undefined
        ? await read<ThreadRow>(sql`
            select id, user_id, agent_id, name, organization_id, archived, created_at, updated_at
            from copilotkit_threads where id = ${threadId}
          `)
        : await read<ThreadRow>(sql`
            select id, user_id, agent_id, name, organization_id, archived, created_at, updated_at
            from copilotkit_threads where id = ${threadId} and user_id = ${userId}
          `);
    const row = rows[0];
    return row ? summaryOf(row) : undefined;
  }

  /** Every thread this person owns, newest first, and whether it has anything to show. */
  async function listOwned(userId: string): Promise<ListedThreadRow[]> {
    return read<ListedThreadRow>(sql`
      select t.id, t.user_id, t.agent_id, t.name, t.organization_id, t.archived,
             t.created_at, t.updated_at,
             exists (select 1 from copilotkit_thread_events e where e.thread_id = t.id) as has_events
      from copilotkit_threads t
      where t.user_id = ${userId}
      order by t.updated_at desc
      limit ${listedThreads}
    `);
  }

  async function threadMessages(threadId: string): Promise<Message[]> {
    const rows = await read<MessageRow>(sql`
      select seq, message_id, role, content, tool_calls, tool_call_id
      from copilotkit_thread_messages
      where thread_id = ${threadId}
      order by seq
    `);
    return rows.map(messageOf);
  }

  async function threadEvents(
    threadId: string,
    after: number,
  ): Promise<{ seq: number; event: BaseEvent }[]> {
    const rows = await read<EventRow>(sql`
      select seq, event from copilotkit_thread_events
      where thread_id = ${threadId} and seq > ${after}
      order by seq
    `);
    return rows.map((row) => ({
      seq: Number(row.seq),
      event: row.event as BaseEvent,
    }));
  }

  function compact(events: BaseEvent[]): BaseEvent[] {
    try {
      return compactEvents(events);
    } catch (error) {
      // A log the compactor cannot read is still a log. Losing it would lose the conversation.
      log(
        JSON.stringify({
          type: "local-thread-compaction-failed",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      return events;
    }
  }

  /* ---------------------------------------------------------------------------------------------
   * Messages and events
   * ------------------------------------------------------------------------------------------- */

  /**
   * Write the conversation as the agent held it.
   *
   * AN UPSERT ON `(thread_id, message_id)`, because a reloaded page resends the whole conversation
   * and a retried turn resends a question that is already stored. Inserting them again would double
   * every message the person has already seen.
   *
   * The payload travels as ONE jsonb parameter and is expanded in SQL (`jsonb_array_elements`), so a
   * turn with fifty messages is one round trip rather than fifty, without needing driver-specific
   * bulk-insert helpers the toolkit would then have to depend on.
   *
   * `::text::jsonb`, not `::jsonb`: postgres.js infers a bare `::jsonb` parameter as jsonb and
   * JSON-encodes the already-encoded string again, so Postgres receives a jsonb STRING scalar and
   * `jsonb_array_elements` fails with "cannot extract elements from a scalar". Typing the
   * parameter as text sends the JSON as written and lets Postgres parse it.
   */
  async function writeMessages(
    threadId: string,
    messages: Message[],
  ): Promise<void> {
    if (messages.length === 0) return;
    const payload = JSON.stringify(
      messages.map((message) => {
        const platform = toPlatformMessage(message);
        return {
          messageId: platform.id,
          role: platform.role,
          content: platform.content ?? null,
          toolCalls: platform.toolCalls ?? null,
          toolCallId: platform.toolCallId ?? null,
        };
      }),
    );
    await sql`
      insert into copilotkit_thread_messages (thread_id, message_id, role, content, tool_calls, tool_call_id)
      select ${threadId}, m->>'messageId', m->>'role', m->'content', m->'toolCalls', m->>'toolCallId'
      from jsonb_array_elements(${payload}::text::jsonb) as m
      on conflict (thread_id, message_id) do update
        set role = excluded.role,
            content = excluded.content,
            tool_calls = excluded.tool_calls,
            tool_call_id = excluded.tool_call_id
    `;
    await sql`update copilotkit_threads set updated_at = now() where id = ${threadId}`;
    const cached = mirror.get(threadId);
    if (cached) cached.messages = [...messages];
  }

  /** Append events to the log. One statement however many events arrived. */
  async function writeEvents(
    threadId: string,
    runId: string,
    events: BaseEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    const payload = JSON.stringify(events);
    await sql`
      insert into copilotkit_thread_events (thread_id, run_id, event)
      select ${threadId}, ${runId}, value
      from jsonb_array_elements(${payload}::text::jsonb) as value
    `;
  }

  /* ---------------------------------------------------------------------------------------------
   * The run lock
   * ------------------------------------------------------------------------------------------- */

  /**
   * Take the conversation's run lock, or refuse.
   *
   * ONE STATEMENT, so two replicas racing here cannot both win: the insert collides on the primary
   * key, and the `where` on the conflict path decides whether the existing row is still held. An
   * expired row is taken over by whoever looks first — the lease's whole recovery story, with no
   * process having to notice that the previous holder died.
   *
   * A run re-acquiring a lock it already holds is allowed: a headless turn takes the lock through
   * the platform's lock API and then calls `run`, and that second acquisition is the same run
   * saying the same thing.
   */
  async function acquireLock(
    threadId: string,
    runId: string,
    userId: string | undefined,
  ): Promise<boolean> {
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      const rows = await read<{ run_id: string }>(sql`
        insert into copilotkit_thread_locks (thread_id, run_id, user_id, expires_at)
        values (${threadId}, ${runId}, ${userId ?? null},
                now() + (${lockTtlSeconds}::text || ' seconds')::interval)
        on conflict (thread_id) do update
          set run_id = excluded.run_id,
              user_id = excluded.user_id,
              acquired_at = now(),
              expires_at = excluded.expires_at
          where copilotkit_thread_locks.expires_at <= now()
             or copilotkit_thread_locks.run_id = excluded.run_id
        returning run_id
      `);
      if (rows.length > 0) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }

  /** Keep it while the turn works. False when somebody else has it: the lock was lost. */
  async function renewLock(threadId: string, runId: string): Promise<boolean> {
    const rows = await read<{ thread_id: string }>(sql`
      update copilotkit_thread_locks
        set expires_at = now() + (${lockTtlSeconds}::text || ' seconds')::interval
        where thread_id = ${threadId} and run_id = ${runId} and expires_at > now()
      returning thread_id
    `);
    return rows.length > 0;
  }

  async function releaseLock(threadId: string, runId: string): Promise<void> {
    await sql`
      delete from copilotkit_thread_locks
      where thread_id = ${threadId} and run_id = ${runId}
    `;
  }

  /** Whether anything is running in this conversation, from any replica. */
  async function lockIsLive(threadId: string): Promise<boolean> {
    const rows = await read<{ thread_id: string }>(sql`
      select thread_id from copilotkit_thread_locks
      where thread_id = ${threadId} and expires_at > now()
    `);
    return rows.length > 0;
  }

  /* ---------------------------------------------------------------------------------------------
   * The run record (what a conversation's last run did, and a stop that crossed a replica)
   * ------------------------------------------------------------------------------------------- */

  /**
   * Keyed by (thread_id, run_id), as the table is: the run id is the client's, so it names a run
   * only within its thread. The same id again on the same thread is that run retried and restarts
   * its row; on another thread it is another run with a row of its own. Every read and write of a
   * run below names its thread for the same reason.
   */
  async function startRun(
    runId: string,
    threadId: string,
    userId: string | undefined,
    agentId: string,
  ): Promise<void> {
    await sql`
      insert into copilotkit_thread_runs (run_id, thread_id, user_id, agent_id, status)
      values (${runId}, ${threadId}, ${userId ?? null}, ${agentId}, 'running')
      on conflict (thread_id, run_id) do update
        set status = 'running', stop_requested = false, finished_at = null, error = null
    `;
  }

  async function finishRun(
    threadId: string,
    runId: string,
    status: "finished" | "error" | "stopped",
    error?: string,
  ): Promise<void> {
    await sql`
      update copilotkit_thread_runs
        set status = ${status}, finished_at = now(), error = ${error ?? null}
        where thread_id = ${threadId} and run_id = ${runId}
    `;
  }

  async function stopRequestedFor(
    threadId: string,
    runId: string,
  ): Promise<boolean> {
    const rows = await read<{ stop_requested: boolean }>(sql`
      select stop_requested from copilotkit_thread_runs
        where thread_id = ${threadId} and run_id = ${runId}
    `);
    return rows[0]?.stop_requested === true;
  }

  /** Ask a run to stop, wherever it is running. Answers whether there was one to ask. */
  async function requestStop(
    threadId: string,
    runId: string,
  ): Promise<boolean> {
    const rows = await read<{ run_id: string }>(sql`
      update copilotkit_thread_runs set stop_requested = true
        where thread_id = ${threadId} and run_id = ${runId} and status = 'running'
      returning run_id
    `);
    return rows.length > 0;
  }

  /* ---------------------------------------------------------------------------------------------
   * The read mirror
   * ------------------------------------------------------------------------------------------- */

  function remember(summary: LocalThreadSummary, hasEvents: boolean) {
    const cached = mirror.get(summary.id) ?? { summary, hasEvents };
    cached.summary = summary;
    cached.hasEvents = hasEvents;
    mirror.set(summary.id, cached);
  }

  /**
   * Load one thread's metadata and payload.
   *
   * Called by the local-mode gate for every `/threads…` request, and by nothing else: it is what
   * makes the runtime's synchronous readers correct after a restart, when this process has never
   * seen the conversation it is being asked about.
   */
  async function prime(threadId: string): Promise<void> {
    const user = currentLocalUser();
    const summary = await readThread(threadId, user);
    if (!summary) {
      mirror.delete(threadId);
      return;
    }
    const [messages, events] = await Promise.all([
      threadMessages(threadId),
      threadEvents(threadId, 0),
    ]);
    mirror.set(threadId, {
      summary,
      hasEvents: events.length > 0,
      messages,
      events: compact(events.map((row) => row.event)),
    });
  }

  /** Load the metadata of every thread the current person owns, for the thread list. */
  async function refresh(): Promise<void> {
    const user = currentLocalUser();
    if (user === undefined) return;
    const rows = await listOwned(user);
    const present = new Set<string>();
    for (const row of rows) {
      present.add(row.id);
      remember(summaryOf(row), row.has_events);
    }
    for (const [id, cached] of mirror) {
      if (cached.summary.createdById === user && !present.has(id))
        mirror.delete(id);
    }
  }

  /* ---------------------------------------------------------------------------------------------
   * The runner
   * ------------------------------------------------------------------------------------------- */

  const runner = {
    /**
     * Inert since the engine became first-party; see the same flag in `./local-platform.ts`. Every
     * answer from this runner is scoped below.
     */
    supportsLocalThreadEndpoints: true as const,

    run(request: {
      threadId: string;
      agent: AbstractAgent;
      input: RunAgentInput;
      persistedInputMessages?: Message[];
    }): Observable<BaseEvent> {
      const { threadId, agent, input } = request;
      const runId = input.runId;
      const agentId = agent.agentId ?? "default";
      const userId = currentLocalUser();

      return new Observable<BaseEvent>((subscriber) => {
        let closed = false;
        let flushTimer: ReturnType<typeof setInterval> | undefined;
        let beatTimer: ReturnType<typeof setInterval> | undefined;
        let pending: BaseEvent[] = [];
        let writing: Promise<unknown> = Promise.resolve();
        let run: ActiveRun | undefined;

        const emit = (event: BaseEvent) => {
          if (!closed && !subscriber.closed) subscriber.next(event);
        };
        const stopTimers = () => {
          if (flushTimer) clearInterval(flushTimer);
          if (beatTimer) clearInterval(beatTimer);
          flushTimer = undefined;
          beatTimer = undefined;
        };
        /** Write whatever is buffered, in order, without ever letting two writes race. */
        const flush = (): Promise<unknown> => {
          if (pending.length === 0) return writing;
          if (run?.lockLost) {
            /* The conversation has moved to the run that took the lock: these events are a
             * stranger's tail, and writing them would interleave two runs in one log. */
            pending = [];
            return writing;
          }
          const batch = pending;
          pending = [];
          writing = writing
            .then(() => writeEvents(threadId, runId, batch))
            .catch((error) => {
              log(
                JSON.stringify({
                  type: "local-thread-event-write-failed",
                  threadId,
                  runId,
                  reason:
                    error instanceof Error ? error.message : String(error),
                }),
              );
            });
          return writing;
        };

        const work = async (): Promise<void> => {
          try {
            await ensureThread(threadId, userId, agentId);
          } catch (error) {
            /* Not the caller's thread, or a database that refused. Either way: no run. */
            if (!closed) subscriber.error(error);
            return;
          }
          const taken = await acquireLock(threadId, runId, userId);
          if (!taken) {
            if (!closed) subscriber.error(threadBusy(threadId));
            return;
          }

          run = {
            threadId,
            runId,
            agent,
            stopRequested: false,
            lockLost: false,
          };
          active.set(threadId, run);
          await startRun(runId, threadId, userId, agentId);

          /* The conversation as it stood before this run, so RUN_STARTED carries only what is new:
           * a user message lives in RUN_STARTED's input, and replaying every message each turn is
           * what makes a reloaded page show the whole conversation again. */
          const historic = new Set(
            (await threadMessages(threadId)).map((message) => message.id),
          );

          beatTimer = setInterval(() => {
            void (async () => {
              const current = run;
              if (!current || current.stopRequested) return;
              try {
                if (!(await renewLock(threadId, runId))) {
                  /* Somebody else holds this conversation now, so this run is writing into a
                   * conversation it does not own. Stop rather than interleave. */
                  current.lockLost = true;
                  current.stopRequested = true;
                  try {
                    agent.abortRun();
                  } catch {}
                  return;
                }
                if (await stopRequestedFor(threadId, runId)) {
                  current.stopRequested = true;
                  try {
                    agent.abortRun();
                  } catch {}
                }
              } catch (error) {
                log(
                  JSON.stringify({
                    type: "local-thread-lock-heartbeat-failed",
                    threadId,
                    runId,
                    reason:
                      error instanceof Error ? error.message : String(error),
                  }),
                );
              }
            })();
          }, heartbeatMs);
          beatTimer.unref?.();

          flushTimer = setInterval(() => {
            void flush();
          }, eventFlushMs);
          flushTimer.unref?.();

          const events: BaseEvent[] = [];
          const record = (event: BaseEvent) => {
            events.push(event);
            pending.push(event);
            emit(event);
            if (pending.length >= 25) void flush();
          };

          let failure: string | undefined;
          try {
            await agent.runAgent(input, {
              onEvent: ({ event }) => {
                if (event.type === EventType.RUN_STARTED) {
                  const started = event as BaseEvent & {
                    input?: RunAgentInput;
                  };
                  const source = started.input ?? input;
                  record({
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
                record(event);
              },
            });
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
          }

          /* Every run ends in a terminal event, as the Intelligence runner's does, so a headless
           * turn settles and a browser stops showing a spinner whether the agent finished, failed or
           * was stopped. A run the lock abandoned ends in RUN_ERROR: it was cut short, and a
           * finished tail would claim a conversation it did not hold to the end. */
          if (!events.some((event) => TERMINAL.has(event.type))) {
            record(
              failure !== undefined && !run.stopRequested
                ? ({
                    type: EventType.RUN_ERROR,
                    message: failure,
                  } as BaseEvent)
                : run.lockLost
                  ? ({
                      type: EventType.RUN_ERROR,
                      message: "the thread lock was lost",
                    } as BaseEvent)
                  : ({
                      type: EventType.RUN_FINISHED,
                      threadId,
                      runId,
                    } as BaseEvent),
            );
          }

          stopTimers();
          await flush();

          /* The conversation as the agent held it. Written after the events so a reader that sees
           * the log's last event also sees the messages that produced it — and NOT AT ALL when the
           * lock was lost: this run's part of the conversation is not owned, and upserting what it
           * had would put its half of a chat into the run that owns the thread now. */
          if (!run.lockLost) {
            try {
              if (Array.isArray(agent.messages) && agent.messages.length > 0)
                await writeMessages(threadId, agent.messages);
            } catch (error) {
              log(
                JSON.stringify({
                  type: "local-thread-message-write-failed",
                  threadId,
                  runId,
                  reason:
                    error instanceof Error ? error.message : String(error),
                }),
              );
            }
          }

          await finishRun(
            threadId,
            runId,
            run.lockLost
              ? "error"
              : run.stopRequested
                ? "stopped"
                : failure !== undefined
                  ? "error"
                  : "finished",
            run.lockLost ? "the thread lock was lost" : failure,
          );
          await releaseLock(threadId, runId);
          if (active.get(threadId) === run) active.delete(threadId);
          if (!run.lockLost) {
            const cached = mirror.get(threadId);
            if (cached) {
              cached.hasEvents = true;
              cached.messages = [...(agent.messages ?? [])];
              cached.events = compact([...(cached.events ?? []), ...events]);
            }
          }
          if (!closed) subscriber.complete();
        };

        void work().catch(async (error) => {
          stopTimers();
          if (active.get(threadId) === run) active.delete(threadId);
          /* Free the conversation this run took, even on the path that never reached its own
           * cleanup: a run that dies between acquiring the lock and releasing it would otherwise
           * leave the thread stuck for the whole TTL. A delete for a run id that never took the
           * lock removes nothing. */
          await releaseLock(threadId, runId).catch(() => {});
          if (!closed) subscriber.error(error);
        });

        return () => {
          closed = true;
          stopTimers();
        };
      });
    },

    /**
     * Replay a conversation and keep streaming it.
     *
     * READS THE LOG, NOT MEMORY. The first pass is every event the thread has ever emitted; the
     * polls after it pick up whatever arrives, from this process or from a replica. It completes
     * when there is nothing more to come: no live lock and no new rows in one interval. A
     * reconnect after a restart therefore answers with the whole conversation, which is the point.
     */
    connect(request: {
      threadId: string;
      agentId?: string;
    }): Observable<BaseEvent> {
      const { threadId } = request;
      const userId = currentLocalUser();
      return new Observable<BaseEvent>((subscriber) => {
        let stopped = false;
        let after = 0;
        /** One poll at a time, so a slow poll's rows are not emitted twice by the next tick. */
        let pumping = false;
        let timer: ReturnType<typeof setInterval> | undefined;

        const finish = () => {
          if (timer) clearInterval(timer);
          timer = undefined;
          if (!stopped) subscriber.complete();
        };

        const pump = async (): Promise<void> => {
          if (stopped || pumping) return;
          pumping = true;
          try {
            const rows = await threadEvents(threadId, after);
            for (const row of rows) {
              after = Math.max(after, row.seq);
              if (stopped || subscriber.closed) return;
              /* Every chunk goes out, chunk events included: a message streamed in pieces is
               * several rows with ONE message id, and dropping the rest of them by id would
               * replay the message truncated. Order comes from `seq`, and `after` makes a row
               * unrepeatable, so a reader that has a row will not be given it again. */
              subscriber.next(row.event);
            }
            const live = await lockIsLive(threadId);
            if (!live && rows.length === 0) finish();
          } finally {
            pumping = false;
          }
        };

        void (async () => {
          const summary = await readThread(threadId, userId);
          if (!summary) {
            finish();
            return;
          }
          try {
            await pump();
          } catch (error) {
            if (!stopped) subscriber.error(error);
            return;
          }
          if (stopped || subscriber.closed) return;
          timer = setInterval(() => {
            void pump().catch((error) => {
              if (!stopped) subscriber.error(error);
            });
          }, eventPollMs);
          timer.unref?.();
        })();

        return () => {
          stopped = true;
          if (timer) clearInterval(timer);
        };
      });
    },

    async isRunning(request: { threadId: string }): Promise<boolean> {
      return lockIsLive(request.threadId);
    },

    async stop(request: {
      threadId: string;
      runId?: string;
    }): Promise<boolean | undefined> {
      const { threadId, runId } = request;
      const user = currentLocalUser();
      if (user !== undefined && !(await readThread(threadId, user)))
        return false;

      const run = active.get(threadId);
      if (run) {
        if (runId !== undefined && runId !== run.runId) return false;
        if (run.stopRequested) return false;
        run.stopRequested = true;
        /* Written down, so a run being driven by another replica is stopped too rather than only
         * the one this process happens to hold. */
        await requestStop(threadId, run.runId).catch(() => false);
        try {
          run.agent.abortRun();
          return true;
        } catch {
          run.stopRequested = false;
          return false;
        }
      }
      /* Nothing here: the run may be another replica's. Ask it through the run record. */
      if (runId === undefined) return false;
      return requestStop(threadId, runId);
    },

    /* The runtime's local thread endpoints, answered from the mirror `prime`/`refresh` load. */
    listThreads(): LocalThreadSummary[] {
      const user = currentLocalUser();
      if (user === undefined) return [];
      return [...mirror.values()]
        .filter(
          (entry) => entry.summary.createdById === user && entry.hasEvents,
        )
        .sort((a, b) => b.summary.updatedAt.localeCompare(a.summary.updatedAt))
        .map((entry) => entry.summary);
    },
    getThreadMessages(threadId: string): Message[] {
      const user = currentLocalUser();
      if (user === undefined) return [];
      return [...(mirror.get(threadId)?.messages ?? [])];
    },
    getThreadEvents(threadId: string): BaseEvent[] {
      const user = currentLocalUser();
      if (user === undefined) return [];
      return [...(mirror.get(threadId)?.events ?? [])];
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
    /**
     * `POST /threads/clear`: the caller's own idle threads.
     *
     * ASYNCHRONOUS DELETE, SYNCHRONOUS ANSWER. The runtime declares this method as void, so the
     * delete is started here and the mirror is cleared at once; a thread another replica is running
     * is left alone by the `not exists` on both the lock and the run record.
     */
    clearThreads(): void {
      const user = currentLocalUser();
      if (user === undefined) return;
      for (const [id, entry] of mirror) {
        if (entry.summary.createdById === user) mirror.delete(id);
      }
      void Promise.resolve(
        sql`
        delete from copilotkit_threads t
        where t.user_id = ${user}
          and not exists (
            select 1 from copilotkit_thread_locks l
            where l.thread_id = t.id and l.expires_at > now()
          )
          and not exists (
            select 1 from copilotkit_thread_runs r
            where r.thread_id = t.id and r.status = 'running'
          )
      `,
      ).catch((error: unknown) => {
        log(
          JSON.stringify({
            type: "local-thread-clear-failed",
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    },
  };

  return {
    mode: "local" as const,
    runner,

    /**
     * The thread if this person may read it; create it if it is not there.
     *
     * `learningContainerId` is accepted and ignored: Automatic Learning is an Intelligence feature
     * and local mode has none.
     */
    async getOrCreateThread(params: {
      threadId: string;
      userId: string;
      agentId: string;
      learningContainerId?: string;
    }): Promise<{ thread: LocalThreadSummary; created: boolean }> {
      const thread = await ensureThread(
        params.threadId,
        params.userId,
        params.agentId,
      );
      return { thread, created: false };
    },

    async getThread(params: {
      threadId: string;
      userId: string;
    }): Promise<LocalThreadSummary> {
      const summary = await readThread(params.threadId, params.userId);
      if (!summary) throw missingThread(params.threadId);
      return summary;
    },

    async getThreadMessages(params: {
      threadId: string;
      userId: string;
    }): Promise<{ messages: LocalThreadMessage[] }> {
      const summary = await readThread(params.threadId, params.userId);
      if (!summary) throw missingThread(params.threadId);
      return {
        messages: (await threadMessages(params.threadId)).map(
          toPlatformMessage,
        ),
      };
    },

    /**
     * The platform's lock API, on the lock table.
     *
     * `createThreadLock` (`./thread-lock.ts`) is the caller, and it is the same object
     * in both modes: it reads a 409 as "somebody is in this conversation, come back" and everything
     * else as a real failure. `joinToken` is empty because nobody joins a local run over a socket —
     * the type requires a string and nothing reads it.
     */
    async acquireThreadLock(params: {
      threadId: string;
      runId: string;
      userId: string;
      agentId: string;
      ttlSeconds?: number;
      learningContainerId?: string;
    }): Promise<{ threadId: string; runId: string; joinToken: string }> {
      await ensureThread(params.threadId, params.userId, params.agentId);
      const taken = await acquireLock(
        params.threadId,
        params.runId,
        params.userId,
      );
      if (!taken) throw threadBusy(params.threadId);
      return {
        threadId: params.threadId,
        runId: params.runId,
        joinToken: "",
      };
    },

    async renewThreadLock(params: {
      threadId: string;
      runId: string;
      ttlSeconds: number;
    }): Promise<{ threadId: string; runId: string }> {
      const renewed = await renewLock(params.threadId, params.runId);
      if (!renewed) throw threadBusy(params.threadId);
      return { threadId: params.threadId, runId: params.runId };
    },

    async cleanupThreadLock(params: {
      threadId: string;
      runId: string;
    }): Promise<void> {
      await releaseLock(params.threadId, params.runId);
    },

    /** Load a thread's payload into the read mirror. See the header, point 1. */
    prime,
    /** Reload the metadata of the current person's threads. See the header, point 1. */
    refresh,

    /** For diagnostics and tests: what this process is holding, and what Postgres holds. */
    async stats() {
      const [threads] = await read<{ count: string }>(
        sql`select count(*)::text as count from copilotkit_threads`,
      );
      const [running] = await read<{ count: string }>(
        sql`select count(*)::text as count from copilotkit_thread_locks where expires_at > now()`,
      );
      return {
        threads: Number(threads?.count ?? 0),
        running: Number(running?.count ?? 0),
        mirrored: mirror.size,
        active: active.size,
      };
    },
  };
}

/**
 * The error a caller sees when a conversation is not theirs, which the platform cannot tell apart
 * from one that does not exist. Exported so a test can name it without importing the class from two
 * places.
 */
export { PlatformRequestError };
