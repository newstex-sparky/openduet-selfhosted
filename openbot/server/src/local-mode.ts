/**
 * Local mode's one piece of process state: the thread platform, and the client it talks to.
 *
 * ONE PER PROCESS, ON PURPOSE. In local mode the runtime's runner, every headless turn, the thread
 * lock, the history readers and `/api/threads/:id` must all see the same conversations, exactly as
 * they all see the same Intelligence project in Intelligence mode. Built lazily so that Intelligence
 * mode never creates it, and handed out from here rather than threaded through `createApp`'s
 * positional parameters.
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
import type { RuntimeEntitlementResponse } from "./self-host-banner";

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

export function isLocalMode(
  config: Pick<DeploymentConfig, "runtime">,
): boolean {
  return config.runtime.mode === "local";
}

/**
 * What a feature that needs Intelligence says in local mode instead of reaching for it.
 *
 * An `Error`, so the readers that already treat a failed entitlement read as "unreachable" (the
 * setup checklist, the boot entitlement report) do so here without a branch of their own — and no
 * request leaves the process.
 */
export function localModeEntitlements(): Promise<RuntimeEntitlementResponse> {
  return Promise.reject(
    new Error(
      "Local mode: CopilotKit Intelligence is not configured, so there is no entitlement to read.",
    ),
  );
}

/** Said once at boot, so nobody mistakes local mode for a deployment that forgets. */
export function announceLocalMode(log: (line: string) => void = console.warn) {
  log(
    JSON.stringify({
      type: "openduet-local-mode",
      durableHistory: true,
      message:
        "Running WITHOUT CopilotKit Intelligence (OPENDUET_LOCAL_MODE=true). Threads, history and run locks are stored in this deployment's Postgres and survive a restart. Automatic Learning, the Intelligence entitlement check and the self-host banner are off; memory uses OpenBot's own tables.",
    }),
  );
}
