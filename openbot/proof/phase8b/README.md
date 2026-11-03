# Phase 8b — live UI behavior proofs

Six behaviors of the first-party runtime, each shown through the companion web app's own UI and
nothing else. The evidence in `docs/proofs/phase8b/` is what these scripts produced; `results.json`
holds each proof's assertions.

## What is live and what is a stub

| Proof | Stack | Model endpoint | Bot computer |
| --- | --- | --- | --- |
| 1 chat turn | `docker-compose.selfhosted.yml` (the 8a recipe, unmodified) | **real** `OPENAI_BASE_URL` + `OPENAI_API_KEY` (an OpenAI-compatible endpoint) | none needed |
| 2 restart durability | same, unmodified | **real** | none needed |
| 3 lock concurrency (409) | 8a recipe + `compose.override.yml` | `model-mock.ts` (the repo's own `server/testing/llmock.ts`) | `computer-stub.ts` |
| 4 routine fire | same override stack | `model-mock.ts` | `computer-stub.ts` |
| 5 approval pause/resume | same override stack | `model-mock.ts` | `computer-stub.ts` (records every call) |
| 6 SSE past the idle timeout | same override stack | `model-mock.ts` | `computer-stub.ts` |

Live in every row: Postgres, the server, the scheduler, the built web app, the run lock, the event
log, the approval store, the routine sweep. Stubbed in rows 3–6: the model endpoint and the Bot's
computer — the same two things an operator supplies in a real deployment. Nothing else is a stub.
Rows 1–2 use no stub at all: they run on the 8a recipe exactly as an operator would run it.

## Stand the stacks up

The real stack (proofs 1–2), 8a recipe, only a model key:

```sh
cd openbot
export OPENAI_API_KEY=...        # and OPENAI_BASE_URL / BOT_MODEL for a non-default endpoint
OPENBOT_PORT=3101 docker compose -f docker-compose.selfhosted.yml -p openduet-8a up -d --build
```

The proof stack (proofs 3–6), the same recipe plus two loopback services:

```sh
cd openbot
OPENAI_API_KEY=proof-key OPENBOT_PORT=3102 docker compose \
  -f docker-compose.selfhosted.yml -f proof/phase8b/compose.override.yml -p openduet-8b up -d --build
```

Finish onboarding once in a browser (`/onboarding` → **Start using OpenDuet**); the driver refuses to
run against an app still on onboarding.

## Run the proofs

```sh
cd openbot/proof/phase8b
python driver.py --base http://127.0.0.1:3101 --out ../../../docs/proofs/phase8b --proof 1
python driver.py --base http://127.0.0.1:3101 --out ../../../docs/proofs/phase8b --proof 2-before
sh restart_companion.sh openduet-8a docker-compose.selfhosted.yml companion
python driver.py --base http://127.0.0.1:3101 --out ../../../docs/proofs/phase8b --proof 2-after
python driver.py --base http://127.0.0.1:3102 --out ../../../docs/proofs/phase8b --proof 3,4,5,6
```

`restart_companion.sh` recreates one service with the values its running container already has, so a
key is never pasted into a proof run and never printed.

## Teardown

```sh
docker compose -f docker-compose.selfhosted.yml -p openduet-8a down -v
docker compose -f docker-compose.selfhosted.yml -f proof/phase8b/compose.override.yml -p openduet-8b down -v
```
