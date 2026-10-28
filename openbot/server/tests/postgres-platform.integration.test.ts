import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createPostgresThreadPlatform,
  type PlatformSql,
} from "@openbot/toolkit/copilotkit/postgres-platform";
import { isLockConflict } from "@openbot/toolkit/lease";
import postgres from "postgres";
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
function platformOn(url: string) {
  const client = postgres(url, { max: 4, onnotice: () => {} });
  clients.push(client);
  return createPostgresThreadPlatform({
    sql: client as unknown as PlatformSql,
  });
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
});
