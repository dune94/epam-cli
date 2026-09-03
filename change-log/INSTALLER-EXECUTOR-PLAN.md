# Installer + Executor Plan — deploying epam-cli without `/src`

**Status:** PLAN ONLY. Nothing in this document has been built. No pipeline code, script,
template or config was modified while writing it.

**Method note for a skeptical reader.** Every claim below carries `path:line`. Claims that
rest on reading code are marked plainly; claims I could not settle from code are in
[Open Questions](#9-open-questions) rather than asserted. I did **not** run the pipeline, any
`tier3-*-run.sh`, the test suite, or `docker ps`. So statements about *what the code does* are
read-verified; statements about *what happens on this host right now* are not.

---

## 0. Headline findings (read these first)

1. **Most of what the operator asked for already exists and is unfinished.** `install.sh` (repo
   root) and `orchestrations/scripts/pipeline` are already an installer and a one-line executor.
   The plan is largely *finish and fix these two*, not *write two new ones*. Details in §5.
2. **`pipeline --jira AMSD-2041` does not run AMSD-2041.** It exports `JIRA_TICKET`
   (`orchestrations/scripts/pipeline:146`) and **nothing anywhere reads that variable** — a repo-wide
   grep across `orchestrations/` and `src/` returns that single line and no consumer. The ticket
   actually run is whatever the project's `JIRA_JQL` says; for metrolinx that is the literal
   `issue = AMSD-1919` (`orchestrations/projects/metrolinx/config.env:44`), consumed at
   `orchestrations/scripts/lib/jira-client.js:355-359`. **The executor's headline argument is inert.**
   This is the single most important defect for requirement 5.
3. **Docker is genuinely optional for the *run*, and hard-required by the *preflight*.** No service
   in either compose file participates in producing a result. But eight launchers gate on
   `require_preflight`, which fails without the nginx dashboard, Langfuse and Grafana. See §2.
4. **The no-docker path that works today works by accident.** `pipeline` hands off to
   `orchestrate.sh`, which is the *only* launcher with **no** `require_preflight` call — verified by
   grepping all nine `tier*-run.sh` plus `orchestrate.sh`. So it dodges the docker gates by having
   no preflight at all, not by having a docker-optional preflight.
5. **A no-`src` deployment is closer than expected.** All three build-staleness gates already
   no-op when `src/` is absent (§1.2). But `dist/` is gitignored (`.gitignore:5`) and untracked
   (`git ls-files dist` is empty), so the artifact must be built elsewhere and shipped.
6. **Native PowerShell is not viable.** ~52.5k lines of bash carry the launch path, against 33.1k
   of JS and 12.8k of Python — and the bash holds *all* the control flow; node and python are
   one-shot callees. `flock`-on-fd, `setsid`, negative-PID group kill and `/proc/<pid>/environ`
   have no native Windows equivalent. The Windows story is **WSL2**, with a thin `.ps1` front
   door. See §4.
7. **`--dry-run` and `--reset` are inert on the Jira path.** `run-agent-orchestration.sh:3945`
   dispatches `_run_jira_pipeline; exit $?` **before** `parse_orchestration_args "$@"` runs at
   `:4040`. Every metrolinx run sets `JIRA_PIPELINE=1`, so only `--phase` survives (via the
   hand-rolled pre-scan at `:3888-3896`). The `--reset` that `orchestrate.sh:362` and
   `tier3-metrolinx-run.sh:564` both pass is never parsed. **A "validate before spending" executor
   cannot rely on the orchestrator's own dry-run.** See §7 risk 4.
8. **Launching over HTTP needs a new always-on service — a listener started by the orchestrator
   cannot start the orchestrator.** Designed in §7. It is small (~60 of `control-plane.js`'s 233
   lines are reusable scaffolding) but **blocked** on the `JIRA_TICKET` defect: shipped before that
   fix, `POST {"ticket":"AMSD-2041"}` would return `202` naming AMSD-2041 and run AMSD-1919.
   Measured constraint: the launchers' `setsid` re-exec means a spawn returns rc=0 in 0 s before the
   child logs anything, so the service can honestly report `launching`, never `started`.
9. **The HTTP API cannot start a run.** `control-plane.js` is real, wired and test-covered — you
   can pause, resume, redirect and query a run **in flight** from Postman. But no route launches
   one, the `/webhook/jira` chain terminates at a `webhook-prd-*.json` file **nothing reads**, and
   the server only lives for the duration of a run that is already going. On a Jira run the parent
   exits before starting it, so the port is 8095+ per lane, never 8094. Unauthenticated by
   default. Full detail and a Postman-ready example in §6.
10. **A generic, vendor-neutral launcher already exists.** `orchestrations/scripts/tier3-run.sh`
   (181 lines) takes `--project`, `--phase`, `--yes`, `--describe`, resolves the project dir
   (`:36-45`), loads `.env` plus both env halves (`:52-55`), derives `PRD_FILE` (`:60`) — and has
   **no hardcoded vendor key checks**. It is a better delegation target than the nine per-project
   launchers. See §5.2.

---

## 1. Runtime dependency on the CLI

### 1.1 Who invokes `$EPAM_CLI`

`EPAM_CLI` defaults to `epam` at every site (`${EPAM_CLI:-epam}`). Definition sites:

| File | Line | Role |
|---|---|---|
| `orchestrations/scripts/llm-handler.sh` | 13 | default; the only site that **executes** it |
| `orchestrations/scripts/llm-handler.sh` | 400 | `"$EPAM_CLI" run --provider … --json` — the actual call |
| `orchestrations/scripts/claude.sh` | 363 | default |
| `orchestrations/scripts/claude.sh` | 1649-1650 | `provider_to_cli()` maps providers → binary |
| `orchestrations/scripts/claude.sh` | 6377-6378 | diagnostic: warns if `epam` is not on PATH |
| `orchestrations/scripts/lib/agent-invoke.sh` | 312 | passes it into the invocation env |
| `orchestrations/scripts/lib/orch-prompt.sh` | 122 | ditto |
| `orchestrations/scripts/lib/sandbox-invoke.sh` | 63-64, 110 | mounts the repo at `/opt/epam-cli` (docker sandbox only) |
| `run-agent-orchestration.sh` | 1931, 4442, 5110, 5697, 9785, 9900, 9991, 10077 | forwards it to children |
| `contextualize-stories.sh` | 1259; `code-review-cycle.sh` | 135 | forwards it |

**Decisive detail for a claude-only install.** `provider_to_cli()` (`claude.sh:1639-1655`) routes
`copilot|openai|openrouter|cursor|minimax|epam` → `$EPAM_CLI`, but routes `claude` → `claude`
(`:1648`) and `codemie-claude` → `codemie-claude` (`:1642`). The `claude` set's runner is declared
as `claude` in `orchestrations/config/llm-defaults.claude.json` (`runners.claude`); the codemie set's
is `codemie-claude` with `alwaysFlags: ["-s"]`. **So on the claude/codemie stacks the LLM call never
goes through `$EPAM_CLI` at all.** The `epam` binary matters to those stacks only as a PATH
diagnostic (`claude.sh:6377`).

### 1.2 Does anything need `/src` at runtime?

**No — and the guards already handle its absence.** Three separate staleness gates exist:

| Gate | Location | Behaviour with no `src/` |
|---|---|---|
| `build_is_current()` | `orchestrations/scripts/lib/build-freshness.sh:27-34` | **explicit `[ ! -d "$_root/src" ] && return 0`** — designed for this |
| `assert_dist_fresh()` | `orchestrations/scripts/lib/dist-freshness.sh:32-34` | **explicit `[ -d "$repo/src" ] \|\| return 0`** |
| inline check | `preflight-check.sh:436-445` | `find "$REPO_ROOT/src"` errors to `/dev/null`, `_newest_src` is empty, `dist` exists → `ok` |
| inline copy | `tier3-metrolinx-run.sh:214-232` | same shape as above; passes, but **has no `-d src` guard** — it is safe by accident, not design |

Callers: `run-agent-orchestration.sh:364-367` (`assert_dist_fresh`), `preflight-static.sh:56-62`
(`build_is_current`). **Two of the four are deliberate; two are incidental.** The plan should make
all four deliberate (§5.4) so a future edit to the incidental ones does not break no-src installs.

### 1.3 What `dist/` is actually needed for

`package.json:2` declares `main: dist/epam.js`; `package.json:29-32` declares both bins
(`epam`, `epam-cli`) → `./dist/epam.js`. `tsup.config.ts` emits two bundles: `epam` from
`src/index.ts` and `sdk` from `src/sdk.ts`, both CJS, `external: ['keytar']`.

Hard runtime requirements on `dist/`, independent of `$EPAM_CLI`:

- `orchestrations/scripts/lib/agent-roster.js:37` — `require(<repo>/dist/sdk.js)`, and `:45` refuses
  to continue without `FIXED_AGENT_ROLES`.
- `orchestrations/scripts/lib/agent-roster.js:311` — `mintNameVocabulary()` from the same bundle.
- `orchestrations/scripts/spec-mode-runner.js:3700` — throws if the agent-proposal prompt cannot be
  loaded from `dist/sdk.js`.
- `orchestrations/scripts/spec-mode-runner.js:5271` — throws if `FIXED_AGENT_ROLES` is unreadable.

**So `dist/sdk.js` is mandatory on every stack, including claude-only.** `dist/epam.js` is mandatory
only on the openrouter/minimax stacks.

> **Observation about this working tree, not about the design.** `dist/epam.js` is currently 188
> bytes and prints `Hello, World!`. Its source `src/index.ts` is committed in that state (commit
> `b3fc684a`), importing `src/hello.ts`. `dist/sdk.js` is the real 250 KB bundle. I did not
> investigate why; it is called out only because **an installer that verifies `dist/epam.js` merely
> exists would pass on this artifact.** Verification must execute something, not stat a file (§5.1).

### 1.4 Minimum shippable set for a run

Read-verified as required; sizes from `du`:

| Path | Required? | Why |
|---|---|---|
| `dist/sdk.js` | **yes** | `agent-roster.js:37`, `spec-mode-runner.js:3700,5271` |
| `dist/epam.js` (+ bin shim) | yes on openrouter/minimax; PATH-diagnostic only on claude/codemie | `llm-handler.sh:400`; `claude.sh:6377` |
| `orchestrations/scripts/` | **yes** | 143 `.sh` / 52,552 lines; 33,118 JS; 110 `.py` / 12,835. The depth-1 call closure of the 9 launch-path scripts alone is **99 shell files / 45,125 lines** |
| `orchestrations/config/` | **yes** (344 K) | provider sets, ladders, services, contracts |
| `orchestrations/prompts/` | **yes** (608 K) | template layer |
| `orchestrations/agents/` | **yes** (976 K) | profiles, invocation profiles |
| `orchestrations/plugins/` | **yes** (128 K) | loaded by the engine |
| `orchestrations/projects/<one>/` | **yes** | project config; the tree is 162 M because it holds run history |
| `orchestrations/dashboards/` | **only if serving dashboards** (165 M) | see §2 |
| `node_modules/` | **partly** | orchestration JS needs exactly one non-builtin: `jsonrepair` (grep of all `require('<bare>')` across `orchestrations/scripts/**.js` and `orchestrations/plugins/**.js` yields only `jsonrepair` plus node builtins) |
| Python env | **yes** | `orchestrations/scripts/.venv`; `requirements.txt` → `pydantic>=2.0`; `orchestrations/scripts/requirements.txt` → `anthropic>=0.40.0`. 131 `python3` invocations across the launch path |
| `jq` | **yes** | **702 invocations** — `claude.sh` 327, `run-agent-orchestration.sh` 226. jq *is* the engine's JSON layer, plus two standalone programs `lib/jq/checkpoint-merge.jq`, `lib/jq/checkpoint-spec-count.jq` |
| `shellcheck` | **yes** | a hard pre-flight dependency at `preflight-static.sh:45-46` — easily missed by an installer that only checks runtime tools |
| `git` | **yes** | 328 invocations; `lib/git-ops.sh` 46, plus worktree machinery in `lib/eslint-baseline-gate.sh` / `lib/tsc-baseline-gate.sh` |
| `orchestrations/logs/` | created at runtime (735 M here) | must **not** be shipped |
| `orchestrations/cassettes/`, `agent-replies/` | no (6.6 M / 53 M) | rehearsal + history |
| `src/`, `test/`, `coverage/` | **no** | §1.2 |

Three shipped symlinks exist and must survive packaging:
`orchestrations/dashboards/logs -> ../logs`, `…/profiles.json`, `…/prd.json`
(`find . -type l`, excluding `node_modules`/`.venv`/`.git`).

---

## 2. Docker service classification

### 2.1 Verdict

**No docker service is required to produce a pipeline result. Every one of them is a place the
pipeline reports *to*.** The blocker is not the run — it is the preflight layer in front of it.

Compose inventory: `docker-compose.epam-cli.yml` is the full dev stack;
`docker-compose.observability.yml` is the one the pipeline actually references;
`docker-compose.observability.override.yml` adds two bind mounts to `agent-monitor` and is
regenerated each run by `pre-run-reset.sh:119`. **The two main files collide on host port 3001**
(`login-ui` vs `grafana`) — they are alternatives, not a pair.

| Service | Verdict | Evidence | If absent |
|---|---|---|---|
| **agent-monitor** (nginx :8092) | Reporting-only, but **hard-gated at preflight** | serves `orchestrations/dashboards/live` + `/prd-dir`, `/logs-dir` (`docker-compose.observability.yml:104-125`, `orchestrations/dashboards/nginx.conf:20-70`). Nothing POSTs to it — `update-monitor.sh:19-20` writes `logs/agent-status.json` to local disk; nginx only reads. | run unaffected; `preflight-check.sh:330-334, 366-370, 373-377, 413-424` fail |
| **langfuse-server** (:3100) | Reporting-only, hard-gated | `src/observability/LangfuseTracer.ts:21-33` disables itself with no keys; `:59-67` flush in try/catch, "non-fatal"; `lib/langfuse-emit.js:31-45` returns null on missing keys **or** base URL; `lib/cost-record.sh:59-69` backgrounds and silences it | tracing lost; `tier3-metrolinx-run.sh:475-499` and `preflight-check.sh:467-481` `exit 1` |
| **grafana** (:3001) | Reporting-only, hard-gated | `docker-compose.observability.yml:131-158`; only consumers are the two probes at `tier3-metrolinx-run.sh:488` and `preflight-check.sh:467` | nothing functional |
| **clickhouse** (:8123) | Reporting-only, transitive | only a langfuse dependency, `observability.yml:65-66, 80-81` | langfuse dead |
| **postgres** | Reporting-only, transitive | `DATABASE_URL` for langfuse (`observability.yml:61`) and hydra/kratos/backend-stub in the dev stack. No pipeline consumer of :5432 | langfuse dead |
| **redis** | **Unused** | `observability.yml:29-37` has no dependent (the worker that used it was removed). `src/context/RedisSessionStore.ts:5` reads `EPAM_REDIS_URL`, opt-in, never set by the pipeline | nothing |
| **langfuse-worker** | **Dead** | deliberately absent from the observability stack (`observability.yml:93-102`, which records 10,034 crash-loops); still defined in `docker-compose.epam-cli.yml:215-232` | nothing |
| **hydra / hydra-migrate** | **Unused by the pipeline** | `docker-compose.epam-cli.yml:36-69`; the only `hydra` match in `orchestrations/` + `src/` is `hydrateDashboards` (`src/cli/commands/new.ts:17`) — a false match | nothing |
| **kratos / kratos-migrate** | **Unused** | `docker-compose.epam-cli.yml:72-98`; zero references | nothing |
| **login-ui** (:3001) | **Unused** | `docker-compose.epam-cli.yml:101-115`; collides with grafana | nothing |
| **mailhog** | **Unused** | `docker-compose.epam-cli.yml:118-122`; only a kratos dependency | nothing |
| **backend-stub** (:8080) | **Unused by the pipeline** | `docker-compose.epam-cli.yml:125-148`. Port 8080 is `remoteSession` in `orchestrations/config/services.json:29-33`, which no orchestration script calls | nothing |

### 2.2 Confirmed fail-open behaviour

- **Langfuse**: fail-open at every seam. `LangfuseTracer.ts:30-32` gates on both keys;
  `TracedProvider.ts:76-77` uses optional chaining throughout so a null client is a no-op;
  `flushLangfuse` swallows errors (`:59-67`).
- **agent-monitor**: posting is never fatal. `claude.sh:5894-5895` returns 0 if the script is not
  executable; every call site appends `2>/dev/null || true` (`claude.sh:7588-7590, 8351, 8415,
  9838, 9848`, `sync-monitor-stories.sh:70,73`, `brownfield-repro-test-writer.sh:360`,
  `agent-attempt-analyst.sh:196`); `spec-mode-runner.js:8823-8833` resolves on `error` and `close`.
- **pre-run-reset docker step**: `pre-run-reset.sh:199-206` prints "Docker not available … skipping"
  and continues. `lib/pre-run-reset-gate.sh:74-80` states the intent outright: *"a box with no
  Docker must still be able to run the pipeline."*
- **Dashboard rendering is a host process, not a container.** `run-agent-orchestration.sh:2602-2680`
  starts Eleventy locally (`:2648` local binary, `:2662` `npx --prefix`), writing static HTML to
  `orchestrations/dashboards/live`. Every failure path warns and returns; `EPAM_DASH_AUTO_SERVE=0`
  (`:2606-2609`) disables it. **So without docker you lose the HTTP view, not the data.**
  Caveat: `orchestrations/dashboards/node_modules` is **absent** in this tree, so the run takes the
  `npx --prefix` branch, which needs network on first use.
- `preflight-static.sh` — read in full — contains **zero** docker/nginx/grafana/langfuse checks.
  It would pass unchanged on a docker-less box.

### 2.3 Every hard-fail site blocking a no-docker run

All in the preflight/launcher layer; none in the run engine.

| # | Site | Condition |
|---|---|---|
| 1 | `preflight-check.sh:330-334` | `ensure_dashboards_up` (via `lib/dashboard-ensure.sh:66-71` → `dashboard-health-check.sh --fix`) |
| 2 | `preflight-check.sh:366-370` | `curl -sf $DASH/logs/healing-events.jsonl` |
| 3 | `preflight-check.sh:373-377` | `build-info.json` must contain `metrics.selfHealing` |
| 4 | `preflight-check.sh:413-424` | `build-info.json` `generatedAt` younger than 120 s |
| 5 | `preflight-check.sh:405-409` | `snapshot-watch.js` must be running (host process, not docker) |
| 6 | `preflight-check.sh:476-478` | langfuse **and** grafana must not return `000` |
| 7 | — | any `fail` → `preflight-check.sh:491-492` `exit 1` → `lib/preflight.sh:34-42` → all eight launchers (`tier3-metrolinx-run.sh:553`, `tier3-paid-run.sh:69`, `tier3-mock-run.sh:302`, `tier2-free-run.sh:71`, `tier1-mock-run.sh:94`, `tier1-ollama-run.sh:64`, `tier3-travel-app-run.sh:378`, `tier3-skyscanner-app-run.sh:412`) |
| 8 | `tier3-metrolinx-run.sh:475-499` | independent observability preflight, `exit 1` on non-2xx/3xx |
| 9 | `run-agent-orchestration.sh:4078-4081` | `exit 1` if neither docker nor podman on PATH — **only under `--sandbox`** |
| 10 | `cassette-export.js:21-26` | throws without Langfuse keys; rehearsal tooling only |

Existing escape hatches, all documented in-file:
`EPAM_PREFLIGHT_ENVIRONMENT=0` (`preflight-check.sh:315-320`, skips 1-6),
`EPAM_PREFLIGHT_SKIP_NETWORK=1` (`:466`, skips 6),
`OBSERVABILITY_PREFLIGHT=0` (`tier3-metrolinx-run.sh:475`, skips 8),
`EPAM_SKIP_CONTAINER_RESTART=1` (`pre-run-reset.sh:197`),
`EPAM_DASHBOARD_NO_FIX` (`lib/dashboard-ensure.sh:60`).

Note `lib/preflight.sh:38-39` claims the preflight is "deliberately not skippable by an env var".
That is true of `require_preflight` itself; the machine-environment checks **inside** it are each
individually skippable. Worth reconciling — the comment currently overstates the guarantee.

### 2.4 What must change, conceptually, for a supported no-docker run

1. **Make the preflight mode-aware instead of env-flag-aware.** The install writes a declared mode
   (`with-docker` / `without-docker`). In `without-docker`, checks 1-6 and 8 are **not skipped
   silently** — they are reported as `n/a (no-docker install)`. A skipped check that prints nothing
   is how a gate becomes decoration.
2. **Separate "the dashboard data exists" from "the dashboard is being served."** Checks 2-4 assert
   things about HTTP endpoints that are really assertions about files on disk
   (`orchestrations/dashboards/live/build-info.json`). In no-docker mode assert the file; in
   docker mode assert the URL. Same guarantee, different transport.
3. **Give `orchestrate.sh` a preflight.** It has none. Today the no-docker path works because the
   only launcher without docker gates is also the only launcher without gates. That is not a
   property to build on.
4. **Fold the four staleness gates onto `lib/build-freshness.sh`** so the two accidental no-src
   passes become deliberate.
5. **Delete or quarantine the unused half of `docker-compose.epam-cli.yml`** (hydra, kratos,
   login-ui, mailhog, backend-stub, langfuse-worker) from the *installer's* view — the installer
   should never offer to start a service nothing consumes, and the 3001 collision makes offering
   both files actively harmful.
6. **Reconcile the compose file `dashboard-health-check.sh` restarts.** It targets
   `docker-compose.epam-cli.yml:23` while `pre-run-reset.sh:52` uses
   `docker-compose.observability.yml` — see Open Questions.

### 2.5 DECISION (2026-09-03, annotated against tag v1.6)

**Decided: one script owns every docker verb; preflight asks for an OUTCOME, not a transport;
the installer writes a declared mode.** This supersedes the loose "gate it on an env var" idea —
see the caveat at the end, which is the whole reason for the shape.

#### What already exists (verified at v1.6, not assumed)

| piece | state |
|---|---|
| `lib/dashboard-ensure.sh` → `ensure_dashboards_up` | **the seam already exists**; `preflight-check.sh:330` calls it rather than docker |
| `dashboard-health-check.sh` | already the only script that runs `docker ps` / `docker compose restart` |
| `preflight-check.sh` checks 2, 3, 4 | **leak** — they `curl` the dashboard directly, bypassing the seam. This is what makes preflight docker-aware |
| compose file split | `dashboard-health-check.sh:23` uses `docker-compose.epam-cli.yml`; `pre-run-reset.sh:52` uses `docker-compose.observability.yml`. Two scripts, two files, one intent (§2.4 item 6) |
| engine | `claude.sh`, `orchestrations/plugins/`, `src/` contain **zero** docker references |

So this is consolidation, not new construction. The seam is half-built and leaks in three places.

#### The design

**1. One script, one compose file, every docker verb.**
`up` / `health` / `restart` / `down`. Nothing else in the tree invokes `docker`. Fixing the
two-compose-file split (§2.4 item 6) falls out of this rather than being separate work.

**2. Preflight asks for an outcome; the mode decides the transport.**
Checks 2-4 currently ask "does `$DASH/build-info.json` return fresh JSON over HTTP". The real
question is "is the dashboard data fresh", and that data is a FILE that a HOST process
(`snapshot-watch.js`) writes to `orchestrations/dashboards/live/build-info.json`. So:

    with-docker     -> the docker script answers over HTTP
    without-docker  -> the same check asserts the file on disk

Same guarantee, different transport. Note this also means check 5 (`snapshot-watch.js` running)
belongs in BOTH modes — it is a host process and has nothing to do with docker. It was listed with
the container checks in §2.3; that grouping is wrong and the packaging work should split it out.

**3. The installer writes the mode and provisions accordingly.**
`--with-docker` builds and starts the services and records `with-docker`; otherwise it records
`without-docker` and never offers them. Per §2.4 item 5 the installer must not offer the unused
half of `docker-compose.epam-cli.yml` (hydra, kratos, login-ui, mailhog, backend-stub) at all —
and because the two compose files **collide on host port 3001**, offering both is actively harmful.

#### THE CAVEAT THAT DRIVES THE SHAPE

**A flag that makes checks vanish is how a gate becomes decoration.** In `without-docker` the
container checks must report `n/a (no-docker install)` — never print nothing. On 2026-09-02/03 this
pipeline produced three separate defects whose only symptom was a check that quietly did nothing:

  - `_project_owned_test_files` returned empty for every story ever (argv off by one), so
    verification silently ran the whole suite
  - the baseline gate deleted its cache and continued with no subtraction
  - the reviewer could not run at all and returned no verdict for eight cycles

Each looked exactly like "nothing to report". A skipped check that prints nothing is
indistinguishable from a passing one, and that is the failure mode this install mode must not
reintroduce. See [[feedback_no_silent_failure_mechanisms]] and
[[feedback_a_gate_must_have_its_verdict_read]].

#### Still open, carried from §2.3

`lib/preflight.sh:38-39` claims the preflight is "deliberately not skippable by an env var", while
checks 1-6 are individually skippable via `EPAM_PREFLIGHT_ENVIRONMENT=0`. The mode work is where
that contradiction gets reconciled — a declared mode is honest, an env var that silently disables
six checks is not.

---

---

## 3. Config surface for a one-line executor

### 3.1 How configuration is layered (read-verified)

`orchestrate.sh` loads, in order: `.env` at repo root (`:107` `load_env_file_safe`), then the
project env (`:108`), then `SECRETS_FILE` if declared (`:110-118`), then the project env **again**
so it wins (`:117`).

The project env is **two files**, resolved from config, never named in code:
`load_project_env()` (`lib/env-file.sh:110-149`) asks `lib/llm-settings-resolve.js` for the pair.
`provider-sets.json.projectEnv` declares `base: config.env` and `overlay: config.{set}.env`,
and states they **must be disjoint**. `metrolinx` ships all five overlays
(`config.claude.env`, `config.codemie.env`, `config.mockserver.env`, `config.openrouter.env`).

Credentials are **declared per stack, not per project**:
`orchestrations/config/provider-sets.json` gives `openrouter` two required credentials
(`OPENROUTER_API_KEY`, `MINIMAX_API_KEY`) and gives `claude`, `codemie` and `mockserver`
**`credentials: []`** with explicit reasoning. `lib/set-credentials.sh` reads that declaration:
`set_required_keys()` (`:58-68`) returns the required source vars, `export_set_credentials()`
(`:47-54`) exports only the active set's keys. `orchestrate.sh:161-167` unions that with the
project's own `REQUIRED_KEYS` and fails on any that is empty.

**On the claude set, `set_required_keys()` returns the empty string.** metrolinx's own
`REQUIRED_KEYS=JIRA_TOKEN` (`config.env:16`) is then the entire requirement. This is exactly the
mechanism a claude-only installer needs, and it already works.

`EPAM_PROVIDER_SET` has exactly four consumers: `lib/llm-settings-resolve.js:67` (which **throws**
on an unknown set at `:70-75` and on a declared-but-missing settings file at `:85-89`), its
`projectEnvFiles()` (via `lib/env-file.sh:110-149`), `lib/set-credentials.sh:29` and
`lib/spend-probe.sh:19`. **A claude-only or codemie-only install needs exactly one variable —
`EPAM_PROVIDER_SET=claude`, or nothing at all since it is the default — plus `JIRA_EMAIL` and
`JIRA_TOKEN` for ingest. No LLM API key whatsoever.**

**Jira ingest requirements** (`ingest-jira-tickets.sh`, 250 lines): `--out-prd` is required
(exit 2 at `:46-52`); `:81-85` requires `JIRA_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` (exit 1); `:111-118`
requires `JIRA_CODELINE_ROOT` to be set **and to exist** in brownfield mode. `--project` defaults
to `${JIRA_PROJECT_KEY:-SKY}` (`:40`) and `--status` to `"To Do"` (`:41`).

Two further hard requirements the executor must check, both easy to miss:
`preflight-check.sh:455-458` **fails if `PROJECT_NAME` is unset** — even though
`run-agent-orchestration.sh` never reads it (identity comes from `PROJECT_ROOT`, `:318-348`); and
`run-agent-orchestration.sh:441-444` exits on an unknown `EPAM_ORCHESTRATION_PROVIDER` (valid:
`openrouter|openai|copilot|cursor|codex|codemie-claude|claude`).

**A stale-value trap worth designing around.** `.env` declares `EPAM_ORCHESTRATION_PROVIDER`, and
`.env` is loaded in preserve mode, so a value there can outlive a stack swap that the overlay was
supposed to decide. `tier3-mock-run.sh:155` documents exactly this happening. **The installer should
not write provider variables into `.env` at all** — they belong to `config.<set>.env`.

### 3.2 Classification

| Variable | Class | Source / evidence |
|---|---|---|
| `JIRA_TOKEN` | **user-supplied secret** | `metrolinx/config.env:19` `REQUIRED_KEYS`; lives in `SECRETS_FILE` |
| `JIRA_EMAIL` | **user-supplied** | `orchestrations/jira/metrolinx.env` |
| `JIRA_URL` | **user-supplied, site-specific** | `metrolinx/config.env:41` |
| `JIRA_PROJECT_KEY` | **user-supplied** | `config.env:43`; also the executor's prefix→project map (`pipeline:59-67`) |
| `JIRA_CODELINE_ROOT` | **user-supplied, machine-specific** | `config.env:69` — currently the absolute `/home/bradleyjerome/projects/metrolinx` |
| `JIRA_BASELINE_BRANCH` | user-supplied (defaultable to `main`) | `config.env:~86` (`develop` here) |
| `JIRA_JQL` | **should be executor-derived; is currently hardcoded** | `config.env:44` = `issue = AMSD-1919`; consumed `jira-client.js:355` |
| `JIRA_FIELD_EPIC_LINK`, `JIRA_STATUS_*`, `JIRA_ISSUE_TYPES` | user-supplied, tenant schema | `config.env:52-66` |
| `EPAM_PROVIDER_SET` | **defaulted** | `provider-sets.json.defaultSet` = `claude`; `pipeline:99-103` reads it |
| `OPENROUTER_API_KEY`, `MINIMAX_API_KEY` | **required only on the `openrouter` set** | `provider-sets.json.sets.openrouter.credentials` |
| `ANTHROPIC_API_KEY` | **must NOT be set on the claude set** | `llm-defaults.claude.json.runners.claude.unsetEnv` scrubs it; the file records seven runs billed to the wrong account. It is nonetheless present in this repo's `.env` |
| `LANGFUSE_*` | optional | §2.2 fail-open |
| `PRD_FILE` | **derived** | `orchestrate.sh:157` defaults to `$PROJECT_DIR/prd.json`; the only entry in `config/preflight-required-env.json.required` |
| `OUTPUT_DIR`, `PROJECT_ROOT` | **derived per lane** | `preflight-required-env.json.advisory` |
| `EPAM_PHASES` | defaulted | `orchestrate.sh:170` → `core` |
| `EPAM_BROWNFIELD`, `EPAM_BRANCH_PREFIX`, `EPAM_MULTI_CODELINE_STORIES`, `TZ`, `EPAM_PROMPT_PROVISION_MODE`, `EPAM_PAUSE_*` | project facts, defaultable | `metrolinx/config.env` |
| `ORCH_GATE_PROVIDER`, `EPAM_ORCHESTRATION_PROVIDER`, `SPEC_MODE_PROVIDER`, `EPAM_FINAL_FALLBACK_PROVIDER`, `EPAM_MODEL_PROVIDER_MAP` | **set-derived** | all four values are `claude` in `config.claude.env`, `codemie-claude` in `config.codemie.env` |
| model pins (`ORCH_GATE_MODEL`, `ESCALATION_MODEL*`, `SPEC_MODE_*_MODEL`) | **derived — do not set** | commented out throughout `config.env` with the reason: "the ladder is the source of truth" |
| `NODE_BIN` | derived | `orchestrate.sh:145` |

`.env` at repo root currently declares (names only): `ANTHROPIC_API_KEY`, `EPAM_API_KEY_CLAUDE`,
`EPAM_ORCHESTRATION_PROVIDER`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `LANGFUSE_BASE_URL`,
`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `MCP_CONFLUENCE_URL`, `MCP_DRAWIO_URL`,
`MCP_JIRA_URL`, `MINIMAX_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `RAPIDAPI_KEY`.
`.env.example` declares only five of these and **none of the Jira variables** — it is stale
relative to what a run needs.

### 3.3 The `MINIMAX`/`OPENROUTER` hard-require (documented, not fixed)

`orchestrations/scripts/tier3-metrolinx-run.sh:153-154`:

```
[ -z "${MINIMAX_API_KEY:-}" ]    && fail "MINIMAX_API_KEY is not set. Export it or add it to .env"
[ -z "${OPENROUTER_API_KEY:-}" ] && fail "OPENROUTER_API_KEY is not set. Export it or add it to .env"
```

These are **unconditional** — not gated on `EPAM_PROVIDER_SET`, not gated on anything. The launcher
then exports them at `:326-329`. Grepping that file for `set-credentials`, `export_set_credentials`
and `set_required_keys` returns **nothing**: this launcher predates and bypasses the set-driven
credential library entirely.

**Consequence for the plan:** a claude/codemie-only install must not require these. Two options,
both plan-level:

- **(a) Preferred — do not ship `tier3-metrolinx-run.sh` in a no-src install.** The `pipeline` →
  `orchestrate.sh` path already does the right thing via `set_required_keys()`. Nine tier launchers
  are nine parallel implementations of one job.
- **(b) If it must ship** — replace `:153-154` with the `set_required_keys()` union already used at
  `orchestrate.sh:161-167`, and delete the unconditional exports at `:326-329` in favour of
  `export_set_credentials`. Note the exports are not merely untidy: `provider-sets.json` records
  that a stray key **outranks** the OAuth session, which is how seven runs were billed wrongly.

**Not fixed here, per instruction.**

---

## 4. Cross-platform

### 4.1 Where the logic lives

| Layer | Files | Lines |
|---|---|---|
| Shell, whole tree | 143 | **52,552** |
| Shell, depth-1 closure of the 9 launch-path scripts | ~99 | 45,125 |
| JS, whole tree | — | 33,118 |
| Python (excl. venv) | 110 | 12,835 |

The two largest single files are shell: `claude.sh` (12,330 lines) and
`run-agent-orchestration.sh` (10,839) — 23,169 lines of bash holding the control flow, the gates,
the ladder, the retry logic and the PRD mutations.

**The node and python layers are callees, not drivers.** In `lib/` it is 58 `.sh` / 9,335 lines
against 57 `.js` / 13,269 — near line-parity, which makes "JS is half the logic" a tempting and
wrong reading. The `.js` files are invoked as one-shot subprocesses from bash, e.g.
`run-agent-orchestration.sh:2855` `mapfile -t _cl_entries < <("$NODE_BIN" … cl-entries.js …)`.
The TypeScript side confirms the direction of dependency: `src/cli/commands/orchestrate.ts:33` and
`src/cli/repl/commands/OrchestrateCommand.ts:280` both *spawn*
`orchestrations/scripts/run-agent-orchestration.sh`. **Shell is 53% of lines and 100% of the
orchestration control flow.** A native PowerShell port is not a porting job, it is a rewrite.

> Naming note: `orchestrations/scripts/claude.sh` is **not** a wrapper around the `claude` binary.
> It is the 12k-line story-implementation engine that happens to share the name. The binary is
> reached via `CLAUDE_CMD` (`llm-handler.sh:14`, default `claude`), invoked at
> `llm-handler.sh:296,306` and `claude.sh:10501,10531`, with the `codemie-claude` branch at
> `llm-handler.sh:310-326` and `claude.sh:10167` calling that binary by literal name. Those call
> sites pass `--print --output-format json --dangerously-skip-permissions`; the installer's
> auth-verification round-trip (§5.1) should use the same flags so it exercises the real path.

### 4.2 Constructs with no native Windows equivalent

| Construct | Sites | Native PowerShell? |
|---|---|---|
| `setsid` re-exec | `orchestrate.sh:93-95`, `run-agent-orchestration.sh:210-212`, and every `tier3-*-run.sh` (e.g. `tier3-metrolinx-run.sh:53-55`) | **No.** Guarded by `command -v setsid`, so it degrades — but the guarantee it buys is lost |
| process-group kill `kill -- -$PGID` | `kill-tier3-run.sh:70-76`, using `ps -o pgid=` (`:64`) and `pgrep -af` (`:89`) | **No.** Windows has job objects, not process groups; `kill-tier3-run.sh` would need a full rewrite |
| `flock` on a shared fd — the **only** concurrency primitive | 29 sites in the launch path: `tier3-metrolinx-run.sh:525`, `run-agent-orchestration.sh:1205,5827,6716,7177,8338,9917`, `claude.sh:992,2123,2148,6449,7948,7984,8026,8063,10829,11059,11218,11332`, `lib/story-guards.sh:520`, `lib/cost-record.sh:39`. Idiom: `( flock -w 10 200 \|\| …; … ) 200>lockfile` guarding PRD/profiles/JSONL writes | **No.** .NET has file locks but not the `200>lock` subshell-fd idiom. Not in Git Bash either |
| `/proc/<pid>/environ` | `kill-tier3-run.sh:110-115` iterates `/proc/[0-9]*`, reads each `environ` and matches `ORCH_RUN_ID=` to find **orphaned billing processes**. There is no `ps`-only fallback | **No equivalent at all.** Windows exposes command lines via WMI but not per-process environment blocks without debug-level APIs |
| `/proc/$PPID/cmdline` | `llm-handler.sh:204-216`, to derive `EPAM_AGENT_NAME` from the calling script | **No** |
| POSIX signals | `TERM`/`KILL` distinction, `kill -0` liveness, `trap … EXIT` at `orchestrate.sh:122`, `tier3-metrolinx-run.sh:81`, `llm-handler.sh:220`, `run-agent-orchestration.sh:25,4016,4777` | **No.** Windows has no SIGTERM |
| process substitution `<(cmd)` | **85 sites** — depends on `/dev/fd` | **No.** Every site becomes a temp file or a restructure |
| `chmod a-w` as the **write perimeter** | `lib/codeline-write-perimeter.sh:114` (`chmod a-w`) / `:130` (`chmod u+w`); `:157` states "the gate is enforced with chmod below the tool layer". Also `orchestrate.sh:228,233,259`, `pre-run-reset.sh:142` | **No.** NTFS ACLs are not mode bits — the *semantics of the safety guarantee* change, not just the syntax |
| `timeout` | 105 hits, some with GNU-only flags (`lib/agent-invoke.sh:302` `--signal=TERM --kill-after=30`) | Git Bash ships it; not native PS |
| bash 4+ | `mapfile -t` ×10 (9 of them combined with `<(…)`), `declare -A` ×3 (`run-agent-orchestration.sh:674-676`), herestrings `<<<` ×97, indirect `${!…}` ×28, `BASH_SOURCE` ×110, `${var^^}` at `pipeline:64` | n/a — needs bash regardless |
| `python3` handlers | **88 `.py` handlers** in `lib/handlers/` (6,024 lines) vs 46 `.js`. 131 invocations: `run-agent-orchestration.sh` 66, `claude.sh` 32, `preflight-check.sh` 9, `orchestrate.sh` 5 | Python is cross-platform; the *shelling out* is not |
| symlinks | 3 shipped (`orchestrations/dashboards/{logs,profiles.json,prd.json}`); created at runtime by `lib/codeline-health.sh:98` and `lib/eslint-baseline-gate.sh:257` | Windows needs Developer Mode or admin; git may materialise them as text files |
| absolute `/home/...` paths | **Only three in shipped config**: `metrolinx/config.env:69`, `mock3/config.env:29`, `skyscanner/config.env:10`. In *script* code there is exactly one (`lib/sandbox-invoke.sh:114` `HOME=/home/agent`, container-internal). Plus the `epam` shim (`~/.local/bin/epam` → `exec node /home/bradleyjerome/…/dist/epam.js`) | rewritten at install time — a small, contained job |
| `/tmp` | 153 hits (`run-agent-orchestration.sh` 72, `claude.sh` 48); `kill-tier3-run.sh` globs `/tmp/tier3-*.pid` | present under WSL; absent natively |

**The shape of the obstacle matters for the plan.** The code is *not* riddled with hardcoded host
paths — the portability problem is POSIX process and IPC semantics, not environment assumptions.
That is why a Git Bash / MSYS route fails too: it fails on the same process-group and `/proc` items,
not on paths, so "just add Git Bash" is not a cheaper alternative to WSL.

### 4.3 Conclusion for requirements 3 and 6

**WSL2 is mandatory on Windows. PowerShell is a front door, not a runtime.** Concretely:

- `install.ps1` — checks/installs WSL2, checks the distro, then **invokes `install.sh` inside WSL**.
  It also handles the genuinely Windows-side parts: PATH shim, Developer Mode for symlinks, Docker
  Desktop with the WSL2 backend if `with-docker`.
- `run-pipeline.ps1` — a thin wrapper: `wsl -d <distro> -- bash -lc "…/run-pipeline <TICKET>"`,
  forwarding exit code and streaming stdout.

The alternative — Git Bash without WSL — fails on `flock` (33 sites) and on `kill-tier3-run.sh`
entirely. **I would not represent Git Bash as supported.** Note also that the `setsid` guard means a
Git Bash run would *start* and only lose killability, which is the worst failure mode: it looks
supported until you need to stop it.

### 4.4 DECISION — THE RUNTIME IS ALWAYS LINUX (2026-09-03, against tag v1.6)

**One rule: the pipeline runs on Linux everywhere. Only the front door changes per platform.**

| Platform | Runtime | Front door |
|---|---|---|
| Linux / WSL2 Ubuntu | native | `install.sh` |
| Windows | **WSL2** (mandatory, §4.3) | `install.ps1` -> checks/installs WSL2, then calls `install.sh` inside it |
| **macOS** | **a Linux VM / partition** | the Mac-side script provisions it, then calls `install.sh` inside it |

npm installs cleanly on all three — the package is not the problem. The RUNTIME is, because the
pipeline is bash and POSIX process semantics, not Node.

#### Why macOS cannot run this natively — measured in this tree at v1.6

    flock        49 sites    not present in macOS base at all
    /proc/       20 sites    DOES NOT EXIST on macOS, and has no equivalent
    setsid       29 sites    not present in macOS base
    mapfile      34 sites    require bash 4+; macOS ships bash 3.2
    declare -A   22 sites    same
    process sub 110 sites    fine under bash 4

The bash-4 and `timeout` items are a `brew install bash coreutils` away. `flock`, `setsid` and
`/proc` are not. `kill-tier3-run.sh` reads `/proc/<pid>/environ` to find orphaned BILLING processes
and `llm-handler.sh:204-216` reads `/proc/$PPID/cmdline` to derive the agent name — there is no
macOS port of that, only a rewrite.

So macOS is the SAME SHAPE as native Windows, and gets the same answer: do not run it natively,
run it in Linux.

#### The Apple Silicon nuance, stated so nobody hits it late

On Intel Macs a Linux partition is literal. **On Apple Silicon it is a VM** — UTM, Lima/Colima, or
Parallels — because those machines do not dual-boot Linux the way Intel ones did. Same principle,
different mechanism, and the install guide must say so plainly. The failure mode otherwise is an
operator `brew install`-ing their way toward a native Mac run and discovering `flock` three hours
in, which is exactly the class of late, silent surprise this packaging work exists to remove.

Note the Docker tension: a Linux VM is a reasonable macOS answer, but it must not be confused with
the `with-docker` / `without-docker` install mode (§2.5). The VM is the RUNTIME; docker inside it is
still optional. A Mac user choosing `without-docker` still needs the Linux VM.

---

---

## 5. The proposed design

### 5.0 Packaging strategy

§5.1 says "build on `install.sh`" but says nothing about how the thing being installed is
*produced*. This section answers that. It matters more than usual here because **the artefact is
client-facing and the working tree currently contains live credentials** (§5.0.6).

#### 5.0.1 Build — the manifest must be a declaration

**No suitable declaration exists today. One must be added.** What was checked:

| Candidate | Verdict |
|---|---|
| `package.json:20-23` `files: ["dist/", "TOOL_REGISTRY.md"]` | **Insufficient.** Covers the CLI bundle only. Nothing under `orchestrations/` — which is ~9 MB of the ~10 MB payload (§5.0.7) — is named |
| `.npmignore` | **Does not exist** (`ls`: No such file) |
| `orchestrations/config/repo-artifacts.json` | **Wrong semantics — do not overload.** Its own `$comment` scopes it to "editor and operating-system droppings, and engine state that must never reach a **client repository**". `enginePaths` lists `orchestrations/logs/*` etc. for exclusion from *agent diffs in the customer's repo*. That is a different question from "what ships in the engine's own release", and the `$biasComment` sets a bias — "a directory wrongly EXCLUDED loses real agent work silently" — that is the **opposite** of the bias a release manifest needs, where wrongly *including* a secret is the severe outcome. Two different biases cannot share one list |
| `orchestrations/config/engine-layout.json` | **The right precedent, wrong scope.** It declares where engine things live, repo-relative, with a per-entry `env` override, and its `$comment` records the exact lesson ("A path written into engine code is a fact the engine cannot be told, and this is the file it is told in"). It currently declares one entry, `promptTemplates`. The release manifest should follow this file's *shape*, and may reasonably live beside it |
| `.gitignore` | Useful as a **cross-check**, not as the manifest — it is an exclusion list for source control, and §5.0.6 shows the two lists agree on secrets but not on intent |

**Proposal: a new `orchestrations/config/release-manifest.json`**, declaring `include` (path globs),
`exclude`, `templated` (files shipped as `.template` with placeholders — §5.0.6), `runtimeDirs`
(created empty at install), and `symlinks` (§5.0.3). The build script then contains **zero paths**:
it reads this file, resolves globs, and writes the tree. Adding a project, a prompt directory or a
plugin becomes a config edit, per the standing rule that a project-specific fact lives in config or
a plugin and nowhere else.

**The build should be `git archive`-based, not `cp -r`-based.** This is not a style preference —
it is the primary secret control. Every file carrying a live credential is untracked
(`git ls-files orchestrations/jira/` returns only `.env.example`, `docker-compose.yml`, `setup.sh`),
so `git archive` **cannot** emit them, while `cp -r` or a bare `tar` of the working tree emits all
of them. Two required exceptions must be layered on top, because both are gitignored:
`dist/` (`.gitignore:5`, and `git ls-files dist` is empty) and the pruned `node_modules`. Those are
added explicitly, from a clean build, never swept in.

Build steps, in order: clean checkout at a tag → `npm ci` → `npm run build` → prune
`node_modules` to the runtime closure → `git archive` the declared `include` set → overlay `dist/`
and the pruned modules → strip source maps (§5.0.7) → template the config files → generate the
checksum manifest → create the archives.

#### 5.0.1b DECISION — npm IS the packaging format (2026-09-03, against tag v1.6)

**"Tarball or npm" is a false choice: `npm pack` produces a tarball.** The artefact is
`epam-cli-<version>.tgz`, installed offline with `npm install -g ./epam-cli-<version>.tgz`. No
registry, no network for the package itself, and npm semantics for free.

##### What npm gives us, verified at v1.6 rather than assumed

| | evidence |
|---|---|
| `epam` on PATH with no wiring | `package.json` already declares `bin: {epam, epam-cli} -> ./dist/epam.js` |
| **no `node_modules` shipping or pruning** | 29 runtime deps; npm resolves them at install. This deletes an entire open question from §5.0.1 |
| version, integrity, upgrade, uninstall | built in |
| identical on PowerShell and WSL | npm behaves the same on both |
| gitignored secrets excluded | npm falls back to `.gitignore` when no `.npmignore`; `.env` and `orchestrations/jira/.env` are both ignored (checked) |

##### THE BLOCKER, MEASURED: npm pack SILENTLY DROPS SYMLINKS

Run in a scratch package with a file symlink and a directory symlink, both listed in `files`:

    created:  ./link.txt -> sub/target.txt      ./dirlink -> sub
    tarball:  package/package.json
              package/sub/target.txt
    result:   link.txt : MISSING from package
              dirlink  : MISSING from package

**Not followed, not converted — absent, with no warning.** (For contrast, plain `tar czf`
preserves symlinks as symlinks; that was measured too, §5.0.3.)

This is not academic. The three shipped symlinks are how the dashboard reads live data:

    orchestrations/dashboards/logs          -> ../logs
    orchestrations/dashboards/profiles.json -> ../agents/profiles.json
    orchestrations/dashboards/prd.json      -> ../prd.json

Ship via npm unchanged and the dashboard renders nothing, with no error — the exact silent-failure
shape being removed everywhere else in this pipeline.

##### The resolution: DECLARE the symlinks, do not ship them

`release-manifest.json` already proposes a `symlinks` section (§5.0.1). The installer creates them
as a post-install step. Nothing is lost; the manifest becomes the source of truth instead of the
archive, which is the better property anyway — a symlink in a tarball is invisible to review, a
symlink in a manifest is not.

The installer must then VERIFY each link resolves and fail loudly if not. An absent dashboard
symlink and a broken one look identical from the HTTP side.

##### Two conditions before this is safe

1. **`files` must be extended.** It is `["dist/","TOOL_REGISTRY.md"]` today, which ships **none** of
   `orchestrations/` — the pipeline itself. This is what makes the manifest-driven build (§5.0.1)
   mandatory rather than tidy: `files` is generated from `release-manifest.json`, never hand-listed.

2. **npm packs from the WORKING TREE, not from git.** The `git archive` guarantee in §5.0.1 — that
   an untracked credential file physically cannot be emitted — is LOST with npm. Gitignored files
   are still excluded, but an untracked-and-unignored file WOULD ship. Required mitigations:
   build from a clean checkout of the tag, and gate the release on `npm pack --dry-run` output
   being diffed against the declared manifest, failing on any file the manifest does not name.

   Note `orchestrations/projects/metrolinx/config.env` is TRACKED and ships either way. It carries
   no credentials (it points at a separate `SECRETS_FILE`) but does carry a client Jira URL, a
   project key, and a machine path `JIRA_CODELINE_ROOT=/home/...`. It is a TEMPLATING candidate,
   not a secrecy one.

#### 5.0.2 Versioning

**Two version sources exist and they disagree.** `package.json` declares `version: 0.1.0`, while
the repo carries 8 git tags running `v1.1`…`v1.5`, and `change-log/DEVIATIONS-FROM-v1.5.md` treats
v1.5 as the meaningful line. `git describe --tags --always --dirty` currently returns
`backup/head-20260827T230237Z-234-ge550bc3e-dirty` — it resolves against a *backup branch* tag, so
it is not usable as-is for a release identifier.

Recommendation: **the annotated git tag is the source of truth**, `package.json` is derived from it
at build time (not hand-edited), and `git describe --tags --match 'v*'` is used so backup tags
cannot be picked up. A release must refuse to build from a dirty tree or an untagged commit —
otherwise the installed version string names a commit that does not exist anywhere.

The installed tree records its identity in `install-manifest.json` at the release root: version,
git SHA, tag, build timestamp, builder host, docker mode, stack, the checksum-manifest digest, and
the `release-manifest.json` digest the tree was built from. `install.sh --check` verifies against
this file rather than re-deriving anything.

#### 5.0.3 Integrity — and the symlink traps, which are real

A `SHA256SUMS` manifest ships with every release; the installer verifies before writing anything.
The manifest itself is covered by a digest recorded in `install-manifest.json`.

**The three shipped symlinks break naive checksumming in three distinct ways. All four behaviours
below were verified by running them in a scratch directory, not assumed:**

| Behaviour | Result | Consequence |
|---|---|---|
| `find . -type f` | **does not list symlinks at all** (`find -type l` was needed to see them) | A manifest built the obvious way covers **zero of the three** symlinks. They ship unverified — the silent-omission failure |
| `sha256sum` on a **file** symlink | **follows it and hashes the target** — `link.txt` and `d/target.txt` produced an identical digest | A symlink replaced by a real copy of the same bytes **verifies as correct**. This is exactly the silent corruption to guard against, and a content-only manifest cannot detect it |
| `sha256sum` on a **directory** symlink | `sha256sum: dirlink: Is a directory` (error) | `orchestrations/dashboards/logs -> ../logs` cannot be checksummed at all |
| `tar czf` / `tar xzf` | **preserves symlinks as symlinks** (`lrwxrwxrwx dirlink -> d`) | tar is safe by default |

Therefore the manifest must have **two parts**: content digests for regular files, and a separate
declared list of `path -> link target` pairs verified with `readlink`, not `sha256sum`. Verification
must assert *that the path is a symlink* (`test -L`) **and** that its target string matches —
otherwise a copy passes.

The three links and their targets (all currently resolve):

| Link | Target | Note |
|---|---|---|
| `orchestrations/dashboards/logs` | `../logs` | directory; target is a `runtimeDir` created empty at install |
| `orchestrations/dashboards/profiles.json` | `../agents/profiles.json` | ships |
| `orchestrations/dashboards/prd.json` | `../prd.json` | **target is run state, not shipped** — the link will dangle on a fresh install until the first run writes it. Harmless for Eleventy, but the verifier must not treat a dangling link as corruption |

Two are created at runtime as well (`lib/codeline-health.sh:98`,
`lib/eslint-baseline-gate.sh:257`), so symlink support is a hard requirement of the target
filesystem, not only of the archive.

#### 5.0.4 Distribution

| Format | For | Notes |
|---|---|---|
| `.tar.gz` | WSL2/Ubuntu — the real runtime | Verified above to preserve symlinks and modes. **This is the primary artefact** |
| `.zip` | the PowerShell front door only | `zip` is **not installed on this host**, so I could not verify its symlink behaviour and will not assert it. Documented behaviour is that `zip` stores symlinks as *copies* unless given `-y`, and that Windows unzip tools generally cannot recreate them regardless. **Treat the zip as a bootstrap carrier, not as the payload** |

Given that, the Windows path should be: the `.zip` contains `install.ps1` and the **`.tar.gz`**, not
a loose tree. `install.ps1` ensures WSL2, copies the tarball into the distro, and expands it
*inside Linux*, where symlinks and permission bits are native. This sidesteps the zip-symlink
question entirely rather than betting on it — consistent with §4.3, where WSL2 is the runtime and
PowerShell is only a front door.

Bootstrap for a colleague with nothing installed:

- **Windows:** download one `.zip` → right-click *Run with PowerShell* on `install.ps1` → it
  installs WSL2 + Ubuntu if absent, installs the prerequisites inside the distro (`git`, `jq`,
  `python3`, `shellcheck` — the last is easy to forget and is a hard preflight dependency at
  `preflight-static.sh:45-46`), the `claude` or `codemie-claude` runner, expands the tarball, and
  runs `install.sh` with the answers it collected.
- **Ubuntu/WSL:** download `.tar.gz` → verify its detached checksum → extract → `./install.sh`.

Where these artefacts are hosted is not determinable from the code — see Open Questions.

#### 5.0.5 Install layout and upgrade — reconciling §5.3

**§5.3 as written cannot be upgraded safely, and this supersedes it.** It places
`orchestrations/projects/<project>/`, `orchestrations/jira/<project>.env` and
`orchestrations/logs/` *inside* the same tree as the shipped code. An upgrade that replaces that
tree destroys the operator's configuration, their Jira credentials and their run history; an
upgrade that preserves it cannot cleanly replace the code. Immutable release + mutable state must
be separated:

```
/opt/epam-cli/
├── releases/
│   ├── 1.5.0/                 IMMUTABLE. Read-only after install.
│   │   ├── dist/{sdk.js,epam.js}
│   │   ├── node_modules/      pruned runtime closure
│   │   ├── package.json
│   │   ├── orchestrations/
│   │   │   ├── scripts/  config/  prompts/  agents/  plugins/
│   │   │   └── dashboards/    with-docker mode only
│   │   ├── SHA256SUMS  +  SYMLINKS
│   │   └── install-manifest.json
│   └── 1.4.0/                 previous release, kept for rollback
├── current -> releases/1.5.0      THE ONLY THING AN UPGRADE MOVES
└── state/                     NEVER touched by an upgrade
    ├── .env                   THE ONLY SECRETS FILE. Hand-written by the operator.
    │                          No ANTHROPIC_API_KEY on the claude stack (§3.2)
    ├── projects/<project>/    config.env + config.<set>.env + prd.json — no secrets
    ├── logs/                  run output
    └── venv/                  python env
```

The engine is told where state lives rather than being made to guess — `engine-layout.json`'s
`$overrideComment` already establishes the mechanism ("Every entry may be overridden by the
matching environment variable, **for a packaged install that lays the engine out differently**").
That sentence was written for exactly this case. `EPAM_PROJECT_CONFIG_DIR` is already the declared
route for project config (`orchestrate.sh:80`), so it needs a declared root rather than new
plumbing. **`SECRETS_FILE` is deliberately not used.** metrolinx sets
`SECRETS_FILE=orchestrations/jira/metrolinx.env` (`config.env:22`), which is the per-project
credential file this design removes; a deployed project config simply omits the line, and
`orchestrate.sh:110-118` skips the whole block when it is unset. One `.env`, loaded at
`orchestrate.sh:107`, is the entire credential surface.

Upgrade is: unpack the new release beside the old → verify checksums → run `install.sh --check`
against the *new* tree while `current` still points at the old → flip the symlink → re-run
`--check`. Rollback is flipping `current` back; no file is mutated in place, so an interrupted
upgrade leaves a complete old release and a complete-or-absent new one, never a half-written
install. Keep N=2 releases; prune older ones only on explicit request.

`state/` is created by the *installer*, not shipped, so a release tarball never contains a
credential even by accident (§5.0.6).

#### 5.0.6 What must not ship — including a live-credential finding

**A sweep of the shippable set found real, live credentials in three files.** Names and value
*prefixes* only are given; no value was printed in full or copied anywhere:

| File | Contents | Tracked? |
|---|---|---|
| `orchestrations/jira/metrolinx.env:18-19` | `JIRA_EMAIL` (a client-domain account) and `JIRA_TOKEN` with an `ATAT…` prefix — the Atlassian API-token format, i.e. **a live token, not a placeholder** | untracked; ignored by `.gitignore:89` `orchestrations/jira/*.env` |
| `orchestrations/jira/.env:2-3` | a second live `JIRA_EMAIL` / `ATAT…` `JIRA_TOKEN` pair | untracked; same rule |
| `.env:8,12,13,15,18,26` | `GITHUB_PERSONAL_ACCESS_TOKEN` (`ghp_…`), `ANTHROPIC_API_KEY` (`sk-a…`), `OPENAI_API_KEY` (`sk-…`), `OPENROUTER_API_KEY` (`sk-o…`), `MINIMAX_API_KEY`, `RAPIDAPI_KEY` — six live keys | untracked; ignored by `.gitignore:8` |

`orchestrations/jira/.env.example:6-7` holds `admi…` placeholders and is safe (and *is* tracked).
Credential-shaped matches in `orchestrations/agents/KB.md:144,166` are **false positives** — prose
about `process.env.RAPIDAPI_KEY` in a testing lesson, no value.

**The good news is structural:** every one of these is untracked and gitignored, so the
`git archive` build in §5.0.1 cannot emit them. **The risk is entirely in the alternative** — a
`cp -r`, a `tar czf` of the working tree, or a "just zip the folder" shortcut ships all eight
credentials to a client. That is the single strongest argument for making `git archive` the
build mechanism rather than a preference.

Three controls, defence in depth:

1. **`git archive` only.** The build must fail if invoked on a dirty or non-tag tree.
2. **Ship templates, never instances — and ship no credential file at all.** `config.env` ships as
   a `.template` with `${JIRA_URL}`-style placeholders the installer renders into `state/`; it
   carries no secrets, so this is a path/identity concern only, and it fixes the three hardcoded
   absolute paths (`metrolinx/config.env:69`, `mock3/config.env:29`, `skyscanner/config.env:10`)
   noted in §4.2. **`orchestrations/jira/` is excluded from the release outright** — no `.env`, no
   `.env.example`, no `setup.sh`. Credentials reach the pipeline through the single root `.env`
   the operator writes, and through nothing else.
3. **A release-time secret scan that fails the build**, not a warning. `orchestrations/scripts/scan-secrets.sh`
   already exists in the tree; whether it is fit for this purpose was **not** assessed (Open
   Questions). The gate must run over the *assembled artefact*, not the source tree — that is the
   only scope that matches the claim being made.

Also excluded, confirmed against §1.4: `src/`, `test/`, `coverage/`, `benchmarks/`,
`orchestrations/logs/` (735 MB), `orchestrations/cassettes/` (6.6 MB),
`orchestrations/agent-replies/` (53 MB), `orchestrations/backups/`, `orchestrations/dashboards/live/`
(**164 MB** of generated output), the two Python virtualenvs (`orchestrations/scripts/.venv`,
`tools/.venv-deepeval` at 133 MB), every `*.pre-*` / `*.before-cpa` / `*.bak*` PRD snapshot, and
the ~150 loose files at repo root (`session.md` alone is 4.2 MB).

**Client data is a separate concern from secrets and is easy to conflate.**
`orchestrations/projects/metrolinx/` is 117 MB, of which 115 MB is `runs/` and `kb/` — real client
work product, including `prd.json` (21 KB of client requirements), `codeline-facts.json` and
`manifest.json`. **No client's project directory should ship in a release given to another client.**
Ship one neutral project *template*; `mock3` at 692 KB excluding `runs/` is the natural basis.

#### 5.0.6b DECISION — CREDENTIALS ARE GENERATED PER INSTALL, NEVER SHIPPED
(2026-09-03, prompted by a GitGuardian alert on the v1.6 merge)

##### What was flagged, and what it actually is

GitGuardian reported a generic password on the merge to master. Traced: it is
`docker-compose.observability.yml:61`

    DATABASE_URL: postgres://epam:epam_dev@postgres:5432/epam

a URI with embedded credentials — the classic generic-password shape. The full set across the two
compose files:

    POSTGRES_PASSWORD  epam_dev
    DATABASE_URL       postgres://epam:epam_dev@postgres:5432/epam
    NEXTAUTH_SECRET    langfuse-dev-secret-change-in-production
    SALT               langfuse-dev-salt-change-in-production
    (langfuse key)     sk-lf-epam-dev
    (jwt secret)       dev-jwt-secret-change-in-production

**Provenance, checked rather than assumed:** introduced in `5248ece3`, the INITIAL COMMIT. The
v1.6 merge commit touched no compose file, and `epam_dev` was already present on `origin/master~1`.
The merge re-triggered a scan; it did not introduce anything.

**Exposure today: low.** These authenticate a Postgres and a Langfuse reachable only on the compose
network. Several are literally named `change-in-production`.

##### Why it still matters, and this is the packaging point

**They ship.** Every client install would carry the SAME Postgres password and the SAME Langfuse
`NEXTAUTH_SECRET` and `SALT`. Identical secrets across every deployment is a genuine weakness the
moment this leaves one workstation — and it is exactly the kind of thing a client security review
finds first.

##### Decided

1. **No credential literal ships.** The compose files become `.template` with placeholders, per the
   `templated` section of `release-manifest.json` (§5.0.1).
2. **The installer GENERATES them per install** — random Postgres password, random
   `NEXTAUTH_SECRET`, random `SALT` — writes them to the install's own `.env`, and renders the
   compose file from the template. Nothing is shared between two installs.
3. **The release build FAILS on a credential literal.** A scan runs over the packed artefact, not
   over a diff, and refuses to publish. See the scanner note below — the scan must cover URIs with
   embedded credentials, not just key prefixes.
4. Only relevant when observability is opted into (§5.1c). MVP ships none of these services, so
   MVP ships none of these credentials — which is a further argument for the opt-in default.

##### A SCANNER LESSON, recorded because I got this wrong

Before committing 329 files I ran a secret scan and reported it clear. That scan looked for
`sk-[A-Za-z0-9]{20,}`, `ghp_[A-Za-z0-9]{20,}` and `-----BEGIN ... PRIVATE KEY`. **It could never
have found `postgres://epam:epam_dev@host`** — no prefix, no key shape, just a URI.

"Clear" was true of the patterns checked and false as the claim I made. The release scanner must
cover at least: URIs with `user:pass@`, `PASSWORD`/`SECRET`/`SALT`/`TOKEN` assigned a literal value,
and key prefixes — and it must state which patterns it checked, so the next person reads a scope
rather than a verdict.

#### 5.0.7 Size

Measured with `du` on this tree, excluding runtime state:

| Component | Size | Note |
|---|---|---|
| `orchestrations/scripts/` | 5.8 MB | excluding both virtualenvs; the raw 176 MB is 133 MB of `.venv-deepeval` |
| `orchestrations/agents/` | 976 KB | |
| `orchestrations/prompts/` | 608 KB | |
| `orchestrations/config/` | 344 KB | |
| `orchestrations/plugins/` | 128 KB | |
| `orchestrations/dashboards/` | 1.1 MB | excluding `live/`; **with-docker mode only** |
| `dist/` | 296 KB | `.js` + `.d.ts` only — **616 KB of the 916 KB is source maps** |
| `node_modules` (pruned) | ~1 MB | `jsonrepair` 784 KB + `keytar` 172 KB |
| project template | ~700 KB | `mock3` excluding `runs/` |
| **Total** | **~10–11 MB uncompressed** | |

Compressed size was **not measured**; a text-heavy tree of this shape would plausibly land around
3–4 MB gzipped, but that is an estimate and should not be quoted as fact.

Nothing makes the payload unreasonably large — **provided the exclusions hold.** The hazard is
entirely one-sided: the four largest directories in the repo (`logs/` 735 MB, `dashboards/live/`
164 MB, `.venv-deepeval` 133 MB, `projects/metrolinx/runs/` ~115 MB) are all *generated or
client-specific*, and a naive `tar czf epam-cli.tgz .` produces roughly a **1.2 GB** archive
containing client work product and eight live credentials. The 10 MB figure is a property of the
declared manifest, not of the directory.

Two easy wins: strip source maps (−616 KB, two thirds of `dist/`), and omit
`orchestrations/dashboards/` in `without-docker` mode (−1.1 MB) — though see Open Question 6, since
the Eleventy renderer is a host process and dashboards remain useful without docker.

#### 5.0.8 Step by step — what a human actually does

Mechanism above; sequence here. Every step is a literal command or action, in order, with what
success looks like. Assumes the person has nothing installed.

**Who does what:** the *release engineer* runs flow A once per version. Everyone else runs B, C or
D. The `.env` in step B7/C5 is the only file anyone hand-edits, and it is the only place a
credential ever goes.

##### Flow A — release engineer builds the artefact (once per version)

| # | Command / action | Success looks like |
|---|---|---|
| A1 | `cd epam-cli && git status --porcelain` | **empty output.** A dirty tree must abort the build (§5.0.2) |
| A2 | `git tag -a v1.6.0 -m "release 1.6.0" && git push --tags` | `git describe --tags --match 'v*'` prints `v1.6.0` |
| A3 | `npm ci` | `node_modules/` populated, no peer warnings that fail |
| A4 | `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/tsup` | `dist/sdk.js` (~250 KB) and `dist/epam.js` written |
| A5 | `node -e "console.log(Object.keys(require('./dist/sdk.js').FIXED_AGENT_ROLES).length)"` | a non-zero count — the exact call `agent-roster.js:37` makes. **This is the check `install.sh:90`'s file-existence test misses** |
| A6 | `./scripts/make-release.sh v1.6.0` *(to be built — §5.0.1)* | reads `release-manifest.json`, `git archive`s the declared set, overlays `dist/` + pruned `node_modules`, strips source maps, templates configs, writes `SHA256SUMS`, `SYMLINKS`, `install-manifest.json` |
| A7 | `tar tzf epam-cli-1.6.0.tar.gz \| grep -cE '^.*(jira/.*\.env\|^\.env$)'` | **`0`.** If this is not zero, stop — the archive carries credentials (§5.0.6) |
| A8 | `tar tvzf epam-cli-1.6.0.tar.gz \| grep '^l'` | exactly **3** symlink entries (§5.0.3) |
| A9 | `du -h epam-cli-1.6.0.tar.gz` | single-digit MB. Hundreds of MB means an exclusion failed (§5.0.7) |
| A10 | `sha256sum epam-cli-1.6.0.tar.gz > epam-cli-1.6.0.tar.gz.sha256` | detached checksum beside the archive |
| A11 | zip `install.ps1` + the `.tar.gz` together as `epam-cli-1.6.0-windows.zip` | the zip carries the tarball, **not** a loose tree (§5.0.4) |
| A12 | publish both artefacts | *destination unresolved — Open Question 10* |

##### Flow B — Windows operator installs (WSL2)

| # | Command / action | Success looks like |
|---|---|---|
| B1 | Download `epam-cli-1.6.0-windows.zip`, right-click → Extract All | a folder with `install.ps1` and the `.tar.gz` |
| B2 | Right-click `install.ps1` → **Run with PowerShell** | it starts and reports what it will do before doing it |
| B3 | *(installer does this)* `wsl --install -d Ubuntu` if WSL is absent | **a reboot may be required here.** After reboot, re-run `install.ps1` |
| B4 | *(installer)* copies the tarball into the distro and expands it there | extraction happens **inside Linux**, so symlinks and modes survive (§5.0.4) |
| B5 | *(installer)* `sudo apt-get install -y git jq python3 python3-pip shellcheck` | all five resolve. `shellcheck` is the one people forget — `preflight-static.sh:45-46` hard-requires it |
| B6 | *(installer)* installs the runner — `claude` or `codemie-claude` | `claude --version` prints a version inside WSL |
| B7 | **Operator edits `.env`** — the installer opens it and waits | see §5.0.9. This is the only hand-edited file |
| B8 | *(installer)* runs the runner auth check | one `--print` round-trip returns non-empty. `--version` is not sufficient — it proves the binary, not the session |
| B9 | `wsl -d Ubuntu -- /opt/epam-cli/current/orchestrations/scripts/pipeline --list` | a table of projects and their ticket prefixes |
| B10 | `wsl -d Ubuntu -- ... pipeline --jira AMSD-1234 --dry-run` | `✓ ready` plus ticket / project / stack / docker lines, and **nothing started** |

Docker: at B5 the installer additionally checks Docker Desktop with the WSL2 backend. **Without
docker every step above is identical** — B10 prints `dashboards unavailable (docker not running) —
the run itself does not need them` (`pipeline:124`) and proceeds. That line is not a warning to fix.

##### Flow C — Ubuntu / existing WSL operator installs

| # | Command / action | Success looks like |
|---|---|---|
| C1 | `curl -LO <url>/epam-cli-1.6.0.tar.gz` and `.sha256` | two files |
| C2 | `sha256sum -c epam-cli-1.6.0.tar.gz.sha256` | `epam-cli-1.6.0.tar.gz: OK`. **Anything else — stop** |
| C3 | `sudo apt-get install -y git jq python3 python3-pip shellcheck` | all resolve |
| C4 | `sudo mkdir -p /opt/epam-cli/releases && sudo tar xzf epam-cli-1.6.0.tar.gz -C /opt/epam-cli/releases/` | `/opt/epam-cli/releases/1.6.0/` exists |
| C5 | `cp /opt/epam-cli/releases/1.6.0/.env.example /opt/epam-cli/state/.env` then **edit it** | §5.0.9 |
| C6 | `cd /opt/epam-cli/releases/1.6.0 && ./install.sh --stack claude` (add `--no-docker` to be explicit) | prerequisite, runner, `.env`, `dist/sdk.js`, python and Jira checks all `✓`, ending in `ready` |
| C7 | `ln -sfn /opt/epam-cli/releases/1.6.0 /opt/epam-cli/current` | `readlink /opt/epam-cli/current` → `…/1.6.0` |
| C8 | `/opt/epam-cli/current/orchestrations/scripts/pipeline --jira AMSD-1234 --dry-run` | `✓ ready`, nothing started |
| C9 | *(real run)* `... pipeline --jira AMSD-1234` | spend confirmation prompt, then the run. **Expect it to pause twice** if the project sets `EPAM_PAUSE_AFTER_AGENT_MINT` / `EPAM_PAUSE_BEFORE_WRITER` |

##### Flow D — upgrade and rollback

| # | Command / action | Success looks like |
|---|---|---|
| D1 | unpack 1.7.0 **beside** 1.6.0 into `releases/` | both directories present; `current` still → 1.6.0 |
| D2 | `sha256sum -c` inside the new release | `OK` for every file |
| D3 | `/opt/epam-cli/releases/1.7.0/install.sh --check` | passes **while `current` still points at 1.6.0** |
| D4 | `ln -sfn /opt/epam-cli/releases/1.7.0 /opt/epam-cli/current` | the flip — the only mutating step, and it is atomic |
| D5 | `... pipeline --list` | works against 1.7.0 |
| D6 | **rollback:** `ln -sfn /opt/epam-cli/releases/1.6.0 /opt/epam-cli/current` | back, instantly. `state/` was never touched |

**Never** unpack a release over a running install. Nothing in the tree is mutated in place, so an
interrupted upgrade leaves a complete old release and a complete-or-absent new one.

#### 5.0.9 The `.env` the operator writes

One file. The installer creates it from `.env.example` and never writes a value into it.
On the **claude** and **codemie** stacks `set_required_keys()` returns the empty string
(`provider-sets.json`, both sets declare `credentials: []`), so no LLM API key is needed at all —
`claude` authenticates through its OAuth session on disk and `codemie-claude` through CodeMie SSO.

| Key | claude | codemie | Why |
|---|---|---|---|
| `JIRA_EMAIL` | **required** | **required** | `ingest-jira-tickets.sh:81-85` exits 1 without it |
| `JIRA_TOKEN` | **required** | **required** | same; also metrolinx's `REQUIRED_KEYS` (`config.env:16`) |
| `ANTHROPIC_API_KEY` | **must be absent** | must be absent | it **outranks** the OAuth session. `llm-defaults.claude.json` records seven runs billed to an API account while the subscription went unused. `unsetEnv` scrubs it, but the safe state is not writing it |
| `OPENROUTER_API_KEY`, `MINIMAX_API_KEY` | not needed | not needed | only the `openrouter` set declares them required |
| `LANGFUSE_*` | optional | optional | tracing disables itself cleanly when unset (`LangfuseTracer.ts:30-32`) |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | optional | optional | only if the run pushes; client repos are never pushed to |

So a minimal working `.env` on the claude stack is **two lines**. That is the whole credential
surface, and it is why no prompting, no per-project secret file and no mode management is needed.

### 5.1 Installer

**Build on `install.sh`, which already exists** and already does the right things: it reads
`provider-sets.json` rather than naming stacks (`install.sh:39-49`), resolves the stack's runner
from `llm-defaults.<set>.json` and checks it is on PATH (`:62-74`), and states outright that
"DOCKER IS OPTIONAL, ALWAYS" (`:9-10`) with three modes `--docker`/`--no-docker`/auto (`:99-113`).

**Defects to fix, all read-verified:**

| # | Defect | Site |
|---|---|---|
| 1 | Copies `.env.sample`, which **does not exist** — the file is `.env.example`, and it lacks every Jira variable | `install.sh:82`; also `pipeline:95` |
| 2 | Runs bare `docker compose up -d` with **no `-f`**, and there is no `docker-compose.yml` at repo root — only the three named files. Errors are swallowed by `|| true`, so it reports "docker is up" having started nothing | `install.sh:104-113` |
| 3 | Always builds from source (`npm run build`) — **incompatible with a no-src install** | `install.sh:95-97` |
| 4 | Verifies the build by `[ -f dist/epam.js ]` — which passes on the 188-byte stub (§1.3) | `install.sh:90` |
| 5 | Never creates the `epam` PATH shim; the existing one hardcodes an absolute repo path | — |
| 6 | Never asks for or writes `JIRA_CODELINE_ROOT`, `JIRA_URL`, `JIRA_PROJECT_KEY` | — |
| 7 | No Python env setup, though 88 handlers need it | — |

**Questions asked — target four, none of them a decision the config can make:**

1. Stack? — offered as `claude` / `codemie`, defaulted from `provider-sets.json.defaultSet`.
   Skippable with `--stack`.
2. Dashboards? — `with-docker` / `without-docker`. Defaults to `without-docker` when docker is not
   running, and **says so**.
3. Jira: site URL and project key. **Non-secret values only.**
4. Where are the codelines? — one directory → `JIRA_CODELINE_ROOT`.

**The installer never asks for a credential.** All secrets live in a single `.env` at the install
root, written by hand by the person installing. The installer ships `.env.example`, copies it to
`.env` if absent, tells the operator to fill it in, and then *checks* the required keys are
non-empty — it does not prompt for them, does not echo them, does not write per-project credential
files, and does not manage file modes. This is the same file `orchestrate.sh:107` already loads
first, so nothing new is introduced: one file, one owner, one place to look.

Everything else is defaulted or derived (§3.2). Per the "a default is a DECISION" rule, each
defaulted value is **printed** in the summary, not silently assumed.

**What it writes:**

- `.env.example` → `.env` if `.env` is absent — **then stops and tells the operator to fill it in.**
  The operator owns this file. **It must not contain `ANTHROPIC_API_KEY`** on the claude stack
  (`llm-defaults.claude.json` `unsetEnv` scrubs it, but its presence is what billed seven runs to
  the wrong account).
- `orchestrations/projects/<project>/config.env` — from a template, with the **non-secret** answers
  substituted (`JIRA_URL`, `JIRA_PROJECT_KEY`, `JIRA_CODELINE_ROOT`).
- `orchestrations/projects/<project>/config.<set>.env` — copied from the shipped overlay unchanged.
- `<prefix>/bin/epam` — shim, absolute path computed at install time, added to PATH.
- `orchestrations/config/install-mode.json` — **new**: the declared docker mode, so the preflight
  can be mode-aware (§2.4.1) rather than reading an env flag nobody set.

**How it verifies — this is the part that must not be cosmetic:**

| Check | Assertion |
|---|---|
| runner reachable | `claude --version` (or `codemie-claude --version`) exits 0 |
| runner **authenticated** | one minimal `--print` round-trip returns a non-empty result. A `--version` proves the binary, not the session; the OAuth/SSO session is the thing that actually fails |
| `dist/sdk.js` usable | `node -e "require('<root>/dist/sdk.js').FIXED_AGENT_ROLES"` returns a non-empty roster — the exact call `agent-roster.js:37-45` makes |
| `epam` shim | executes and does not print `Hello, World!` (§1.3) |
| python | `python3 -c "import pydantic"` and one real handler, e.g. `lib/handlers/story-status.py` against a fixture PRD |
| jq / git / bash ≥ 4 | present |
| `.env` | every key the active stack requires is present and non-empty. On `claude`/`codemie` that is `JIRA_EMAIL` + `JIRA_TOKEN` and nothing else — `set_required_keys()` returns empty for both sets |
| Jira | one authenticated GET against `JIRA_URL` returning the project — read-only, per the GET-only rule |
| dashboards (docker mode only) | 8092, 3100, 3001 all answer |
| dashboards (no-docker) | `orchestrations/dashboards/live/build-info.json` exists |
| end-to-end | `run-pipeline <TICKET> --dry-run` exits 0 |

The install is **not** "ready" until the dry run passes. `install.sh` currently prints "ready" after
a file-existence check.

### 5.1a DECISION — THE CONTAINER RUNTIME IS DECLARED; PODMAN IS THE WINDOWS DEFAULT
(2026-09-03, against tag v1.6)

#### Podman is already first-class in this codebase

Verified, not assumed:

    run-agent-orchestration.sh:4075   for _rt in docker podman; do
    lib/sandbox-invoke.sh:42          for _rt in docker podman; do
                                      ...both error clearly when neither is present

So the detection pattern already exists and is the one to extend. **The gap is compose: 5
`docker compose` invocations, 0 podman.**

#### Why Podman is the better DEFAULT for Windows client installs

  - **Licensing.** Docker Desktop needs a paid subscription for companies over 250 employees or
    $10M revenue. Podman Desktop is Apache-2.0. This is the practical difference that stalls a
    rollout at exactly the organisations this is sold into — a technical preference is not what
    blocks an install, a procurement conversation is.
  - **Same runtime story.** Podman on Windows also runs on WSL2, so §4.4 is unchanged: Linux is the
    runtime, Podman is a different engine on it. This is NOT a fourth platform.
  - **Rootless by default** — better security for something executing agent-generated code.
  - **`docker` shim** — Podman ships an alias, so most existing invocations work unchanged.

#### DECIDED

The container runtime is a DECLARED install option, `docker` or `podman`, detected the way
`sandbox-invoke.sh` already does it. **Podman is the default on Windows**; either is accepted on
Linux. The choice is recorded in `install-manifest.json` alongside the docker/no-docker mode, and
preflight REPORTS which runtime it found rather than inferring one silently.

#### THE THING THAT MUST BE TESTED, NOT ASSUMED

**Rootless Podman uses user-namespace UID mapping.** A file written by the containerised backend
into the spool appears on the host owned by a MAPPED uid, not the operator's. The entire
container-to-host boundary in §5.5 is that shared directory: the host runner must read what the
container writes, and the container must read the status the runner writes back.

Solvable — `--userns=keep-id`, or `:U` / `:z` mount flags — but it is the difference between an
install that works and a permissions puzzle discovered by a client. **Verify the spool round-trip
under rootless Podman before shipping**: write a request as the container user, read it as the host
user, write a status back, read it from the container.

The same concern applies with more force to the write perimeter (`chmod a-w`, 49 sites) if the
pipeline is ever containerised (§5.1b/C option b). A write perimeter that silently does nothing
under UID mapping is worse than none, because it looks enforced.

#### Concrete work item

Replace the 5 `docker compose` call sites with a single runtime-aware invocation, resolved once:

    docker  -> docker compose
    podman  -> podman compose  (v4.7+), else podman-compose

This belongs in the same one-script consolidation §2.5 already requires, so it is one change and not
two.

### 5.1b DECISIONS — WSL mechanism, launch dashboard, docker-only rollout
(2026-09-03, against tag v1.6)

#### A. PowerShell CAN install into WSL — the mechanism, and the five things that bite

    wsl --status                                   # present?
    wsl -l -v                                      # which distros, which version
    wsl --install -d Ubuntu                        # install (admin; usually a reboot)
    wsl -d <distro> -- bash -lc "npm install -g /path/epam-cli-<v>.tgz"

Files cross both ways: `\\wsl$\<distro>\...` from Windows, `/mnt/c/...` from inside.

**The five failure modes, each of which turns a working installer into a support ticket:**

1. **`wsl --install` needs admin and usually a reboot.** So `install.ps1` cannot be one
   uninterrupted script: check -> maybe elevate -> maybe reboot -> RESUME. For a non-technical user
   the resume must be automatic or unmissable, or the install simply stops there.
2. **Node must be installed INSIDE WSL.** A Windows Node is invisible to it, and this project pins
   Node 20 — the classic silently-half-working omission.
3. **Install into the WSL filesystem, never `/mnt/c`.** `/mnt/c` has no reliable execute bits and
   much slower I/O; every shell script here needs `+x`, so a `/mnt/c` install yields a pile of
   "permission denied" at run time.
4. **Line endings.** Anything arriving via a Windows checkout or text-mode copy can be CRLF, and
   `#!/usr/bin/env bash\r` fails with a baffling error. The npm-tarball route largely avoids this,
   which is a further point in its favour (§5.0.1b).
5. **Distro identity.** `wsl -d Ubuntu` assumes a name; real machines have `Ubuntu-22.04`,
   `Ubuntu-24.04`, or several. Enumerate with `wsl -l -v` and pick or ask — never assume.

NOT YET EXECUTED: this mechanism is asserted from documentation, not run — this workstation is
Linux. Verify on one Windows box before it reaches a client: `wsl --status`, `wsl -l -v`, then a
throwaway `npm install -g` of the packed tarball inside the distro.

#### B. A SEPARATE LAUNCH DASHBOARD IS REQUIRED (agreed)

The non-technical audience does not install the pipeline. They need to start a run and see what
happened. **This is a NEW surface, deliberately not the existing dashboard** (`agent-monitor`,
:8092), which is an operator/debug view: it exposes prompts, costs, agent internals and raw logs.

    existing dashboard  -> operator view, keep as-is, technical users
    launch dashboard    -> pick a ticket, start a run, see the outcome

Blocked by a real gap, already recorded at §6.2: **the control plane cannot start a run.** Until
that exists, the non-technical tier cannot ship at all — so the launch API is on the CRITICAL PATH,
not a nice-to-have.

Three policy questions that must be answered before it is exposed, because they are not
engineering choices:

  1. WHO PAYS. A click spends real money on a shared key. Today every guardrail is launcher-side
     (`--yes`, preflight, an operator watching). None of it exists behind an API.
  2. SHARED HOST OR PER USER. Shared is far simpler to operate and is where run evidence
     accumulates — but concurrent runs on one box is exactly what exhausted 14GB on 2026-09-02.
  3. OUTCOME OR FULL VIEW. "Here is the branch, the test, and the review verdict" may be the whole
     requirement, and is a fraction of the work of making the operator dashboard client-safe.

#### C. DOCKER-ONLY ROLLOUT — viable, but the two meanings must not be conflated

Agreed in principle: **Ubuntu docker (docker engine on Linux) is the trusted target; Docker Desktop
on Windows is not.** That is the right call — Desktop adds licensing and corporate friction, and its
backend is WSL2 anyway, so it is WSL2 with extra steps.

**But "docker-only installer" means one of two very different things:**

| | what runs where | implication |
|---|---|---|
| **(a) services in docker, pipeline on the host** | nginx/langfuse/grafana containerised; the engine is bash on Ubuntu | this is the existing `with-docker` mode (§2.5). Low risk, already designed |
| **(b) the pipeline ITSELF in a container** | one image carrying engine + Node 20 + python3 + jq + git | far better for non-technical rollout: one image, one command, no Node pinning, no npm, no WSL filesystem traps |

(b) is the stronger rollout story and brings its own requirements, none of them blocking but all of
them real:

  - the **client codeline must be bind-mounted** into the container, and git identity plus
    credentials must reach it
  - **the write perimeter must survive the mount.** `chmod a-w` at 49 sites is the enforcement
    mechanism; container UID mapping vs host ownership decides whether it works or silently does
    nothing — and a write perimeter that silently does nothing is worse than none
  - `/proc`, `flock`, `setsid`, process groups all work normally inside a Linux container, so the
    §4.4 portability problem disappears entirely for this route
  - it does NOT remove the need for the `without-docker` mode for technical users who want the
    engine on their own box

OPEN: which of (a) or (b) is the rollout artefact. (b) is recommended for the non-technical tier;
(a) remains right for a technical local install.

### 5.1c DECISION — REPLAY IS A CONFIG OPTION; OBSERVABILITY SPLITS IN TWO
(2026-09-03. SUPERSEDES the earlier "drop Langfuse from MVP" note, which was wrong.)

#### The correction

An earlier version of this section recommended dropping Langfuse from MVP as "fail-open reporting
nobody looks at". **That was wrong.** Langfuse is not a dashboard — it is the RECORDER that makes a
run replayable. The dependency splits cleanly:

    RECORD   needs Langfuse LIVE during the run   (it captures every turn)
    EXPORT   needs Langfuse                       (cassette-export.js reads traces out of it)
    REPLAY   needs only the cassette DIRECTORY on disk

`llm-handler.sh:459` states it: *"The cassette directory IS the switch. There is no separate replay
mode flag."* Four cassettes already exist under `orchestrations/cassettes/`.

**The consequence is one-way.** A run executed without Langfuse recording can never be replayed
afterwards — the turns were never captured. The cost is not recoverable later.

Why that matters, in the words of `lib/cassette-store.js`:

> Every bug that killed a run this month was plumbing — an unbound variable, a function used and
> never imported, an env var handed the wrong directory. None of them needed a model to find, and
> all of them cost real tokens to find, because the only way to exercise the pipeline end to end was
> to run it against paid APIs.

That is exactly the loop that burned four paid runs on 2026-09-02.

#### DECIDED: replay is a config option, not a hidden consequence

The install asks one question and records the answer:

    replay: on    -> Langfuse + clickhouse + postgres installed and running.
                     Every run is recorded and can be exported to a cassette and replayed for $0.
                     Cost: ~2.36GB of images, and their memory share (§5.4b).

    replay: off   -> none of those installed. Runs are cheaper and lighter, and are NOT replayable.
                     Stated at install and at preflight, every time — never inferred.

Grafana stays separately optional: it is genuinely only a view, consumes no recording duty, and
nothing depends on it. Redis is never installed — it has no dependent since the worker was removed.

    replay on   : langfuse + clickhouse + postgres     ~2.36GB
    grafana     : optional view                          647MB
    redis       : never                                   58MB

#### The keys, and why they cannot be left to a human

Recording activates only when BOTH are present (`LangfuseTracer.ts:30`):

    LANGFUSE_SECRET_KEY    required
    LANGFUSE_PUBLIC_KEY    required
    LANGFUSE_BASE_URL      defaults to http://localhost:3100
    LANGFUSE_ENABLED=0     explicit off switch

They are a project API key pair issued INSIDE Langfuse. A fresh install has empty volumes, so no
org, no project, and therefore no keys — and `hasKeys` is false, so recording is silently off while
2.36GB of containers run and capture nothing.

**With `replay: on` the installer MUST provision them**, using Langfuse v2 `LANGFUSE_INIT_*` to seed
org/project/keys on first boot and writing the pair into the install's `.env`. Verify against the
pinned `langfuse/langfuse:2`.

**And preflight must FAIL, not warn, when `replay: on` and the keys are absent.** A run that is not
being recorded is a run that can never be replayed, and the operator cannot discover that later —
by then the turns are gone. This is the one place where a warning is not enough.

(The hardcoded `sk-lf-epam-dev` in the compose file is one of the literals §5.0.6b requires to
become per-install generated.)

### 5.2 Executor

**Build on `orchestrations/scripts/pipeline`**, which already implements the shape: derives the
project from the ticket prefix via each project's declared `JIRA_PROJECT_KEY` (`:59-67`), resolves
the active set (`:99-103`), checks the runner is on PATH (`:110-118`), checks `jq`/`git` (`:120-121`),
treats docker as optional and non-fatal (`:124-127`), collects **all** problems and reports them
together (`:129-133`), supports `--dry-run` (`:141`, which exits before the handoff and so genuinely
works), and `exec`s a tested launcher rather than reimplementing the run (`:147`).

**Reconsider the delegation target.** `pipeline:147` currently execs `orchestrate.sh`. But
`tier3-run.sh` (181 lines) is the generic, vendor-neutral launcher: `--project <name>`, `--phase`,
`--yes`, `--describe`, `--` passthrough; project dir at `:36-45`, `.env` + both env halves at
`:52-55`, `PRD_FILE` at `:60`, `require_preflight` at `:124-128`, pre-run-reset gate at `:141`.
It has **no hardcoded vendor key checks** *and* it has a preflight — which is precisely the pair of
properties `orchestrate.sh` and the tier launchers each have only one of. Choosing between the two
is a decision for phase 2, once the preflight is install-mode-aware (§2.4); until then
`orchestrate.sh` is the only launcher that starts on a docker-less box.

**The one thing it must gain — and the reason to do this first:** make the ticket argument
*actually select the ticket*. Today `JIRA_TICKET` is exported (`:146`) and read by nothing.
The fix is at the seam that already exists: `jira-client.js:355` honours `JIRA_JQL` above all
else, so the executor should derive `JIRA_JQL="issue = <TICKET>"` when the operator named a ticket,
and leave the project's own `JIRA_JQL` in force only when they did not. **This must be verified by
asserting on the JQL that reaches `searchIssues`, not by grepping for the variable name** — the
present defect is precisely a name that exists and is never read.

Surface, per requirement 5:

```
run-pipeline AMSD-2041              # the whole interface
run-pipeline AMSD-2041 --dry-run    # validate, spend nothing
run-pipeline --list                 # projects and their prefixes
```

No provider flag, no model flag, no path. `EPAM_PROVIDER_SET` remains the documented hot-swap
(`provider-sets.json.$hotSwap`).

**What it validates before spending** — the existing list, plus:
Jira reachable and the ticket exists; `JIRA_URL`/`JIRA_EMAIL`/`JIRA_TOKEN` present
(`ingest-jira-tickets.sh:81-85` will exit 1 otherwise); `JIRA_CODELINE_ROOT` set **and existing**
(`:111-118`); `PROJECT_NAME` set (`preflight-check.sh:455-458` fails without it); the runner
*authenticated*, not merely present; `dist/sdk.js` loadable; `shellcheck` on PATH
(`preflight-static.sh:45-46`); disk headroom for `orchestrations/logs`; in docker mode, the three
endpoints. Every problem is collected and printed at once — `pipeline:129-133` already has that
shape and it is the right one.

**The executor must own its own validation, not borrow the orchestrator's.** Because
`--dry-run` never reaches the arg parser on the Jira path (§0.7), the executor cannot delegate
"check without spending" downstream. Everything above has to be checked in the executor, before
the handoff.

**What it reports:** ticket, project, stack, runner, docker mode, the resolved JQL, the log path,
and the pause configuration (`EPAM_PAUSE_AFTER_AGENT_MINT`, `EPAM_PAUSE_BEFORE_WRITER` are both `1`
for metrolinx — an operator must know the run will stop). Spend reporting already exists at
`orchestrate.sh:394-401` and is set-driven via `spend_probe_read`, correctly returning nothing on
the claude set.

### 5.3 Deployed layout (no `src/`)

> **Superseded in part by §5.0.5.** The file *set* below is correct; the *placement* is not.
> §5.0.5 separates the immutable release from mutable state so an upgrade is a symlink flip.
> Read this section for what ships, and §5.0.5 for where it lands.

```
/opt/epam-cli/                    (or %LOCALAPPDATA%\epam-cli via WSL)
├── dist/
│   ├── sdk.js                    REQUIRED — agent-roster.js:37, spec-mode-runner.js:3700
│   ├── sdk.d.ts
│   └── epam.js                   + shim; required on openrouter/minimax
├── node_modules/                 pruned: jsonrepair (+ keytar if the CLI path is used)
├── package.json                  bin/main resolution
├── orchestrations/
│   ├── scripts/                  incl. lib/, plugins hooks, .venv/
│   ├── config/                   provider sets, ladders, services, install-mode.json
│   ├── prompts/                  template layer
│   ├── agents/                   profiles, invocation-profiles.json
│   ├── plugins/
│   ├── projects/<project>/       config.env + config.<set>.env + prd.json
│   ├── dashboards/               ONLY in with-docker mode (165 M, 3 symlinks)
│   └── logs/                     created empty at install
├── requirements.txt              pydantic>=2.0
└── install-manifest.json         version, git sha, build time, mode, stack
```

Excluded: `src/`, `test/`, `coverage/`, `benchmarks/`, `orchestrations/cassettes/`,
`orchestrations/agent-replies/`, `orchestrations/backups/`, all `*-prd.json.pre-*` /
`*.before-cpa` / `*.bak*` files, and the ~150 loose artifacts at repo root
(`session.md` alone is 4.2 MB).

**Packaging must be a build-machine step**, because `dist/` is gitignored (`.gitignore:5`) and
untracked. `package.json:20-23` `files: ["dist/", "TOOL_REGISTRY.md"]` covers the CLI but **not**
`orchestrations/` — so `npm pack` alone is insufficient. The plan is a `make-release.sh` producing a
versioned tarball plus `install-manifest.json`, and the manifest is what `--check` verifies against.

### 5.4 Phased order — riskiest unknowns first

| Phase | Work | Why here |
|---|---|---|
| **0** | **Prove a no-src, no-docker run end to end on Linux**, by hand, before writing any installer code. Copy the minimum set (§1.4) to a clean directory, delete `src/`, run `pipeline --jira <ticket> --dry-run`, then a real mock run. | This is the single largest unknown. Everything else is packaging around an assumption that is currently *reasoned*, not *demonstrated*. §1.2 says the guards no-op without `src/`; that is code-reading, not a run. |
| **1** | **Fix the ticket argument** (§5.2) with a test asserting on the JQL reaching `searchIssues`. | Requirement 5 is not met until this works, and it is cheap. |
| **2** | Make the preflight install-mode-aware (§2.4.1-2.4.2); give `orchestrate.sh` a preflight (§2.4.3); consolidate the four staleness gates (§2.4.4). | Converts the accidental no-docker path into a designed one. |
| **3** | Build/packaging: `make-release.sh`, `install-manifest.json`, symlink and permission handling. | Depends on phase 0 fixing the file list. |
| **4** | Rework `install.sh`: the seven defects in §5.1, the four questions, the real verification. | Depends on 2 and 3. |
| **5** | **WSL2**: run phases 0-4 unchanged inside WSL2 on Windows. Expect surprises in symlinks, `flock` over `/mnt/c`, and file mtimes across the 9p boundary (which the staleness gates depend on). | Second-largest unknown; deliberately not first because it multiplies with any Linux-side instability. |
| **6** | `install.ps1` / `run-pipeline.ps1` wrappers (§4.3). | Thin, and only meaningful once 5 holds. |
| **7** | Decide the fate of the nine `tier*-run.sh` launchers (§3.3). Either exclude them from the release or move them onto `set-credentials.sh`; `tier3-run.sh` is the one to keep. | Behaviour-preserving cleanup; safe to do last, but must not be dropped — leaving `tier3-metrolinx-run.sh:153-154` in a claude-only release ships a launcher that cannot start. |

**Do not** attempt phases 5-6 before 0-2. A Windows failure on top of an unproven Linux baseline
gives two candidate causes for every symptom.

---

## 5.4b MEMORY CONTROLS — A CLIENT INSTALL MUST NOT KILL THE MACHINE
(2026-09-03, required by the operator)

### 5.4b.1 The evidence, from this workstation on 2026-09-02

A 14GB WSL2 box was exhausted and had to be restarted, taking the terminal, docker and the session
with it. Two causes, both still present in what would ship today:

  - **six observability containers with no memory limit of any kind.** ClickHouse sizes its caches
    from what it can see, so it takes what the box has.
  - **`npm test` is bare `jest`**, which defaults to `nproc - 1` workers with no per-worker heap
    cap. On this 16-core box that is 15 workers measured at 695-783MB each: **~11GB to validate a
    one-line change**, and the run sat at 10,731MB of an 11,264MB cap for ten minutes under constant
    reclaim.

### 5.4b.2 What is actually shipped today — measured, not assumed

| | state |
|---|---|
| memory limits in any shipped compose file | **zero** (`observability.yml`, `epam-cli.yml`, the override) |
| the override file | **GENERATED** every run by `pre-run-reset.sh:165` — hand-added limits are silently overwritten at the next launch |
| anything bounding the pipeline process | **nothing.** `run-bounded.sh` exists and NO launcher calls it |

The generated-override point is worth stating plainly: adding `mem_limit` to that file by hand looks
like it works and lasts exactly until the next run. The limits must go in the GENERATOR.

### 5.4b.3 Required, in order of leverage

**1. Cap the test workers. Biggest single lever, pure config, zero risk.**
`--maxWorkers` is a stack fact, so it belongs with the other stack facts in the ecosystem provider
(`orchestrations/ecosystems/package-json.js`) alongside `command` and `scopedCommand`. 15 workers ->
4 takes the suite from ~11GB to under 3GB. **This is a candidate for the pipeline itself, not only
for packaging** — it would have prevented today's crash on this machine.

**2. Bound the containers IN THE GENERATOR, sized from the host.**
Limits go into `pre-run-reset.sh`'s heredoc (or the base compose), computed as a SHARE OF TOTAL RAM
READ AT LAUNCH — never fixed numbers. A client box may have 8GB or 64GB; `clickhouse: 2g` is wrong
on both. Same rule already recorded for `run-bounded.sh`: bound the share, never a constant.

**3. Bound the pipeline process, and be honest when it cannot be.**
`run-bounded.sh` uses `systemd-run --user --scope`, which needs a systemd USER BUS — absent on this
machine until `loginctl enable-linger` was run, and not assumable on a client box. So:
  - portable floor: `NODE_OPTIONS=--max-old-space-size` plus the worker cap (works everywhere)
  - enhancement: the cgroup scope where a user bus exists
  - and it must SAY when it cannot bound. `run-bounded.sh` today gates on `command -v systemd-run`
    — the BINARY, which is always present — so it printed a confident ceiling, exec-ed, failed on
    the bus and ran NOTHING. Probe the bus, never the binary.

**4. Preflight must refuse a host that is too small.**
Read total RAM and fail with a number. Today the failure mode was a WSL restart that killed the
terminal, docker and the session. On a client machine that is the first impression, and it is
entirely preventable by one check that already has a home.

### 5.4b.4 Note for the containerised-pipeline option (§5.1b/C)

If the pipeline is ever containerised, `docker run --memory` gives item 3 for free and portably —
no systemd bus, no cgroup delegation, no per-platform branch. That is a genuine argument for (b)
that has nothing to do with packaging convenience, and it should be weighed when (b) is revisited
after MVP.

---

## 5.5 LAUNCH DASHBOARD — DESIGN (2026-09-03, decided with the operator)

A NEW surface for the non-technical tier. Deliberately not the existing operator dashboard
(agent-monitor, :8092), which exposes prompts, costs, agent internals and raw logs.

### 5.5.1 What it does

    New run  ->  enter a Jira ticket id  ->  Save
             ->  appears in a grid with all previous runs
             ->  status starts pending, progresses, green dot while running

Nothing else. No prompts, no costs, no agent internals.

### 5.5.2 Decided

| Question | Decision |
|---|---|
| Concurrency | **Reject while busy.** UI refuses to create a run and says why |
| Stop | **Yes — a stop button** |
| Access | **Simple shared password** |
| In-progress display | **Green dot + current stage name** |
| Front end | **Flutter (web)**, dark background, bright green foreground |
| Back end | **thin Node**, JSON over HTTP |
| Hosting | **FE and BE both in docker** |

### 5.5.3 THE ARCHITECTURAL PROBLEM, and the chosen answer

The BE is containerised; the pipeline runs ON THE HOST (§5.1b/C, MVP keeps it there). A container
cannot exec a host process, so "press Save -> launch" needs a mechanism. Options considered:
mount the docker socket (only helps if the pipeline is containerised too, and grants
root-equivalent access), SSH from container to host (key management to solve what a directory
solves without credentials), or run the BE on the host (simplest, but one uncontainerised piece).

**CHOSEN: a spool directory plus a host-side runner.**

    Flutter FE (container, nginx)
        |  JSON over HTTP
    Node BE (container)  --writes-->  /spool/requests/<id>.json   [bind mount]
                         <--reads---  /spool/status/<id>.json
                                              ^
                                              |
    host-side runner (systemd unit or loop)  --launches-->  tier3-metrolinx-run.sh

Why this one:
  - the container never receives host privileges; the trust boundary is ONE directory
  - the runner owns the lock, so "reject while busy" is enforced where the truth is, not in the API
  - stop and busy-check become file operations; the API never handles PIDs or process groups
  - it queues naturally if the policy is ever relaxed from reject-while-busy

### 5.5.4 Every input already exists on disk — verified at v1.6

| The UI needs | Source | Verified |
|---|---|---|
| current stage name | `orchestrations/logs/step-status.json` — 30 steps of `{id,label,status,detail}` plus `updatedAt`; the step whose `status` is `running` IS the stage name | read |
| run list for the grid | `orchestrations/projects/<project>/runs/<runId>/` directories | listed |
| final verdict | `orchestrations/logs/phase-gates.jsonl` (the GO / NO-GO decision) | present |
| cost, if ever shown | `orchestrations/logs/phase-cost.jsonl` | present |
| stop | `kill-tier3-run.sh` — kills by process group (`ps -o pgid=`) | read |
| busy | the run's systemd scope / `/tmp/tier3-*.pid` | observed |

So the BE is genuinely thin: it writes a request, lists directories, reads two JSON files, and
returns them. It computes nothing the pipeline does not already record.

**One caveat that must shape the BE:** `step-status.json` is a SINGLE global file, overwritten per
run — it describes the CURRENT run, not history. The BE must correlate it with the active run id
and must not present it as the status of a completed run. History comes from the `runs/` directories
and `phase-gates.jsonl`.

### 5.5.5 Requirements that follow from the day this was designed

  - **A failed run must say so in the grid.** "Pending" that silently never advances is the same
    silent-failure shape removed elsewhere; a stale `updatedAt` is a FAILED run, not a running one.
  - **The shared password gates creation, not viewing** — cost is spent on create.
  - **Every run records who requested it**, even with a shared password, because the next question
    after "why is this expensive" is "who ran it".

### 5.5.6 Still blocked

The launch path itself does not exist (§6.2). The spool directory and host runner ARE that missing
piece — this design is the answer to §6.2, not a consumer of it.

---

## 6. The HTTP API (control plane) — what is real

The operator described this as a known existing feature: the pipeline can be invoked over an API
from Postman. **An HTTP API exists and is genuinely wired. It cannot start a run.** Both halves of
that sentence are load-bearing, so this section separates what works from what does not.

> **A correction I owe the reader.** My first sweep concluded the control plane had no callers
> outside tests — a `head -20` truncated the grep before it reached
> `run-agent-orchestration.sh:1483`. Re-run without truncation, it has three call sites. The
> feature is more real than that first pass suggested, and the count inflation ran the other way
> for once. Everything below is from the untruncated read.

### 6.1 What exists

`orchestrations/scripts/control-plane.js` (233 lines) is an HTTP sidecar on **port 8094** by
default (`:26`, `CONTROL_PLANE_PORT`). It binds `0.0.0.0` (`:229`), which is deliberate — a test
asserts it (`test/unit/orchestration/preflight-integrity.test.ts:244`, *"control-plane.js binds
0.0.0.0 (WSL2 accessible)"*) — so it **is** reachable from Windows against a WSL2 run.

It is started by the orchestrator, not by hand: `start_control_plane()` at
`run-agent-orchestration.sh:1472-1500`, called once at `:4198`, torn down by `stop_control_plane()`
(`:1511`) from cleanup at `:4003`. **Its lifetime is the run's lifetime.**

| Method | Path | Effect | Wired end to end? |
|---|---|---|---|
| `GET` | `/health` | `200 OK` | yes (`:144`) |
| `GET` | `/status` | `{ paused, pendingRedirects[] }` | yes (`:150`) |
| `POST` | `/pause` | writes `$LOG_DIR/PAUSED` | **yes** — consumed by `wait_if_paused()` at `lib/story-guards.sh:94-97`, which blocks between stories |
| `POST` | `/resume` | removes `$LOG_DIR/PAUSED` | **yes** — same consumer |
| `POST` | `/redirect/:storyId` | writes `$LOG_DIR/redirect-<storyId>.json` | **yes** — consumed at `lib/story-guards.sh:123-126` |
| `POST` | `/webhook/jira` | HMAC-verifies, adapts, enqueues | **partially — see §6.2** |

Pause, resume, redirect and status are real: each writes a sentinel that a named consumer in
`story-guards.sh` reads. **If you have a run in flight, you can steer it from Postman today.**

### 6.2 What does not exist: starting a run

**No endpoint launches a pipeline run.** Not one of the six. Specifically for `/webhook/jira`:

1. `:194` calls `webhookQueue.enqueue(event)` and returns `202 {status:"queued"}`.
2. `lib/webhook-queue.js` requires **only `fs` and `path`** (`:21-22`). There is no
   `child_process`, no `spawn`, no `exec` anywhere in the module.
3. `flush()` (`:98`) writes `webhook-prd-<projectKey>-<timestamp>.json` (`:147-150`) and calls the
   `onFlush` callback.
4. That callback (`control-plane.js:44-46`) prints one line: `webhook PRD ready: <path>`.
5. **Nothing consumes `webhook-prd-*.json.`** A repo-wide grep across `orchestrations/` and `src/`,
   excluding tests and the writer itself, returns no reader.

So the webhook is a **PRD-file producer, not a trigger**. The chain ends at a file on disk that no
process watches. This matches the prior note in project memory that the webhook "launches nothing",
and it contradicts the documentation — see §6.5.

There is a second, structural reason it cannot be a trigger: **the control plane only runs while a
run is already running.** It is started at `run-agent-orchestration.sh:4198` and stopped in that
run's cleanup. With no run in progress there is no listener on 8094 to receive the call.

### 6.3 Which port, actually

Not always 8094, and on a Jira run **never** 8094. `_resolve_control_plane_port()`
(`run-agent-orchestration.sh:576-626`):

- explicit `CONTROL_PLANE_PORT` always wins (`:582-584`);
- the **parent** orchestrator reserves the base port, 8094 (`:602-604`);
- each **lane** gets `8094 + 1 + <index in project.outputDirs>` (`:626`) — so 8095, 8096, 8097 for
  a three-codeline project, with a `cksum % 64` fallback when the index cannot be resolved (`:623`).

**On a Jira/brownfield run the parent never binds 8094 at all.** `run-agent-orchestration.sh:3943-3946`
dispatches `if is_parent; then if [ "${JIRA_PIPELINE:-0}" = "1" ]; then _run_jira_pipeline; exit $?`
— which exits 253 lines *before* `start_control_plane` at `:4198`. Only the lanes, which are not
`is_parent`, fall through and start one. **A Postman user on a metrolinx run must target 8095+, one
port per codeline, and there is no aggregate endpoint across lanes.**

The per-lane design is deliberate and hard-won: the comment at `:557-573` records three lanes all
binding 8094, each killing the last, because `start_control_plane` kills whatever holds the port
before binding (`:1490-1497`).

### 6.4 Auth, exposure, and a caution

**Default auth is none.** `verifyJiraSignature()` (`control-plane.js:53-55`):

```js
if (!JIRA_WEBHOOK_SECRET) return true; // dev mode — accept all
```

With `JIRA_WEBHOOK_SECRET` unset — which is the default, and it is not set in any config file in
this repo — **every route is unauthenticated**, on a socket bound to `0.0.0.0`. `/pause` and
`/redirect/:storyId` change the behaviour of a paid run in flight. The other five routes have no
signature check at any time; only `/webhook/jira` consults the secret.

Nothing publishes the port: **8094 appears in no compose file and in no nginx config** (grepped
across all three `docker-compose*.yml` and `orchestrations/dashboards/nginx.conf`). It is a host
process, so exposure is whatever the host's network allows — on a laptop that is usually fine, on a
shared or client network it is not. I would not represent this as a secured interface, and the plan
should not enable it beyond localhost without an explicit decision.

### 6.5 Documentation drift

`TECHNICAL-GUIDE.md:207-210` and `QUICKSTART.md:50` describe "Jira webhook **triggers**" and
"webhook triggers" as a capability. §6.2 shows the chain terminates at an unread file. The
TECHNICAL-GUIDE text is accurate about *mechanism* (HMAC, adapter, debounced queue, 45-second
window, `.epam/webhook-queue.json` persistence) and misleading about *outcome*. Worth correcting
when the docs are next touched; flagged, not fixed.

### 6.6 Postman: what you can actually do

**Prerequisite: a run must already be in progress**, and you need its port (§6.3) and its
`LOG_DIR`. There is no way to start a run over HTTP.

Base URL from Windows against a WSL2 run: `http://localhost:8095` usually works via WSL2's
localhost forwarding; if it does not, use the distro's IP from `wsl hostname -I`. *(Forwarding
behaviour is environment-dependent and I did not test it — see Open Question 16.)*

```
GET  http://localhost:8095/health
     → 200  (empty body)

GET  http://localhost:8095/status
     → 200  { "paused": false, "pendingRedirects": [] }

POST http://localhost:8095/pause
     Content-Type: application/json
     (no body required)
     → 200  { "paused": true }
     Effect: the run blocks at the next story boundary (story-guards.sh:94-97).

POST http://localhost:8095/resume
     → 200  { "paused": false }

POST http://localhost:8095/redirect/AI-1234
     Content-Type: application/json
     { "targetAgent": "backend-implementation-agent" }
     → 200  { "storyId": "AI-1234", "targetAgent": "...", "requestedAt": "..." }
     400 if targetAgent is missing or blank (control-plane.js:205-208).

POST http://localhost:8095/webhook/jira
     Content-Type: application/json
     X-Hub-Signature-256: sha256=<hmac>     (only checked if JIRA_WEBHOOK_SECRET is set)
     { "webhookEvent": "jira:issue_created", "issue": { ... } }
     → 202  { "status": "queued", "jiraKey": "...", "urgent": false }
     → 202  { "status": "ignored", "reason": "unrecognised event type" }  for unhandled events
     ⚠ Queues an event and eventually writes a PRD file. DOES NOT START A RUN.
```

Response shapes are read from the `send(res, …)` calls at `control-plane.js:144-215`; I did not
execute any of them, since exercising `/pause` or `/redirect` means interfering with a live run.
**Treat the bodies as read-verified, not round-trip-tested.**

### 6.7 Honest summary

| Claim | Verdict |
|---|---|
| An HTTP API exists | **True.** 6 routes, 233 lines, started automatically, `0.0.0.0`-bound, test-covered |
| It can pause/resume/redirect a live run from Postman | **True and fully wired**, consumers named in `story-guards.sh` |
| It can **invoke** the pipeline / start a run | **False.** No route does this; the webhook chain ends at a file nothing reads |
| It is available when no run is going | **False.** Lifetime is the run's lifetime |
| It listens on 8094 | **Not on a Jira run.** Lanes bind 8095+; the parent exits before starting one |
| It is authenticated | **Not by default.** Five routes never check; the sixth checks only if `JIRA_WEBHOOK_SECRET` is set |

**Bottom line for the operator: this is a run-control API, not a run-invocation API.** If
"invoke the pipeline from Postman" is a requirement, it is *new work* — the gap is small in code
(a route that shells out to `pipeline --jira <TICKET>`) and large in consequence, because it would
make an unauthenticated `0.0.0.0` socket capable of spending money. That is a decision for the
operator, not an implementation detail, and it is in Open Questions rather than proposed here.

---

## 7. Design — launching a run over HTTP

The requirement: POST a ticket id from Postman, the run starts. §6 established this is not possible
today. This section designs it.

### 7.1 The structural problem, stated plainly

**A listener started by the orchestrator cannot start the orchestrator.** `control-plane.js` is
spawned at `run-agent-orchestration.sh:4198` and killed from that run's cleanup at `:4003`. Its
lifetime is contained by the thing it would need to create. No amount of adding routes to it fixes
this: when no run is going, there is no process to receive the call.

So **launching requires a second, always-on service** whose lifetime is the machine's, not a run's.
That is the whole architectural decision; everything below follows from it.

The two services are then cleanly split by lifetime, and the split is worth keeping explicit:

| | Launch API (new) | Control plane (exists) |
|---|---|---|
| Lifetime | always on | one run |
| Started by | the OS (user service) | the orchestrator |
| Port | one, fixed | 8094 base, 8095+ per lane |
| Knows about | projects and launchers | one run's `LOG_DIR` |
| Can start a run | **yes** | no |
| Can steer a run | no | yes |

### 7.2 What is reusable, and what is not

Read from `control-plane.js` (233 lines):

| Part | Lines | Reusable? |
|---|---|---|
| Node `http.createServer` + manual `url.parse` routing | `:130-136` | **Yes** — copy the shape. No framework, no dependency, consistent with the engine's zero-dependency posture |
| `send(res, code, obj)` JSON helper | used `:144-215` | **Yes** |
| CORS/`OPTIONS` short-circuit | `:137-142` | **Yes** |
| HMAC verification *shape* | `:53-66` | **Shape yes, default no** — see §7.5 |
| `EADDRINUSE` → exit 0 rather than crash | `:220-225` | **Yes**, and important for a restartable service |
| SIGTERM/SIGINT clean close | `:232-233` | **Yes** — a user service needs it |
| `LOG_DIR` requirement, `process.exit(1)` if unset | `:32-35` | **No.** Run-scoped. The launcher has no `LOG_DIR` until a run exists |
| `PAUSED` / `redirect-*.json` sentinel writing | `:156-215` | **No.** They address one run's `LOG_DIR` |
| Per-lane port derivation | `run-agent-orchestration.sh:576-626` | **No.** The launcher is a singleton on one fixed port |
| `webhook-queue.js` + `jira-adapter.js` | — | **No.** The queue writes PRD files nothing reads (§6.2). Do not build the launcher on top of a dead path |

**Roughly 60 of the 233 lines are reusable scaffolding.** The new service is small — the work is in
correctness, not volume.

### 7.3 The endpoint

```
POST /launch
  Authorization: Bearer <EPAM_LAUNCH_TOKEN>
  Content-Type: application/json

  { "ticket": "AMSD-2041" }

  optional:
  { "ticket": "AMSD-2041",
    "project": "metrolinx",          // override the derived project
    "providerSet": "claude",         // else provider-sets.json defaultSet
    "pauseAfterAgentMint": true,     // else the project's own config
    "pauseBeforeWriter": true }
```

Responses:

| Code | Body | When |
|---|---|---|
| `202` | `{ "status":"launching", "ticket", "project", "providerSet", "runId", "pidFile", "logFile", "controlPlanePortBase":8095 }` | accepted and spawned |
| `400` | `{ "error":"ticket must look like ABC-1234" }` | malformed ticket (§7.7) |
| `401` | `{ "error":"unauthorized" }` | bad or missing token |
| `409` | `{ "error":"a run is already in flight", "project", "pid" }` | pid file live (§7.6) |
| `422` | `{ "error":"no project declares the ticket prefix 'XXX'", "known":[…] }` | derivation failed |
| `503` | `{ "error":"pre-launch validation failed", "problems":[…] }` | the dry run refused |

`202 Accepted`, never `200 OK`. The run has been *started*, not *completed* — and §7.4 shows the
service cannot honestly claim more than that.

Supporting routes, all read-only:

```
GET /health                  → 200
GET /projects                → the ticket-prefix table (shells out to `pipeline --list`)
GET /runs                    → every live /tmp/tier3-*.pid, with liveness
GET /runs/<project>          → { running, pid, runId, logFile, controlPlanePorts[] }
GET /runs/<project>/log?tail=200  → last N lines of the run's log
```

### 7.4 How it invokes the run — and what `setsid` costs

**It shells out to the existing executor. It does not reimplement any part of a run:**

```
EPAM_PROVIDER_SET=<set> AUTO_YES_TIER3=1 \
  nohup orchestrations/scripts/pipeline --jira <TICKET> \
        >> /tmp/tier3-<project>-<stamp>.log 2>&1 &
```

`pipeline` already validates, derives the project, checks the runner, and `exec`s `orchestrate.sh`
(`pipeline:147`). A second implementation of the run is exactly what `pipeline`'s own header warns
against.

**The `setsid` consequence is not theoretical — I measured it.** A launcher that re-execs
`exec setsid bash "$0"` (`orchestrate.sh:93-95`, and every `tier3-*-run.sh`) detaches into a new
session. In a scratch reproduction of that exact idiom:

- the caller returned **rc=0 after 0 seconds**, while the child slept 4;
- at the instant the caller returned, the child **had not yet written its first log line**;
- the child ran in its own session (child pgid ≠ caller pgid) and outlived the caller.

**Therefore: the spawn's exit code is meaningless.** `rc=0` means "the fork happened", not "the run
started", and certainly not "the run succeeded". A service that reports success from the exit
status would report success for a run that dies one second later in pre-flight.

What the service can honestly do:

1. Spawn, and immediately return `202 launching` — never `200 started`.
2. **Poll `/tmp/tier3-<project>-run.pid` for the truth.** `orchestrate.sh:120-122` writes `$$` there
   and traps `rm -f` on `EXIT`, so the file's existence *and* `kill -0 <pid>` together are the real
   liveness signal. Poll for up to ~20 s before returning, so an immediate pre-flight refusal is
   reported as `503` rather than a false `202`.
3. For "finished", offer `GET /runs/<project>` and let the caller poll. **Do not** promise a
   completion callback: the service never becomes the run's parent, so it cannot `wait()` on it and
   cannot observe its exit status at all.

`setsid -w` exists and would make the child waitable — **do not use it.** Detachment is what
`kill-tier3-run.sh` depends on: it signals the negative PGID to reach the whole tree
(`kill-tier3-run.sh:13-16, 70-76`). Making the run waitable would break the kill path, which is the
one thing that reliably stops a run that is spending money.

> **Consent is the subtle part.** `orchestrate.sh:187-192` prompts before spending unless
> `AUTO_YES` is set, and `:129` sets it only for `CI=true` or `AUTO_YES_TIER3=1`. The comment at
> `:130-143` is emphatic that **absence of a terminal is not consent**, and records two runs
> launched accidentally by a test. A launch API is precisely a non-terminal launch, so it must pass
> `AUTO_YES_TIER3=1` explicitly — which means **the authenticated HTTP request becomes the
> operator's "yes"**. That is the honest framing, and it is why §7.5's token is not optional.

### 7.5 Auth — one shared secret, and no more

Per the operator's rule that credentials are a single hand-written `.env`:

- **`EPAM_LAUNCH_TOKEN`**, one line in `.env`, generated by the operator (`openssl rand -hex 32`).
- Checked on **every** route via `Authorization: Bearer <token>`, compared with
  `crypto.timingSafeEqual` on equal-length buffers.
- **The service refuses to start if the variable is unset or empty.** It does not warn and continue.
- Bind **`127.0.0.1` by default**, not `0.0.0.0`. WSL2 reachability from Windows is a deliberate
  opt-in via `EPAM_LAUNCH_BIND`, not the default.

That is the entire auth design. No users, no roles, no sessions, no key rotation.

**Is the control plane's current default acceptable for a launch endpoint? No — plainly not.**
`control-plane.js:53-55` reads:

```js
if (!JIRA_WEBHOOK_SECRET) return true; // dev mode — accept all
```

Unset — which is the default, and no config file in this repo sets it — every route accepts
everything, on a `0.0.0.0` socket. For pause/resume that is a nuisance. **For a launch endpoint it
is an unauthenticated way to spend money on someone else's LLM account**, and per §7.4 the request
itself carries the spend consent. Fail-closed is the only defensible default here, and the
launch service must not inherit the fail-open pattern.

### 7.6 Concurrency — reuse the pid file, invent nothing

State already exists and is already reasoned about; the design adds none.

- `orchestrate.sh:120-122`: `TIER3_PID_FILE="${TIER3_PID_FILE:-/tmp/tier3-${PROJECT}-run.pid}"`,
  writes `$$`, `trap 'rm -f …' EXIT`.
- `kill-tier3-run.sh` collects **every** `/tmp/tier3-*.pid` — its header records the defect where a
  hardcoded default pidfile meant metrolinx runs were never group-killed.

Rules:

1. Before spawning, read `/tmp/tier3-<project>-run.pid`. If it exists **and** `kill -0 <pid>`
   succeeds → `409` with the live pid.
2. If the file exists but the pid is dead, it is **stale** — a run killed with `SIGKILL` never ran
   its `EXIT` trap. Log it, remove it, proceed. Do not refuse on a stale file; that would need a
   human to clear it.
3. Concurrency is **per project**, matching the pid file's own granularity. Two different projects
   may run at once; the same project may not.
4. The check-then-spawn window is racy. Given a single operator this is acceptable; if it matters,
   guard it with `flock` on the pid file — the same primitive the engine already uses in 29 places.

**Do not** add a database, a queue, or a second run registry. The pid file is the existing source of
truth and `kill-tier3-run.sh` already treats it as such.

### 7.7 What it must not do

| Prohibition | Enforcement |
|---|---|
| Must not accept an arbitrary command | The only external input reaching a shell is the ticket, validated against `^[A-Z][A-Z0-9]+-[0-9]+$` **before** use. Spawn with an argv array — never a shell string, never `shell: true` |
| Must not bypass pre-flight | It calls `pipeline`, which validates and hands off. It must not call `run-agent-orchestration.sh` directly, and must not set `EPAM_PREFLIGHT_ENVIRONMENT=0`, `OBSERVABILITY_PREFLIGHT=0` or any skip flag from §2.3 |
| Must not skip the pause gates | It never sets `EPAM_PAUSE_*` to `0`. It may set them to `1` on request; the project's own config decides otherwise. A resume is a separate explicit call carrying `EPAM_RESUME_RUN` |
| Must not run as root | The user service runs as the operator, who owns `/opt/epam-cli/state` and the runner's OAuth session. Root would break `claude`'s credentials anyway |
| Must not spend without consent | Passes `AUTO_YES_TIER3=1` only on an authenticated request (§7.4, §7.5) |
| Must not become a second pipeline | Its only job is validate → spawn → report. Every run decision stays in `pipeline`/`orchestrate.sh` |
| Must not accept a project path or PRD path | `project` is validated against the directories under `orchestrations/projects/`, never used as a path fragment |

### 7.8 The blocker: inert `JIRA_TICKET`

**This design cannot ship correctly until §0.2 is fixed, and would be actively dangerous shipped
before it.**

`pipeline:146` exports `JIRA_TICKET`; nothing reads it. The ticket actually run comes from the
project's `JIRA_JQL` (`metrolinx/config.env:44` = `issue = AMSD-1919`), consumed at
`jira-client.js:355-359`. A launch API inherits this exactly: `POST {"ticket":"AMSD-2041"}` would
return `202 {"ticket":"AMSD-2041"}` and run **AMSD-1919**.

That is far worse over HTTP than at a terminal. At a shell the operator sees the run's own output
and may notice the wrong ticket. Over an API the response *confirms the ticket they asked for*, so
the artefact is a machine-generated, authoritative-looking lie — and the run costs money.

Three requirements, in order:

1. **Fix the plumbing first** (§5.2): derive `JIRA_JQL="issue = <TICKET>"` when a ticket is named,
   leaving the project's own `JIRA_JQL` in force only when it is not.
2. **Test it at the receiver**, asserting on the JQL that reaches `searchIssues` — not by grepping
   for the variable name. The present defect *is* a name that exists and is never read, so a
   name-presence test would pass against the bug.
3. **Make the launch API echo the resolved JQL** in its `202` body. If the caller can see
   `"resolvedJql": "issue = AMSD-2041"`, this class of defect cannot hide behind a confirmation
   that merely repeats the request.

### 7.9 Deployment

A user-level systemd unit (`systemctl --user`), or `wsl.exe --exec` at boot on Windows. The repo
contains **no** `.service` or `.socket` unit today, so this is new. The unit must:
`WorkingDirectory=/opt/epam-cli/current`, `EnvironmentFile=/opt/epam-cli/state/.env`,
`Restart=on-failure`, run as the operator, and **not** be enabled by default — the installer offers
it, per §5.1's rule that a default is a decision.

Under WSL2 a user service needs `systemd=true` in `/etc/wsl.conf` (recent WSL only), and the distro
must be kept alive. Neither was tested — Open Question 20.

### 7.10 Effort and phasing

| Phase | Work | Estimate |
|---|---|---|
| **0** | **Fix `JIRA_TICKET` → `JIRA_JQL` + receiver test** (§7.8). Blocking. | 0.5–1 day |
| 1 | `launch-api.js`: routing, bearer auth, ticket validation, `/health`, `/projects` | 1 day |
| 2 | `POST /launch`: spawn, pid-file concurrency, 20 s liveness poll, honest `202` | 1–1.5 days |
| 3 | `GET /runs`, `/runs/<project>`, `/runs/<project>/log` | 0.5 day |
| 4 | systemd unit + installer integration (opt-in) | 0.5 day |
| 5 | Tests: ticket-injection rejection, 409 on live pid, stale-pid recovery, 401 paths, **and a mock-run end-to-end launch** | 1–1.5 days |
| | **Total** | **~5–6 working days**, of which phase 0 is mandatory and phase 5 is where the real risk sits |

**Caveats on that estimate.** It assumes the no-`src` deployment (§5.4 phase 0) is already proven,
since a launch API on an unproven install multiplies causes for any symptom. It excludes the
WSL2/systemd unknowns in §7.9. And phase 5's end-to-end test must run against the **mock** stack —
a launch API whose test suite can spend money is precisely the shape that launched two accidental
runs on 2026-08-21 (`orchestrate.sh:130-143`).

### 7.11 Risks

1. **`JIRA_TICKET` (§7.8).** Ships a confident wrong answer. Blocking; phase 0 exists for it.
2. **`202` read as "it worked".** `setsid` makes the exit code meaningless (§7.4). Mitigation: the
   word `launching`, never `started`; the liveness poll; `/runs/<project>` as the real status.
3. **An unauthenticated launch endpoint spends money**, and the request *is* the spend consent
   (§7.4). Mitigation: fail-closed token, `127.0.0.1` default. The existing fail-open default
   (§7.5) must not be copied.
4. **Two things that can start runs** — the shell and the API — can double-launch. Mitigation: both
   go through `pipeline` and the same pid file (§7.6); the API adds no state of its own.
5. **A long-lived service drifts from the release it launches.** After an upgrade flips `current`
   (§5.0.5), a service started from the old path keeps running old code. Mitigation: the unit's
   `WorkingDirectory` is `current`, and the upgrade restarts it — worth stating in §5.0.8's flow D,
   which does not currently mention it.

---

## 8. Requirements traceability

| # | Requirement | Status | Where |
|---|---|---|---|
| 1 | Installer deploys without `/src`; built CLI still works | **Feasible.** All four staleness gates tolerate a missing `src/`; two deliberately, two by accident. `dist/sdk.js` is the hard dependency, not `dist/epam.js` | §1.2, §1.3, §5.3 |
| 2 | With/without docker; code works both ways | **Feasible.** No service is required by the run. Six preflight sites and one launcher site must become mode-aware | §2 |
| 3 | One installer, PowerShell + Ubuntu/WSL | **Qualified.** One bash installer; PowerShell is a WSL2 front door. Native PS is a rewrite of ~52k lines of shell | §4 |
| 4 | Very easy; claude/codemie only, no minimax/openrouter | **Feasible.** `provider-sets.json` already declares `credentials: []` for both, and `set-credentials.sh` already honours it. Blocker is `tier3-metrolinx-run.sh:153-154` — documented, not fixed | §3.1, §3.3 |
| 5 | `run pipeline AMSD-XXXX` and nothing else | **Shape exists, argument is inert.** `pipeline` is the right design; `JIRA_TICKET` has no consumer. Compounded by `--dry-run` never reaching the arg parser | §0.2, §0.7, §5.2 |
| 6 | Executors on PowerShell or Ubuntu | **Via WSL2** | §4.3 |
| 7 | Plan only | Honoured. No code, config, script or template changed | — |

---

## 9. Top risks

1. **Phase 0 has not been done.** The claim "the pipeline runs with no `src/`" rests on reading four
   guards, not on a run. If any of the 51,849 lines of shell reads `src/` on a path I did not cover,
   it surfaces as a mid-run failure after money is spent. **Mitigation: phase 0, on a mock run.**
2. **The ticket argument is inert, and its shape is exactly the shape that hides.** A variable
   exported and never read passes every "is it wired?" test. The same class of defect appears three
   times in this codebase's own history (the plan-fidelity gate, the prompt-review adapter, the
   inert runner declaration). **Mitigation: assert on the JQL that reaches Jira.**
3. **The no-docker path is unguarded, not docker-optional.** `orchestrate.sh` has no preflight at
   all. Shipping "docker is optional" today means shipping "there is no preflight", which will be
   read as a docker feature and discovered as a preflight absence. **Mitigation: phase 2 before any
   release.**

4. **The orchestrator's flags are parsed after the run has already been dispatched.**
   `run-agent-orchestration.sh:3945` runs `_run_jira_pipeline; exit $?` while
   `parse_orchestration_args "$@"` is at `:4040`. On the Jira path `--reset`, `--dry-run`,
   `--sandbox`, `--mode` and `--help` are all silently inert; only `--phase` survives via the
   pre-scan at `:3888-3896`. Two launchers pass `--reset` believing it does something
   (`orchestrate.sh:362`, `tier3-metrolinx-run.sh:564`). This is the same class as risk 2 — a flag
   that exists, is passed, and is never read — and it means **no downstream "validate without
   spending" is available to the executor.** Mitigation: validate in the executor (§5.2); treat
   fixing the ordering as out of scope for this plan but worth a ticket.

5. **A naive package ships eight live credentials and 115 MB of client work product.** The
   working tree holds real Atlassian tokens and six API keys (§5.0.6); all are untracked and
   gitignored, so `git archive` is safe and `tar czf … .` is not — the latter produces a ~1.2 GB
   archive containing `projects/metrolinx/runs/`. The safety is a property of the *build
   mechanism*, not of the file layout, which is a fragile place for it to live. **Mitigation:
   §5.0.1's git-archive build plus §5.0.6's three controls, with the secret scan gating the
   assembled artefact rather than the source tree.**

Two more worth naming: WSL2 filesystem semantics (mtimes across 9p feed the staleness gates;
`flock` over `/mnt/c` is unreliable — and `flock` is the *only* concurrency primitive, 29 sites),
and `orchestrations/dashboards/node_modules` being absent, so the with-docker mode currently
depends on `npx` reaching the network on first run (`run-agent-orchestration.sh:2662`).

---

## 10. What I verified vs. what I inferred

**Verified by reading the code** (path:line given throughout): the `EPAM_CLI` call sites and
`provider_to_cli` routing; all four staleness gates; the `dist/sdk.js` requirements; the docker
service classification and all ten hard-fail sites; the Langfuse/agent-monitor fail-open paths; the
credential mechanism in `set-credentials.sh` and its bypass in `tier3-metrolinx-run.sh`; the absence
of any `JIRA_TICKET` consumer; the `require_preflight` distribution across nine launchers plus
`orchestrate.sh`; the shell/JS/Python line counts; the symlink and absolute-path inventory.

**Verified by running read-only commands:** file sizes, line counts, `git ls-files dist` (empty),
`.gitignore` contents, tool availability on this host, the `epam` shim's contents, the current
`dist/epam.js` bytes.

**Inferred, not verified:** that the minimum file set in §1.4 is sufficient (that is phase 0's job);
that WSL2 will behave; that the four installer questions are enough for a project the operator has
not described yet.

**Not attempted:** running the pipeline, any launcher, the test suite, `docker ps`, or any write
outside this file.

---

## 11. Open questions

1. **Which project does a fresh install target?** Only `metrolinx` declares a ticket prefix
   (`JIRA_PROJECT_KEY=AMSD`); `mock3`, `skyscanner` and `hello-dolly` declare none, so
   `pipeline --list` shows them blank and no ticket can select them. Does the installer *create* a
   project from answers, or only configure a shipped one? This changes the installer materially.
2. **Is `dist/epam.js` supposed to be the hello-world stub?** `src/index.ts` is committed in that
   state. If the real CLI entry moved to `src/sdk.ts`, then `package.json:29-32`'s `bin` and the
   `epam` shim point at a stub — and `llm-handler.sh:400`'s `"$EPAM_CLI" run` cannot work on the
   openrouter stack. I did not investigate; it may be transient working-tree state.
3. **Does `dashboard-health-check.sh --fix` actually work?** It targets
   `docker-compose.epam-cli.yml:23` while `pre-run-reset.sh:52` targets
   `docker-compose.observability.yml`. Both resolve to the same default compose project name, so
   `restart agent-monitor` probably finds the container either way — **not confirmed by execution**,
   and it is a real single-point-of-maintenance divergence.
4. **Are Grafana's provisioned dashboards (`orchestrations/dashboards/grafana/`) consumed by
   anything automated?** No script was found reading them; the dashboard JSON was not enumerated.
5. **What is the deployment target's Python situation?** `orchestrations/scripts/.venv` exists here
   with `anthropic>=0.40.0`; the root `requirements.txt` wants `pydantic>=2.0` and notes PEP 668
   friction. Does the installer create a venv, or require a system Python?
6. **Should the release carry `orchestrations/dashboards/` (165 M) in no-docker mode?** The Eleventy
   watcher is a host process and would still render static HTML the operator could open from disk
   (`run-agent-orchestration.sh:2602-2680`) — so "no docker" need not mean "no dashboards", only "no
   HTTP serving". Operator decision.
7. **Which launchers survive the release?** §3.3 recommends shipping only `pipeline` →
   `orchestrate.sh`. That is a behaviour decision, not a technical one, and I have not made it.
8. **Are `ESCALATION_MODEL`, `EPAM_GATE_TIMEOUT_SECS`, `ORCH_MINI_MODEL`, `ORCH_UPGRADE_MODEL`,
   `RUNCLAUDE_TIMEOUT_MS` and the `SPEC_MODE_*_MODEL` family still live?** `tier3-metrolinx-run.sh`
   exports them at `:326-359`, but no metrolinx config file sets several of them, so they are
   exported **empty**. They may be vestigial from before provider sets. An empty exported variable
   is exactly the shape that produced the `--provider ${EMPTY}` class of defect, so this is worth
   settling before the installer starts writing env files.
9. **Only 9 of the 30 files in `orchestrations/config/` were traced to a reader.** The rest are
   presumably read by child scripts (`ingest-jira-tickets.sh`, `contextualize-stories.sh`,
   `resolve-codeline-scope.sh`, `team-lead-review.sh`) that were not followed. The packaging list
   in §5.3 ships the whole directory, so this does not block — but "which config files matter" is
   not fully answered.
10. **Where are release artefacts hosted?** Not determinable from the code — there is no
   publish step, no registry reference and no CI release workflow found. An internal artifact
   store, a GitHub release, or a shared drive are all consistent with what is in the repo. This
   decides how `install.ps1` fetches the tarball (§5.0.4) and whether checksums need a detached
   signature as well as a digest.
11. **Is `orchestrations/scripts/scan-secrets.sh` fit to gate a release?** It exists and was **not**
   assessed — I did not read it. §5.0.6 requires a scan that runs over the *assembled artefact* and
   *fails the build*; whether this script does either is unknown. If it is oriented at scanning
   client repos for agent-introduced secrets, it is the same category error as reusing
   `repo-artifacts.json` (§5.0.1) and a separate gate is needed.
12. **Does `zip` preserve the three symlinks?** `zip` is not installed on this host so I could not
   test it, and I have not asserted its behaviour. §5.0.4 routes around the question by carrying a
   `.tar.gz` inside the `.zip`; if a native-Windows tree is ever wanted, this must be settled by
   running it.
13. **Which project template ships?** §5.0.6 proposes `mock3` (692 KB excluding `runs/`) as a
   neutral basis, but `mock3` is a rehearsal fixture and may carry assumptions a real project
   should not inherit. Whether the installer *generates* a project from answers or *renders a
   shipped template* is the same unresolved question as Open Question 1, seen from the packaging
   side.
14. **Should `node_modules` ship, or should the installer run `npm ci`?** §5.0.7 assumes a pruned
   ~1 MB tree ships, which keeps the install offline-capable. The alternative needs network and a
   registry the client can reach. `keytar` is a native module, so a shipped copy is
   platform-specific — under WSL2 that is Linux-x64 only, which is fine, but it makes the artefact
   arch-bound rather than portable. Not decided here.
15. **Should the API be able to START a run?** It cannot today (§6.2, §6.7). Adding a route that
   shells out to `pipeline --jira <TICKET>` is small in code and large in consequence: the socket
   is `0.0.0.0`-bound and unauthenticated by default (§6.4), so it would become a way to spend
   money without a terminal. Needs an explicit operator decision on auth and binding first, and it
   would also collide with the spend-confirmation rule at `orchestrate.sh:181-186` — absence of a
   terminal is not consent.
16. **Does WSL2 localhost forwarding reach the control plane from Windows?** The socket binds
   `0.0.0.0` and a test asserts that is for WSL2 reachability
   (`preflight-integrity.test.ts:244`), but I did not test a Windows→WSL2 call. §6.6 gives
   `wsl hostname -I` as the fallback; **unverified**.
17. **Is `JIRA_WEBHOOK_SECRET` set anywhere in practice?** It appears in no config file in this
   repo, so the default is `accept all` (§6.4). Whether any deployment sets it is unknown.
18. **Should the launch API exist at all, given it turns an HTTP request into spend consent?**
   §7.4 shows the request itself replaces the operator's typed "yes". That is a policy decision the
   code cannot make. §7 designs it fail-closed and localhost-bound, but whether to deploy it is the
   operator's call.
19. **Where does the launch service get its release path after an upgrade?** §7.11 risk 5 — a
   long-lived service started from `releases/1.6.0` keeps running that code after `current` flips.
   The design says restart it on upgrade; §5.0.8's flow D does not yet include that step.
20. **Does a user-level systemd service work in the target WSL2 distro?** It needs
   `systemd=true` in `/etc/wsl.conf` (recent WSL only) and the distro kept alive. **Not tested.**
   If unavailable, the launch service needs a different supervisor on Windows and §7.9 is unproven.
21. **Does the operator want the two human pauses on by default?** `metrolinx/config.env` sets both
   `EPAM_PAUSE_AFTER_AGENT_MINT=1` and `EPAM_PAUSE_BEFORE_WRITER=1`. A "very easy" one-line executor
   that stops twice needs that stated up front — the executor should print it (§5.2), but whether
   the installer should offer to change it is unanswered.
