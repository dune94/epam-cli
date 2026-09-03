# Launch dashboard

A small, separate surface for the non-technical tier: create a run from a Jira ticket id, watch it
in a grid, stop it. Deliberately NOT the operator dashboard (agent-monitor, :8092), which exposes
prompts, costs and agent internals.

Design and the reasoning behind every decision: `change-log/INSTALLER-EXECUTOR-PLAN.md` §5.5.

    frontend/   Flutter web. Dark background, bright green foreground.
    backend/    Node. Zero runtime dependencies: node:http + node:sqlite (Node 22+).

## Why the backend cannot launch a run directly

The backend runs in a container; the pipeline runs on the host. A container cannot exec a host
process, so the backend WRITES A REQUEST to a spool directory and a host-side runner picks it up:

    BE (container) --writes--> /spool/requests/<id>.json
                   <--reads--- /spool/status/<id>.json
                                      ^
    host runner --------------------- ' --launches--> tier3-metrolinx-run.sh

The container never receives host privileges. The runner owns the lock, so "reject while busy" is
enforced where the truth is rather than in the API.

## Running it

    cp .env.example .env      # fill in LAUNCH_PASSWORD
    docker compose up -d      # or: podman compose up -d

    # on the HOST, next to the pipeline — this is the only thing that starts a run:
    node backend/src/runner-host.js --dry     # proves the install, spends nothing
    node backend/src/runner-host.js           # for real

`--dry` walks every path and launches nothing, writing a status that names exactly what it WOULD
have run. Use it before spending anything.

## What the backend guarantees

| | |
|---|---|
| one run at a time | enforced in the store AND by the runner. A UI check is advisory the moment a second tab opens; the runner is the only component that knows a launch is genuinely in flight |
| a stalled run is visible | `updatedAt` is a heartbeat. A row active with no update for 10 minutes turns amber and says so — "pending forever" and "working" must never look the same |
| resume is safe or absent | offered only when the pipeline runId was recorded. A resume without `EPAM_RESUME_RUN` starts a FRESH run, which on a brownfield defect resets the codeline and discards committed work (2026-09-02) |
| replay reproduces | same ticket, same pauses, same CODE LEVEL. A replay against different pipeline code is not a replay; a moved level is recorded on the row |
| the launch environment is built once | `runner-args.js`, tested. Passing these as argv instead of environment is what destroyed a committed fix on 2026-09-02 — the launcher reads them from the environment and ignores argv |
| nothing is guessed | no password, no provider set, no launcher path. Each is declared or the process refuses to start |

## Tests

    node --test backend/test/          # 68 tests, no network, no paid run

Every safety property is mutation-verified: remove the lock and "two runs were launched
concurrently" fires; pass the environment as argv and the test names the exact 2026-09-02 defect.
