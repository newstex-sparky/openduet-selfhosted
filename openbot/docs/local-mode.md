# Local mode: OpenDuet without CopilotKit Intelligence

> **Status: Phases 1–3 of the self-hosted fork are complete.** Opt-in, durable (Postgres-backed),
> and the headless machinery (routines, approvals, proactive turns, Bot-to-Bot handoffs) runs on the
> same Postgres runner and lock. Read "Known gaps" before relying on it.
>
> | Phase | What landed | Proof in the repo |
> | --- | --- | --- |
> | 1 | `OPENDUET_LOCAL_MODE` boots the runtime in SSE mode with zero calls to CopilotKit Intelligence | `server/tests/local-mode.test.ts`, `server/tests/telemetry.test.ts` |
> | 2 | Threads, messages, the event log and the per-thread run lock live in Postgres (migration `0068`); replaces Phase 1's in-memory store | `server/tests/postgres-platform.integration.test.ts` (restart keeps history, two processes share one lock, 409 on a busy thread) |
> | 3 | Routines, approvals, proactive turns and handoffs drive turns through the Postgres runner/lock in local mode | `server/tests/local-mode-e2e.integration.test.ts` (a scheduled routine fires and completes; an approval-gated click pauses, stays pending with nothing sent to the computer, then resumes after `allow_once`, with an audit row) |

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
{"type":"openduet-local-mode","durableHistory":true,"message":"Running WITHOUT CopilotKit Intelligence (OPENDUET_LOCAL_MODE=true). Threads, history and run locks are stored in this deployment's Postgres and survive a restart. ..."}
```

## How it works

`server/src/config.ts` — `RuntimeCapabilities` is a union:
`{ mode: "intelligence", durableHistory: true, intelligence }` or
`{ mode: "local", durableHistory: true }`. Both modes are durable; they keep conversations in
different places (Intelligence vs. this deployment's Postgres), which is why setting both is refused.

`toolkit/src/copilotkit/postgres-platform.ts` — one platform object per server process
(`server/src/local-mode.ts`, on its own `postgres` pool against `DATABASE_URL`) that answers
everything the server otherwise asks Intelligence. Its storage is the five tables migration
`server/drizzle/0068_white_katie_power.sql` adds: `copilotkit_threads`, `copilotkit_thread_messages`,
`copilotkit_thread_events`, `copilotkit_thread_runs` and `copilotkit_thread_locks`.

- **`runner`** — an `AgentRunner` (`run` / `connect` / `isRunning` / `stop`) handed to
  `new CopilotRuntime({ runner })`, i.e. the runtime's own **SSE mode**. `run` writes every event to
  the Postgres event log before emitting it; `connect` replays the log and then polls it, so a
  reconnect after a restart — or to a different replica — returns the whole conversation. It also
  implements the runtime's local thread endpoints (`GET /threads`, `/threads/:id/messages|events|state`,
  `POST /threads/clear`), scoped to the signed-in person. Those four reads are synchronous in the
  runtime's interface, so they read a per-process mirror that the local-mode gate in `copilot.ts`
  primes from Postgres before handing the request on; Postgres stays the source of truth.
- **thread + history** — `getOrCreateThread`, `getThread`, `getThreadMessages`, in the same shapes
  and with the same error contract as `CopilotKitIntelligence` (a missing or foreign thread is a
  `PlatformRequestError` 404), so `channels/thread-status.ts`, `approvals/wiring.ts`,
  `openduet/task-report.ts`, delivery history and the handoff desk read it unchanged.
- **per-thread run lock** — `ɵacquireThreadLock` / `ɵrenewThreadLock` / `ɵcleanupThreadLock` backed
  by a TTL lease row in `copilotkit_thread_locks` (taken with an upsert that only succeeds when the
  existing lease has expired). Every lease comparison uses Postgres's `now()`, never a process
  clock, so replicas cannot disagree about who holds a thread. A conflict is a 409
  `PlatformRequestError`, so `isLockConflict`, `ThreadLockBusyError` and
  `createIntelligenceThreadLock` behave exactly as against the platform. An optional `lockWaitMs`
  lets a caller queue behind a running turn instead of being refused.

The original Phase 1 in-memory store (`toolkit/src/copilotkit/local-platform.ts`) remains in the
tree and shares the error helpers (`platform-errors.ts`) and record shapes (`thread-records.ts`),
but the server no longer uses it for local mode.

**postgres.js and `jsonb`.** Bind JSON text as `${json}::text::jsonb`, not `${json}::jsonb`: with the
latter the driver infers a `jsonb` parameter, re-stringifies the string, and stores a jsonb *string
scalar* ("cannot extract elements from a scalar"). The runner logs and swallows write failures
(`local-thread-*-write-failed`), so this showed up only once tests asserted the stored rows. Fixed
in `b690814`.

Because that object satisfies the same structural `IntelligenceLike` / `RunnerLike` surface
`toolkit/src/run-turn.ts` was written against, **every `createTurnRunner` call site in `index.ts`
(routines, responsibilities, approval continuations, group conversations, proactive turns,
wake-ups) and the Bot-to-Bot handoff desk run on the Postgres runner and lock** in local mode rather
than being disabled. Headless turns have no browser request to say whose thread they are touching,
so `index.ts` wraps each of those call sites in `headlessTurn`, which runs the turn inside
`runAsLocalUser(input.ownerUserId)` in local mode (and is a plain `createTurnRunner` in Intelligence
mode). Without it the first routine firing failed with `Thread … not found`.

**Who owns a thread.** SSE mode never calls `identifyUser`, so `copilot.ts` wraps the CopilotKit
handler in a gate: every route except `/info` requires `identifyUser` to succeed (401 otherwise),
and the request then runs inside `runAsLocalUser(userId)` (an `AsyncLocalStorage`). A thread belongs
to whoever first touched it; anyone else gets the answer a missing thread gets.

**Telemetry.** `server/src/telemetry.ts` defaults `COPILOTKIT_TELEMETRY_DISABLED=true` in local mode
before the runtime package is imported. Set it to `false` yourself to opt back in.

**Off in local mode (no-ops, not errors):** Automatic Learning (`learning` is `undefined`,
auto-assign reports `off`), the Intelligence entitlement check (not run), the self-host banner
(`shown: false`), Intelligence memory (OpenBot's Postgres memory tables are used, which is the
existing fallback). The onboarding setup checklist still lists "CopilotKit Intelligence — Required
/ Needs setup" (its entitlement read fails locally, by design); that copy is a known gap.

## Verified end to end (Phase 3)

`server/tests/local-mode-e2e.integration.test.ts` boots the real `server/src/index.ts` in a child
process against a real Postgres, with only the model (a loopback OpenAI-compatible `LLMock`) and the
Bot's computer (a loopback `/click` stub) stood in. Every assertion reads Postgres or the server's
own log, not memory.

- **A scheduled routine fires and completes.** The real `scripts/fire-routines.ts` sweep runs in a
  separate process, posts to `/internal/routines/run`, and the turn completes: the `routine_runs` row
  finishes with no error and the user prompt and assistant reply are in `copilotkit_thread_messages`.
- **An approval-gated action pauses, then resumes.** A routine whose model calls `computer_click` on
  a gated action stops: the `approval_requests` row stays `pending` and the stub computer receives
  **no** request while it waits (the negative control). After an `allow_once` decision over HTTP the
  resume sweep runs the click exactly once, the turn finishes ("The form was submitted."), and an
  `approval.person_decided` audit event records who decided what.

Run it with `TEST_DATABASE_URL=<migrated db> bun test server/tests/local-mode-e2e.integration.test.ts`
(and `server/tests/postgres-platform.integration.test.ts` for the Phase 2 restart/concurrency cases).

## Known gaps

- **Proactive turns and Bot-to-Bot handoffs have no dedicated local-mode e2e test.** They go through
  the same `createTurnRunner` → Postgres runner/lock path that the routine and approval cases prove,
  and are unit-tested through `createTurnRunner`, but nothing drives them end to end against a live
  server in local mode yet.
- **No push-based realtime fan-out.** There is no gateway and no `LISTEN/NOTIFY`: a second tab,
  device or replica sees a run by `connect`, which polls the event log. Thread metadata realtime
  (`threads/subscribe`) and thread mutations (rename/archive/delete) were Intelligence-only in
  Phase 1 and have not been re-examined since.
- **No ranked/semantic memory recall, no Automatic Learning, no thread auto-naming.**
- Some Intelligence-specific UI copy (the setup checklist's "CopilotKit Intelligence — Required",
  Admin → Learning) still talks about Intelligence.
