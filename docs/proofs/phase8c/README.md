# OpenDuet self-hosted: project close report (Phase 8c)

The CopilotKit-removal project is complete. A person can now stand up the whole companion on one
machine with one model key, no vendor account and no hosted runtime. This page ties together the
three closing slices and states what is proven, how it was proven, and what an operator must do.

## What the project delivers

- **Zero CopilotKit.** No `@copilotkit/*` package is installed, no built artifact contains the
  name, and no code path opens a connection to `*.copilotkit.ai`. Two checkers prove this: one
  reads the source tree, one reads the built artifact inside the running image.
- **Zero external account.** The old Intelligence entitlement, the hosted runtime, the telemetry
  endpoint, the OAuth app and the mail server are all gone from the boot path. The stack
  generates its own database password and its own at-rest key on first start.
- **One recipe.** `openbot/docker-compose.selfhosted.yml` starts postgres, a one-shot migrator,
  a one-shot key generator, the companion (API plus built web app on one origin) and the routine
  scheduler. `README.md` documents the commands, ports, volumes and teardown.
- **Real behaviour, not curl.** Six properties were driven through the companion's own web UI.

## The recipe, exactly

```
openbot/docker-compose.selfhosted.yml
```

```
mkdir -p ~/openduet && cd ~/openduet
git clone https://github.com/newstex-sparky/openduet-selfhosted.git repo
cd repo/openbot
export OPENAI_API_KEY=sk-...
docker compose -f docker-compose.selfhosted.yml up -d --build
# then open http://127.0.0.1:3001
```

Set `OPENAI_BASE_URL` as well to move the deployment to any endpoint that speaks OpenAI's
`/v1/chat/completions`. Teardown keeps the data: `docker compose ... down`. Teardown deletes it:
`docker compose ... down -v`.

## The six proven behaviours (Phase 8b)

Recorded on disk at `docs/proofs/phase8b/` (30 files, including 7 screenshots and
`results.json`, all entries `ok: true`), driven by `openbot/proof/phase8b/driver.py`.

| # | Behaviour | Evidence |
|---|---|---|
| 1 | A chat turn reaches a real model endpoint and the reply appears on screen | `POST /run` returned 200; `01-chat-turn.png` |
| 2 | A restart does not lose the conversation | the companion container was recreated; marker `RESTART8B-1793729333` was still on screen after restart and after a reload |
| 3 | Two tabs cannot run the same thread at once | the second tab, sent 0.07 s later, got `409 {"error":"Thread lock denied"}`; the holder got 200 |
| 4 | A routine fires on its schedule with nobody at the keyboard | the routine was created in the conversation, `Routines` showed the schedule, and the firing turn appeared 104.5 s later with 0 clicks and 0 keystrokes |
| 5 | A changing action pauses and an operator resumes it | the approval card appeared with 0 clicks delivered, `Allow once` answered 200, exactly one click followed, and the reply resumed |
| 6 | A long model silence does not kill the stream | one `POST /run` stayed open 14.01 s across 14 s of silence, past Bun's 10 s idle timeout; frames at 0, 5, 10, 14 and 14.01 s |

Phase 8b also found and fixed two real defects on the way: the recipe's scheduler never loaded
`KEY_ENCRYPTION_KEY`, so it exited on every start and no routine could ever fire; and a fresh
deployment offers no Routines tools until the first-party plugin is added and granted.

## The test numbers (Phase 8c)

The full suite ran in package-sized chunks, each chunk alone, on bun 1.4.3:

- **809 test files, 10053 tests, 9978 pass, 75 skip, 0 fail.**
- Per-chunk table and the raw summary lines: `docs/proofs/phase8c/test-suite.md`.
- The six failures that a pre-merge run reported are each traced, and each now passes or no
  longer exists (the test asserted the licence gate that Phase 7 removed).
- The residue gate was red on this branch: `check-copilotkit-residue.sh` reported 20 unclassified
  references inside `check-artifact-residue.sh`, the checker 8a added after its sibling was
  classified. This slice classifies that file; the gate now reports `UNCLASSIFIED 0` and
  `PASS: every reference fits a disposition` across 321 references.

## Cleanup (Phase 8c)

38 project containers, 15 networks, 8 volumes, 2 project images, 15 dangling image IDs and
3.165 GB of build cache were removed. A search of every container, network, volume and image name
for this project's patterns returns zero lines. Before and after snapshots and the raw teardown
logs: `docs/proofs/phase8c/docker-cleanup.md` and `docs/proofs/phase8c/evidence/`.

## The one thing an operator must do

**Provide a model API key.** Set `OPENAI_API_KEY` (and `OPENAI_BASE_URL` if the endpoint is not
OpenAI) before `docker compose up`. Nothing else is required: no account sign-up, no entitlement,
no OAuth application, no mail server, no telemetry endpoint, no reverse proxy.
