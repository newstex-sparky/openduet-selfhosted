# Local mode: OpenDuet without CopilotKit Intelligence

> **Status: Phase 1 of the self-hosted fork.** Opt-in, in-memory, not durable. Read "What does not
> work yet" before relying on it.

OpenDuet normally requires CopilotKit Intelligence (`INTELLIGENCE_API_URL`,
`INTELLIGENCE_GATEWAY_WS_URL`, `INTELLIGENCE_API_KEY`) and refuses to boot without it. Local mode is
an explicit second runtime mode that boots and serves real chat turns with **no Intelligence at all**
and **no request to any `*.copilotkit.ai` endpoint**.

## Turning it on

```sh
OPENDUET_LOCAL_MODE=true
# and leave INTELLIGENCE_API_KEY unset or empty
```

| `OPENDUET_LOCAL_MODE` | `INTELLIGENCE_API_KEY` | Result |
| --- | --- | --- |
| unset / `false` / `0` | set (with both URLs) | Intelligence mode — unchanged behaviour |
| unset / `false` / `0` | unset | refused at boot, as before (message now names the opt-in) |
| `true` / `1` | unset | **local mode** |
| `true` / `1` | set | refused at boot: "I set both" is a mistake, not a preference |
| anything else | — | refused at boot (typo guard) |

The two `INTELLIGENCE_*_URL` values that `.env.example` ships filled in are ignored in local mode;
only the key decides.

At boot the server logs one line saying so:

```json
{"type":"openduet-local-mode","durableHistory":false,"message":"Running WITHOUT CopilotKit Intelligence ..."}
```

## How it works

`server/src/config.ts` — `RuntimeCapabilities` is now a union:
`{ mode: "intelligence", durableHistory: true, intelligence }` or
`{ mode: "local", durableHistory: false }`.

`toolkit/src/copilotkit/local-platform.ts` — one in-process object per server
(`server/src/local-mode.ts`) that answers everything the server otherwise asks Intelligence:

- **`runner`** — an `AgentRunner` (`run` / `connect` / `isRunning` / `stop`) handed to
  `new CopilotRuntime({ runner })`, i.e. the runtime's own **SSE mode**. It also implements the
  runtime's local thread endpoints (`GET /threads`, `/threads/:id/messages|events|state`,
  `POST /threads/clear`), scoped to the signed-in person.
- **thread + history** — `getOrCreateThread`, `getThread`, `getThreadMessages`, in the same shapes
  and with the same error contract as `CopilotKitIntelligence` (a missing or foreign thread is a
  `PlatformRequestError` 404), so `channels/thread-status.ts`, `approvals/wiring.ts`,
  `openduet/task-report.ts`, delivery history and the handoff desk read it unchanged.
- **per-thread run lock** — `ɵacquireThreadLock` / `ɵrenewThreadLock` / `ɵcleanupThreadLock` with
  TTLs and a 409 `PlatformRequestError` on conflict, so `isLockConflict`, `ThreadLockBusyError` and
  `createIntelligenceThreadLock` behave exactly as against the platform. A browser run on a thread
  whose lock is held by another run is refused, as the gateway refuses it.

Because that object satisfies the same structural `IntelligenceLike` / `RunnerLike` surface
`toolkit/src/run-turn.ts` was written against, **every `createTurnRunner` call site in `index.ts`
(routines, responsibilities, approval continuations, group conversations, proactive turns,
wake-ups) and the Bot-to-Bot handoff desk run in-process** in local mode rather than being disabled.

**Who owns a thread.** SSE mode never calls `identifyUser`, so `copilot.ts` wraps the CopilotKit
handler in a gate: every route except `/info` requires `identifyUser` to succeed (401 otherwise),
and the request then runs inside `runAsLocalUser(userId)` (an `AsyncLocalStorage`). A thread belongs
to whoever first touched it; anyone else gets the answer a missing thread gets.

**Telemetry.** `server/src/telemetry.ts` defaults `COPILOTKIT_TELEMETRY_DISABLED=true` in local mode
before the runtime package is imported. Set it to `false` yourself to opt back in.

**Off in local mode (no-ops, not errors):** Automatic Learning (`learning` is `undefined`,
auto-assign reports `off`), the Intelligence entitlement check (not run), the self-host banner
(`shown: false`), Intelligence memory (OpenBot's Postgres memory tables are used, which is the
existing fallback). The setup checklist's Intelligence row reads "unreachable".

## What does not work yet (Phase 2 / Phase 3 backlog)

- **Nothing survives a restart.** Threads, messages, replay events and locks are process memory.
  A restart forgets every conversation; the browser's remembered thread id then reads as unknown
  and a fresh thread is minted. Bounded at 2,000 threads (idle threads evicted LRU).
- **Single replica only.** A second server process has its own, separate store and its own locks.
- **No realtime fan-out.** There is no gateway: a second tab or device does not see a run live
  unless it calls `connect` (which replays history and then follows an in-progress run in the
  same process). Thread metadata realtime (`threads/subscribe`) and thread mutations
  (rename/archive/delete) are Intelligence-only and answer 422.
- **No ranked/semantic memory recall, no Automatic Learning, no thread auto-naming.**
- **Headless turns are in-process but under-tested in local mode** — unit-tested through
  `createTurnRunner`; routines/approvals/handoffs/proactive turns have not been exercised end to end
  against a live model in local mode.
- Some Intelligence-specific UI copy (setup checklist, Admin → Learning) still talks about
  Intelligence.

Phase 2: replace the storage behind `local-platform.ts` with Postgres (threads, messages, compacted
events; the run lock as an advisory lock or `SELECT … FOR UPDATE` row with a TTL), keeping the same
surface, so threads survive restarts and replicas share them. Phase 3: end-to-end coverage for
routines, approvals, proactive turns and handoffs in local mode, realtime fan-out (LISTEN/NOTIFY or
SSE re-subscribe), and the remaining Intelligence-specific UI.
