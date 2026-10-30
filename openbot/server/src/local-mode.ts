/**
 * Local mode's one piece of process state: the thread platform, and the client it talks to.
 *
 * ONE PER PROCESS, ON PURPOSE. The runtime's runner, every headless turn, the thread lock, the
 * history readers and `/api/threads/:id` must all see the same conversations, so the platform is
 * built once here and handed out rather than threaded through `createApp`'s positional parameters.
 *
 * WHAT IT TALKS TO. The deployment's own Postgres (`DATABASE_URL`), against the tables migration
 * `0068` adds: threads, messages, the event log and the run lock. Nothing is held in this process's
 * memory as the source of truth, so a restart keeps every conversation and a second replica sees the
 * same ones — which is what Phase 1 could not do (`docs/local-mode.md`).
 *
 * The pool is its own rather than the `drizzle` one, because a turn holds a connection for as long
 * as it takes to write its events and the request path must not queue behind that. `max` is modest
 * for the same reason: a locked conversation is one run, not one connection per event.
 */

import type {
  PlatformSql,
  PostgresThreadPlatform,
} from "@openbot/toolkit/copilotkit/postgres-platform";
import { createPostgresThreadPlatform } from "@openbot/toolkit/copilotkit/postgres-platform";
import postgres from "postgres";
import type { DeploymentConfig } from "./config";

let platform: PostgresThreadPlatform | undefined;

export function localThreadPlatform(
  config: Pick<DeploymentConfig, "databaseUrl">,
): PostgresThreadPlatform {
  if (platform) return platform;
  /*
   * `onnotice` silenced as `scripts/migrate.ts` does: the `IF NOT EXISTS` guards in the thread
   * platform's own statements are not interesting, and a notice per run would fill the log.
   */
  const client = postgres(config.databaseUrl, { max: 10, onnotice: () => {} });
  platform = createPostgresThreadPlatform({
    /*
     * `postgres`'s tagged template, which is what `PlatformSql` describes: the toolkit takes a
     * query function rather than a driver so it keeps no database dependency of its own.
     */
    sql: client as unknown as PlatformSql,
  });
  return platform;
}

/** Said once at boot, so nobody mistakes this deployment for one whose history is not durable. */
export function announceLocalMode(log: (line: string) => void = console.warn) {
  log(
    JSON.stringify({
      type: "openduet-local-mode",
      durableHistory: true,
      message:
        "Running in local mode. Threads, history and run locks are stored in this deployment's Postgres and survive a restart. Automatic Learning, the entitlement check and the self-host banner are off; memory uses OpenBot's own tables.",
    }),
  );
}
