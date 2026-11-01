# Local mode: the only runtime this fork has

> **Status: the project is done through Phase 6, and this is the only mode.** There is no hosted
> runtime to opt out of. The server boots into local mode or it does not boot, and every
> `INTELLIGENCE_*`, `COPILOTKIT_*` and `OPENDUET_LOCAL_MODE` variable is ignored.
>
> | Phase | What landed | Proof in the repo |
> | --- | --- | --- |
> | 1 | The runtime boots with zero calls to a hosted service | `server/tests/local-mode.test.ts` |
> | 2 | Threads, messages, the event log and the per-thread run lock live in Postgres (migration `0068`); replaces Phase 1's in-memory store | `server/tests/postgres-platform.integration.test.ts` (restart keeps history, two processes share one lock, 409 on a busy thread) |
> | 3 | Routines, approvals, proactive turns and handoffs drive turns through the Postgres runner/lock | `server/tests/local-mode-e2e.integration.test.ts` (a scheduled routine fires and completes; an approval-gated click pauses, stays pending with nothing sent to the computer, then resumes after `allow_once`, with an audit row) |
> | 4-6 | The runtime, the frontend and the thread API are first-party: no `@copilotkit/*` package is installed | `server/tests/local-mode.test.ts` asserts the manifests name none |
> | 7 | The old table names were renamed in place by migration `0070` | `server/drizzle/0070_rename_thread_tables.sql` |

## Booting it

Nothing but a database and a model key is needed:

```sh
DATABASE_URL=postgres://…   # threads, messages, events and the run lock live here
KEY_ENCRYPTION_KEY=…        # base64 32 bytes
OPENAI_API_KEY=…            # or the provider you configured
```

`INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `INTELLIGENCE_API_KEY`,
`COPILOTKIT_LICENSE_TOKEN` and `OPENDUET_LOCAL_MODE` are ignored rather than refused, because a
leftover `.env` from a managed deployment is not a deployment asking for another mode. There is no
other mode to ask for.

At boot the server logs one line saying so:

```json
{"type":"openduet-local-mode","durableHistory":true,"message":"Running in local mode. Threads, history and run locks are stored in this deployment's Postgres and survive a restart. Automatic Learning, the entitlement check and the self-host banner are off; memory uses OpenBot's own tables."}
```

## How it works

`server/src/config.ts` — `runtimeCapabilities()` returns `{ mode: "local", durableHistory: true }`.
It takes no input and cannot return anything else.

`toolkit/src/platform/postgres-platform.ts` — one platform object per server process
(`server/src/local-mode.ts`, on its own `postgres` pool against `DATABASE_URL`) that answers
everything the server otherwise asked a hosted service for. Its storage is five tables:
`openduet_threads`, `openduet_thread_messages`, `openduet_thread_events`, `openduet_thread_runs` and
`openduet_thread_locks`. Migration `server/drizzle/0068_white_katie_power.sql` created them under
the upstream product's names; migration `0070` renamed every table, index and constraint in place,
so a database that stopped at `0069` keeps its rows through the rename.

`toolkit/src/platform/engine/engine.ts` — `createEngineHandler` is this fork's own AG-UI runtime. It
is not a wrapper around an installed package: the router, the agent request handling, the SSE
framing, the converters and the Open Generative UI middleware were ported into it, and each ported
file names its upstream source and licence at the top.

- **`runner`** — an `AgentRunner` (`run` / `connect` / `isRunning` / `stop`) handed to the engine,
  i.e. the runtime's own **SSE mode**. `run` writes every event to the Postgres event log before
  emitting it; `connect` replays the log and then polls it, so a reconnect after a restart — or to a
  different replica — returns the whole conversation. It also implements the local thread endpoints
  (`GET /threads`, `/threads/:id/messages|events|state`, `POST /threads/clear`), scoped to the
  signed-in person. Those four reads are synchronous in the runtime's interface, so they read a
  per-process mirror that the gate in `engine.ts` primes from Postgres before handing the request on;
  Postgres stays the source of truth.
- **thread + history** — `getOrCreateThread`, `getThread`, `getThreadMessages`, with a stable error
  contract (a missing or foreign thread is a `PlatformRequestError` 404), so
  `channels/thread-status.ts`, `approvals/wiring.ts`, `openduet/task-report.ts`, delivery history and
  the handoff desk read it unchanged.
- **per-thread run lock** — `acquireThreadLock` / `renewThreadLock` / `cleanupThreadLock` backed by a
  TTL lease row in `openduet_thread_locks` (taken with an upsert that only succeeds when the existing
  lease has expired). Every lease comparison uses Postgres's `now()`, never a process clock, so
  replicas cannot disagree about who holds a thread. A conflict is a 409 `PlatformRequestError`. An
  optional `lockWaitMs` lets a caller queue behind a running turn instead of being refused.

The Phase 1 in-memory store (`toolkit/src/platform/local-platform.ts`) remains in the tree for the
tests that pin its shape, and shares the error helpers (`platform-errors.ts`) and record shapes
(`thread-records.ts`), but the server does not use it as the store.

**postgres.js and `jsonb`.** Bind JSON text as `${json}::text::jsonb`, not `${json}::jsonb`: with the
latter the driver infers a `jsonb` parameter, re-stringifies the string, and stores a jsonb *string
scalar* ("cannot extract elements from a scalar"). The runner logs and swallows write failures
(`local-thread-*-write-failed`), so this showed up only once tests asserted the stored rows.

Because that object satisfies the same structural surface `toolkit/src/run-turn.ts` was written
against, **every `createTurnRunner` call site in `index.ts` (routines, responsibilities, approval
continuations, group conversations, proactive turns, wake-ups) and the Bot-to-Bot handoff desk run on
the Postgres runner and lock** rather than being disabled. Headless turns have no browser request to
say whose thread they are touching, so `index.ts` wraps each of those call sites in `headlessTurn`,
which runs the turn inside `runAsLocalUser(input.ownerUserId)`. Without it the first routine firing
failed with `Thread … not found`.

**Who owns a thread.** SSE mode never calls `identifyUser`, so `engine.ts` wraps the runtime handler
in a gate: every route except `/info` requires `identifyUser` to succeed (401 otherwise), and the
request then runs inside `runAsLocalUser(userId)` (an `AsyncLocalStorage`). A thread belongs to
whoever first touched it; anyone else gets the answer a missing thread gets.

**Telemetry.** This fork sends none: the engine in this repository reports to nothing outside it.
See `docs/telemetry.md`.

**Off, as no-ops rather than errors:** Automatic Learning (`learning` is `undefined`, auto-assign
reports `off`), the entitlement check (not run), and the self-host banner (shown only if the operator
set `OPENBOT_SELF_HOST_BANNER`). Memory uses OpenBot's own Postgres tables — that is the whole
implementation now, not a fallback.

## Verified end to end (Phase 3, re-proved in Phase 6c)

`server/tests/local-mode-e2e.integration.test.ts` boots the real `server/src/index.ts` in a child
process against a real Postgres, with only the model (a loopback OpenAI-compatible `LLMock`) and the
Bot's computer (a loopback `/click` stub) stood in. Every assertion reads Postgres or the server's
own log, not memory.

- **A scheduled routine fires and completes.** The real `server/scripts/fire-routines.ts` sweep runs
  in a separate process, posts to `/internal/routines/run`, and the turn completes: the
  `routine_runs` row finishes with no error and the user prompt and assistant reply are in
  `openduet_thread_messages`.
- **An approval-gated action pauses, then resumes.** A routine whose model calls `computer_click` on
  a gated action stops: the `approval_requests` row stays `pending` and the stub computer receives
  **no** request while it waits (the negative control). After an `allow_once` decision over HTTP the
  resume sweep runs the click exactly once, the turn finishes ("The form was submitted."), and an
  `approval.person_decided` audit event records who decided what.

Run it with `TEST_DATABASE_URL=<migrated db> bun test server/tests/local-mode-e2e.integration.test.ts`
(and `server/tests/postgres-platform.integration.test.ts` for the restart/concurrency cases).

Phase 6c additionally proved, against a live Docker Compose sandbox: a real HTTP chat turn, the same
four messages coming back after the server process restarted, a real 409 for a second concurrent run,
a routine firing at its store-computed boundary, and a request that survives a 12 s model silence on
SSE keep-alive frames.

## Known gaps

- **Proactive turns and Bot-to-Bot handoffs have no dedicated local-mode e2e test.** They go through
  the same `createTurnRunner` → Postgres runner/lock path that the routine and approval cases prove,
  and are unit-tested through `createTurnRunner`, but nothing drives them end to end against a live
  server yet.
- **No push-based realtime fan-out.** There is no gateway and no `LISTEN/NOTIFY`: a second tab,
  device or replica sees a run by `connect`, which polls the event log.
- **No ranked/semantic memory recall, no Automatic Learning, no thread auto-naming.**
