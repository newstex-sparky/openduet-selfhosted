import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import {
  createPostgresThreadPlatform,
  type PlatformSql,
} from "@openbot/toolkit/copilotkit/postgres-platform";
import { runAsLocalUser } from "@openbot/toolkit/copilotkit/request-scope";
import { isLockConflict } from "@openbot/toolkit/lease";
import postgres from "postgres";
import { Observable } from "rxjs";
import { applyMigrations } from "../src/db/apply-migrations";
import { testDatabaseUrl } from "./support/database";

/**
 * Local mode's Postgres thread platform, against a real database migrated with the real migrations.
 *
 * The two properties Phase 1 could not have, and the only reason this platform exists: a thread
 * outlives the process that wrote it (a second platform on the same database is a restart, or a
 * second replica), and the run lock is shared through the database rather than held in memory.
 *
 * One throwaway database per file, created and dropped the same way as in
 * `migration-reach.integration.test.ts`, so nothing here depends on what the shared test database
 * already holds.
 */

const server = new URL(testDatabaseUrl());
const administrative = new URL(server.href);
administrative.pathname = "/postgres";

const created: string[] = [];
const clients: postgres.Sql[] = [];

async function throwawayDatabase(): Promise<string> {
  const name = `openbot_pgplatform_${Math.random().toString(36).slice(2, 10)}`;
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  created.push(name);
  const url = new URL(server.href);
  url.pathname = `/${name}`;
  return url.href;
}

afterAll(async () => {
  for (const client of clients) await client.end({ timeout: 5 });
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    for (const name of created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}, 30_000);

async function migratedDatabase(): Promise<string> {
  const url = await throwawayDatabase();
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await applyMigrations(client, join(import.meta.dir, "..", "drizzle"));
  } finally {
    await client.end({ timeout: 5 });
  }
  return url;
}

/** A platform on its own pool: two of these on one database are two processes. */
function platformOn(url: string, options: { lockWaitMs?: number } = {}) {
  const client = postgres(url, { max: 4, onnotice: () => {} });
  clients.push(client);
  return createPostgresThreadPlatform({
    sql: client as unknown as PlatformSql,
    ...options,
  });
}

/** One agent turn: replies `reply`, after holding the run for `holdMs`, and notes when it ran. */
class ScriptedAgent extends AbstractAgent {
  readonly spans: { start: number; end: number }[] = [];

  constructor(
    private readonly reply: string,
    private readonly holdMs = 0,
  ) {
    super({ agentId: "openduet" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const start = Date.now();
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      const messageId = `assistant-${input.runId}`;
      const timer = setTimeout(() => {
        subscriber.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
        } as BaseEvent);
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: this.reply,
        } as BaseEvent);
        subscriber.next({
          type: EventType.TEXT_MESSAGE_END,
          messageId,
        } as BaseEvent);
        this.spans.push({ start, end: Date.now() });
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        subscriber.complete();
      }, this.holdMs);
      return () => clearTimeout(timer);
    });
  }
}

function userMessage(id: string, content: string): Message {
  return { id, role: "user", content } as Message;
}

/** One turn through the runner, the way the runtime's SSE handler drives it, as `userId`. */
function turn(
  platform: ReturnType<typeof platformOn>,
  userId: string,
  threadId: string,
  runId: string,
  messages: Message[],
  agent: ScriptedAgent,
): Promise<BaseEvent[]> {
  agent.setMessages(messages);
  const input: RunAgentInput = {
    threadId,
    runId,
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
  return runAsLocalUser(
    userId,
    () =>
      new Promise<BaseEvent[]>((resolve, reject) => {
        const events: BaseEvent[] = [];
        platform.runner.run({ threadId, agent, input }).subscribe({
          next: (event) => events.push(event),
          error: reject,
          complete: () => resolve(events),
        });
      }),
  );
}

describe("the Postgres thread platform", () => {
  test("migration 0068 creates the thread tables", async () => {
    const url = await migratedDatabase();
    const client = postgres(url, { max: 1, onnotice: () => {} });
    clients.push(client);
    const rows = await client<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'copilotkit_thread%'
      ORDER BY table_name`;
    expect(rows.map((row) => row.table_name)).toEqual([
      "copilotkit_thread_events",
      "copilotkit_thread_locks",
      "copilotkit_thread_messages",
      "copilotkit_thread_runs",
      "copilotkit_threads",
    ]);
  }, 120_000);

  test("a thread survives a restart and stays scoped to its owner", async () => {
    const url = await migratedDatabase();
    await platformOn(url).getOrCreateThread({
      threadId: "durable-thread",
      userId: "alice",
      agentId: "openduet",
    });

    // A fresh platform on the same database: nothing in memory, only what Postgres holds.
    const restarted = platformOn(url);
    const thread = await restarted.getThread({
      threadId: "durable-thread",
      userId: "alice",
    });
    expect(thread.id).toBe("durable-thread");
    expect(thread.agentId).toBe("openduet");
    expect(
      await restarted.getThreadMessages({
        threadId: "durable-thread",
        userId: "alice",
      }),
    ).toEqual({ messages: [] });

    const foreign = await restarted
      .getThread({ threadId: "durable-thread", userId: "mallory" })
      .catch((error: unknown) => error);
    expect((foreign as { name?: string }).name).toBe("PlatformRequestError");
    expect((foreign as { status?: number }).status).toBe(404);
  }, 120_000);

  test("the run lock is shared between two processes on one database", async () => {
    const url = await migratedDatabase();
    const first = platformOn(url);
    const second = platformOn(url);
    const lock = {
      threadId: "locked-thread",
      userId: "alice",
      agentId: "openduet",
      ttlSeconds: 60,
    };

    expect(
      await first.ɵacquireThreadLock({ ...lock, runId: "held" }),
    ).toMatchObject({ threadId: "locked-thread", runId: "held" });

    const conflict = await second
      .ɵacquireThreadLock({ ...lock, runId: "other" })
      .catch((error: unknown) => error);
    expect(isLockConflict(conflict)).toBe(true);
    expect((conflict as { status?: number }).status).toBe(409);

    await first.ɵcleanupThreadLock({
      threadId: "locked-thread",
      runId: "held",
    });
    expect(
      await second.ɵacquireThreadLock({ ...lock, runId: "other" }),
    ).toMatchObject({ runId: "other" });
  }, 120_000);

  test("a restart mid-conversation keeps the history, and the next turn continues it", async () => {
    const url = await migratedDatabase();
    const before = platformOn(url);
    const first = [userMessage("u1", "Hi")];
    await turn(
      before,
      "alice",
      "chat",
      "r1",
      first,
      new ScriptedAgent("Hello, Alice."),
    );

    // The server restarts: a fresh platform on its own pool, nothing in memory.
    const after = platformOn(url);
    const history = await after.getThreadMessages({
      threadId: "chat",
      userId: "alice",
    });
    expect(history.messages).toEqual([
      { id: "u1", role: "user", content: "Hi" },
      { id: "assistant-r1", role: "assistant", content: "Hello, Alice." },
    ]);

    // The conversation continues on the restarted server from what Postgres held.
    const second = [
      ...first,
      {
        id: "assistant-r1",
        role: "assistant",
        content: "Hello, Alice.",
      } as Message,
      userMessage("u2", "Still there?"),
    ];
    await turn(after, "alice", "chat", "r2", second, new ScriptedAgent("Yes."));

    const again = platformOn(url);
    expect(
      (
        await again.getThreadMessages({ threadId: "chat", userId: "alice" })
      ).messages.map((message) => message.id),
    ).toEqual(["u1", "assistant-r1", "u2", "assistant-r2"]);

    // A reconnect after the restart replays both turns from the event log.
    const replay = await runAsLocalUser(
      "alice",
      () =>
        new Promise<BaseEvent[]>((resolve, reject) => {
          const events: BaseEvent[] = [];
          again.runner.connect({ threadId: "chat" }).subscribe({
            next: (event) => events.push(event),
            error: reject,
            complete: () => resolve(events),
          });
        }),
    );
    expect(
      replay.filter((event) => event.type === EventType.RUN_FINISHED),
    ).toHaveLength(2);
  }, 120_000);

  test("two concurrent requests to one thread on two processes run one after the other", async () => {
    const url = await migratedDatabase();
    const first = platformOn(url, { lockWaitMs: 15_000 });
    const second = platformOn(url, { lockWaitMs: 15_000 });
    const one = new ScriptedAgent("first", 400);
    const two = new ScriptedAgent("second", 400);

    const results = await Promise.all([
      turn(first, "alice", "busy", "run-a", [userMessage("ua", "A")], one),
      turn(second, "alice", "busy", "run-b", [userMessage("ub", "B")], two),
    ]);

    // Both finished, neither was refused, and the database lock kept their runs from overlapping.
    for (const events of results) {
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    }
    const [a, b] = [one.spans[0], two.spans[0]];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) return;
    const [earlier, later] = a.start <= b.start ? [a, b] : [b, a];
    expect(later.start).toBeGreaterThanOrEqual(earlier.end);
    expect(await first.runner.isRunning({ threadId: "busy" })).toBe(false);
  }, 120_000);

  test("with no wait, a concurrent request to a running thread is refused with 409", async () => {
    const url = await migratedDatabase();
    const first = platformOn(url);
    const second = platformOn(url);

    const outcomes = await Promise.allSettled([
      turn(
        first,
        "alice",
        "busy",
        "run-a",
        [userMessage("ua", "A")],
        new ScriptedAgent("a", 400),
      ),
      turn(
        second,
        "alice",
        "busy",
        "run-b",
        [userMessage("ub", "B")],
        new ScriptedAgent("b", 400),
      ),
    ]);

    const refused = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const reason = (refused[0] as PromiseRejectedResult).reason;
    expect(isLockConflict(reason)).toBe(true);
    expect((reason as { status?: number }).status).toBe(409);
  }, 120_000);
});
