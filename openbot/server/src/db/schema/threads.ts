import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * The durable thread store for local mode: what CopilotKit Intelligence would otherwise hold for
 * this deployment.
 *
 * WHY THESE TABLES EXIST AT ALL. Local mode (`RuntimeCapabilities` in `config.ts`, `mode: "local"`)
 * runs the CopilotKit runtime in SSE mode on a runner of our own. Intelligence is not there, so
 * nothing else owns a conversation: the threads, the messages the agent held after each run, the
 * event log a reloaded page replays, and the one-run-at-a-time lock are all this deployment's
 * problem. Phase 1 kept them in process memory and lost every conversation on restart
 * (`toolkit/src/copilotkit/local-platform.ts` says so in its own header). These are the tables that
 * replace that memory.
 *
 * SHAPED LIKE THE PLATFORM, NOT LIKE THE PRODUCT. The columns are the fields
 * the SaaS platform returns — `id`, `user_id`, `agent_id`, `archived`, … — because the
 * readers in `server/src/copilot.ts` and the runtime's own thread endpoints read those shapes and
 * must not need to know which of the two is behind them.
 *
 * NO FOREIGN KEY ON `user_id`. A thread id is the runtime's, and a server-side path (a routine, a
 * hop) creates threads that belong to nobody. Tying them to `users` would also mean a person's
 * deletion takes their audit-adjacent conversation with it, which is a product decision this table
 * is not making.
 */

/**
 * `jsonb` for a value whose type is genuinely unknown here.
 *
 * AG-UI's `content` is a string on one message and an array of parts on the next, and an event is a
 * union with no useful common shape. `./json.ts` is typed `Record<string, unknown>` for objects that
 * SQL has to query into; this one is for storage and round-tripping, so it takes anything and hands
 * it back unchanged.
 *
 * `toDriver` stays out of the way for the reason that file exists: the driver already knows how to
 * send an object to a `jsonb` parameter, and serialising it a second time stores a JSON string.
 */
const anyJson = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  toDriver: (value) => value,
});

/**
 * One conversation.
 *
 * `updated_at` is what thread lists sort by and what retention would sweep on, so it is touched by
 * every run rather than being a copy of the last message's timestamp.
 */
export const copilotThreads = pgTable(
  "copilotkit_threads",
  {
    id: text("id").primaryKey(),
    /**
     * Who the thread belongs to, or null for one a server path created.
     *
     * A NULL IS NOT "EVERYONE". The platform scopes reads to a request's person and refuses anybody
     * else with the same 404 a missing thread gets, so a thread id stays useless as an oracle for
     * whether somebody else's conversation exists. A null-owner thread is readable only by a
     * server-side path, which carries no request user.
     */
    userId: text("user_id"),
    agentId: text("agent_id").notNull(),
    name: text("name"),
    /** Kept for the shape Intelligence returns; local mode has one organisation: the empty one. */
    organizationId: text("organization_id").notNull().default(""),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("copilotkit_threads_owner_updated_idx").on(
      table.userId,
      table.updatedAt,
    ),
    index("copilotkit_threads_updated_idx").on(table.updatedAt),
  ],
);

/**
 * The conversation as the agent held it at the end of a run.
 *
 * ROWS RATHER THAN ONE BLOB PER THREAD, because the readers page through a conversation and because
 * a row can be re-written on its own. `message_id` is AG-UI's, and it is unique per thread: a
 * reloaded page resends the whole conversation, and an upsert on that pair is what stops the same
 * question appearing twice after a retry.
 *
 * `seq` orders them. It is a database sequence rather than an index the writer computes, so two
 * writers cannot both decide they are row 7.
 */
export const copilotThreadMessages = pgTable(
  "copilotkit_thread_messages",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => copilotThreads.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    role: text("role").notNull(),
    /** Absent on an assistant row that only calls tools, as AG-UI allows. */
    content: anyJson("content"),
    /** `{ id, name, args }[]`, the platform's flattened shape; null when the row has no calls. */
    toolCalls: anyJson("tool_calls"),
    toolCallId: text("tool_call_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("copilotkit_thread_messages_message_idx").on(
      table.threadId,
      table.messageId,
    ),
    index("copilotkit_thread_messages_thread_idx").on(
      table.threadId,
      table.seq,
    ),
  ],
);

/**
 * Every run's events, in the order they were emitted, for a page that reloads to replay.
 *
 * APPEND ONLY. `connect` replays these and then tails whatever arrives after the sequence it
 * reached, which is what makes a reconnect after a restart return the conversation instead of a
 * blank screen. Nothing rewrites a row.
 *
 * NO RETENTION HERE YET. The log grows with every run; a deployment that keeps years of
 * conversations wants a window on it, the way `audit-retention` has one. Named rather than silently
 * assumed to be somebody else's problem.
 */
export const copilotThreadEvents = pgTable(
  "copilotkit_thread_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => copilotThreads.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    /** The `BaseEvent` exactly as the runtime streamed it. */
    event: anyJson("event").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("copilotkit_thread_events_thread_idx").on(table.threadId, table.seq),
  ],
);

/**
 * One row per run, so "is anything running in this conversation" and "how did the last one end" have
 * answers that outlive the process that ran it.
 *
 * `stop_requested` is here rather than in memory for the same reason: a stop arrives on whichever
 * replica the browser is talking to, and the replica actually running the turn may be another one.
 */
export const copilotThreadRuns = pgTable(
  "copilotkit_thread_runs",
  {
    runId: text("run_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => copilotThreads.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    agentId: text("agent_id"),
    status: text("status").notNull().default("running"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    /** Why the run ended badly, when it did. Never a stack trace with a credential in it. */
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    /*
     * A RUN IS NAMED WITHIN ITS THREAD, as a message is (`copilotkit_thread_messages_message_idx`).
     * The run id comes from the client's RunAgentInput, and with `run_id` alone as the key a client
     * reusing one on another thread hit the upsert in `startRun` and kept the first thread's row:
     * the second run had no record of its own and its finish was written onto the first one's.
     */
    primaryKey({ columns: [table.threadId, table.runId] }),
    index("copilotkit_thread_runs_thread_idx").on(
      table.threadId,
      table.startedAt,
    ),
    check(
      "copilotkit_thread_runs_status_check",
      sql`${table.status} IN ('running', 'finished', 'error', 'stopped')`,
    ),
  ],
);

/**
 * The conversation's run lock: ONE ROW PER THREAD, held by the run that is working in it.
 *
 * A ROW, NOT AN ADVISORY LOCK, and the difference is the point. `pg_advisory_lock` is session
 * scoped, so holding one for a run means holding one pooled connection for as long as a turn takes —
 * a leak that starves the pool when a few turns run at once, and one that disappears on a connection
 * reset while the run it was protecting keeps writing. This row is taken and renewed by ordinary
 * statements, so a run can span connections, a second replica sees it, and an expiry frees it
 * without any process having to notice a death.
 *
 * `expires_at` IS COMPARED IN SQL, ALWAYS. The database's clock decides whether a lock is live, for
 * the reason `server/src/work/queue.ts` spells out: a replica whose clock is behind writes a lease
 * the database considers expired on arrival, and then two runs hold the same conversation.
 *
 * Deleting a thread takes its lock with it (`onDelete: cascade`), which is the one case where a
 * locked thread may lose it. Nothing deletes a running thread: `clearThreads` skips those.
 */
export const copilotThreadLocks = pgTable(
  "copilotkit_thread_locks",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => copilotThreads.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    userId: text("user_id"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** In the past means free: the run that held this stopped renewing and is presumed gone. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("copilotkit_thread_locks_expiry_idx").on(table.expiresAt)],
);
