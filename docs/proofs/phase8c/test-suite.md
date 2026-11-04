# Phase 8c: test-suite parity

Branch `wip/phase8c-parity-and-close`, HEAD `0fedc47` plus the residue-classification fix.
Bun 1.4.3 (the version `openbot/package.json` pins: `"packageManager": "bun@1.4.3"`).
Every chunk ran alone. A combined run OOM-crashed on 2026-11-02, so the suite stays split.

## Why the suite is split this way

The split follows the workspace layout, so each chunk is one package and each number can be
compared with a package run. A single `bun test` covers all 809 test files and exhausts the
host's memory. The `server/tests` directory also needs its own sharded runner: about a hundred
of those files open a module-scope connection pool, and PostgreSQL's default `max_connections`
is 100, so one process dies with `too many clients already` before it reports anything.

Note on the runner's argument: `bun test <name>` matches a SUBSTRING of the file path. The
command `bun test app` therefore also matched `server/tests/approvals-interactive.integration.test.ts`
and seven other files whose path contains `app`. Those eight files failed with
`TEST_DATABASE_URL must point at a dedicated PostgreSQL test database` because the variable was
unset. That was a harness mistake, not a defect. `bun test app/` with the trailing slash matches
only the `app/` directory, and it passes.

## Per-chunk results

| Chunk | Files | Pass | Skip | Fail | Command | Wall time |
|---|---|---|---|---|---|---|
| `server/` (8 shards) | 422 | 6230 | 19 | 0 | `TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:55432/openbot_test bun scripts/test-server-sharded.ts` | 8 shards |
| `app/` | 282 | 2637 | 0 | 0 | `bun test app/` | 114.54s |
| `agent-computer/` | 46 | 429 | 50 | 0 | `bun test agent-computer/` | 3.20s |
| `agent-langgraph/` | 6 | 40 | 0 | 0 | `bun test agent-langgraph/` | 0.21s |
| `agent-mastra/` | 1 | 34 | 0 | 0 | `bun test agent-mastra/` | 10.28s |
| `agent-bot/` | 1 | 13 | 0 | 0 | `bun test agent-bot/` | 0.11s |
| `shared/` | 19 | 190 | 0 | 0 | `bun test ./shared/` | 0.09s |
| `toolkit/` | 7 | 83 | 0 | 0 | `bun test ./toolkit/` | 0.45s |
| `supervisor/` | 7 | 30 | 1 | 0 | `bun test ./supervisor/` | 0.10s |
| `worker/` | 2 | 19 | 0 | 0 | `bun test ./worker/` | 0.09s |
| `tests/` | 6 | 29 | 5 | 0 | `bun test ./tests/` | 1.04s |
| `scripts/` | 5 | 82 | 0 | 0 | `bun test ./scripts/` | 9.50s |
| `desktop/` | 5 | 162 | 0 | 0 | `bun test ./desktop/` | 10.29s |
| **Total** | **809** | **9978** | **75** | **0** | | |

The file count adds up to every test file in the repository:

```
$ find . -name node_modules -prune -o \( -name "*.test.ts" -o -name "*.test.tsx" \) -print \
    | awk -F/ '{print $1}' | sort | uniq -c
    422 server
    282 app
     46 agent-computer
     19 shared
      7 toolkit
      7 supervisor
      6 tests
      6 agent-langgraph
      5 scripts
      5 desktop
      2 worker
      1 agent-mastra
      1 agent-bot
```

## Real summary lines

```
=== 8 shards: 6230 pass / 0 fail / 19 skip ===

 2637 pass
 0 fail
Ran 2637 tests across 282 files. [114.54s]

 429 pass
 50 skip
 0 fail
Ran 479 tests across 46 files. [3.20s]

 40 pass
 0 fail
Ran 40 tests across 6 files. [213.00ms]

 34 pass
 0 fail
Ran 34 tests across 1 file. [10.28s]

 13 pass
 0 fail
Ran 13 tests across 1 file. [108.00ms]

 190 pass
 0 fail
Ran 190 tests across 19 files. [89.00ms]

 83 pass
 0 fail
Ran 83 tests across 7 files. [454.00ms]

 30 pass
 1 skip
 0 fail
Ran 31 tests across 7 files. [96.00ms]

 19 pass
 0 fail
Ran 19 tests across 2 files. [87.00ms]

 29 pass
 5 skip
 0 fail
Ran 34 tests across 6 files. [1043.00ms]

 82 pass
 0 fail
Ran 82 tests across 5 files. [9.50s]

 162 pass
 0 fail
Ran 162 tests across 5 files. [10.29s]
```

## The historical failures, traced

A run on the pre-merge base (`b5c9223`, before the two merges on this branch) reported six
failures. Each one now passes, or no longer exists, on `0fedc47`:

| Historical failure | Status now | Cause and trace |
|---|---|---|
| `start.sh runtime health > checks the licence and names the Bots without python3` | Test no longer exists | The test asserted the licence gate that Phase 7 removed. `0fedc47` makes the test follow `start.sh`'s own sentence. `scripts/` now reports 82 pass, 0 fail. |
| `(unnamed)` | Not reproducible | The single test that `bun` printed with an empty name came from the same pre-merge `scripts/start-restart-guard.test.ts` file that `0fedc47` rewrote. The file now reports named tests only. |
| `starting the local computer > missing token exits before starting the computer or creating data` | pass | Environment-dependent: it needs a token file that the earlier run did not have. `bun test agent-computer/` reports `(pass)`. |
| `serving port configuration > APP_PORT refuses invalid ports before serving: "1.5"` | pass | Same suite, same run. `(pass)` in `final-dir-scripts.log`. |
| `internal emits actual commit identity and compatible macOS metadata` | pass | Release-metadata test; `git` metadata is present in this worktree. `(pass)`. |
| `release emits actual commit identity and compatible macOS metadata` | pass | Same file. `(pass)`. |

No unexplained red remains. The 75 skips are declared skips inside their own files (50 in
`agent-computer` for live browser/computer tests that need `OPENBOT_LIVE_SCREEN=1`).

## The residue gate was red, and is now green

`sh scripts/check-copilotkit-residue.sh` failed on this branch with 20 unclassified references,
all inside `openbot/scripts/check-artifact-residue.sh` — the artifact checker that 8a added after
`fdc85e8` classified its sibling. The gate was therefore failing on its own new file. This branch
adds that path to the disposition list as `negative-assertion`, which is what the file is: a
checker that asserts the vendor is absent.

```
$ sh scripts/check-copilotkit-residue.sh | tail -12
first-party source references to 'copilotkit': 321
  migration-history    130
  port-attribution     19
  upstream-coordinate  50
  inert-compat         22
  negative-assertion   56
  removal-prose        43
  legal                1
  UNCLASSIFIED         0

PASS: every reference fits a disposition.
```
