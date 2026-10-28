/**
 * Local mode's one piece of process state: the thread platform.
 *
 * ONE PER PROCESS, ON PURPOSE. In local mode the runtime's runner, every headless turn, the thread
 * lock, the history readers and `/api/threads/:id` must all see the same conversations, exactly as
 * they all see the same Intelligence project in Intelligence mode. Built lazily so that Intelligence
 * mode never creates it, and handed out from here rather than threaded through `createApp`'s
 * positional parameters. Phase 2 replaces what this returns with a Postgres-backed platform behind
 * the same surface; nothing that calls this should need to change.
 */
import {
  createLocalThreadPlatform,
  type LocalThreadPlatform,
} from "@openbot/toolkit/copilotkit/local-platform";
import type { DeploymentConfig } from "./config";
import type { RuntimeEntitlementResponse } from "./self-host-banner";

let platform: LocalThreadPlatform | undefined;

export function localThreadPlatform(): LocalThreadPlatform {
  platform ??= createLocalThreadPlatform();
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

/** Said once at boot, so nobody mistakes local mode for a durable deployment. */
export function announceLocalMode(log: (line: string) => void = console.warn) {
  log(
    JSON.stringify({
      type: "openduet-local-mode",
      durableHistory: false,
      message:
        "Running WITHOUT CopilotKit Intelligence (OPENDUET_LOCAL_MODE=true). Threads, history and run locks are held in this process and are lost on restart. Automatic Learning, the Intelligence entitlement check and the self-host banner are off; memory uses OpenBot's own tables.",
    }),
  );
}
