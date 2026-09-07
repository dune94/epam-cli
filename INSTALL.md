# Installing the amsd-pipeline

Everything below is derived from the scripts that actually do the work:

| What | File |
|---|---|
| The installer | `orchestrations-installer/install.sh` |
| "Can this machine launch a run right now?" | `orchestrations-installer/pipeline-health.sh` |
| Stop/start the services without re-installing | `orchestrations-installer/pipeline-services.sh` |
| Run one ticket | `orchestrations/scripts/pipeline` |

`npx amsd-pipeline` is the same script: `npm-package/amsd-pipeline/bin/amsd-pipeline.js` does nothing
but `spawnSync('bash', [install.sh, ...argv])`, so every flag documented here works identically
through either entry point.

---

## 1. Prerequisites

These are exactly what the installer checks. Nothing here is aspirational — each row names the
check that enforces it.

### Hard requirements (install.sh marks these ✗ and exits 1)

| Requirement | Why (the installer's own reason) | Checked at |
|---|---|---|
| `git` | "the pipeline works on git codelines" | `install.sh` → `need git` |
| `jq` | "the pipeline parses JSON with it throughout" | `install.sh` → `need jq` |
| `node` | "the engine and the CLI are node" | `install.sh` → `need node` |
| `python3` | 88 handlers under `orchestrations/scripts/lib/handlers` are executed with it. All imports are stdlib plus one local module — **there is no venv and no `pip install` step** | `install.sh`, the `python3` block |
| The active stack's **runner CLI** on `PATH` | "the commonest real failure" — the run shells out to it | `install.sh`, resolved from `provider-sets.json` → the stack's `settingsFile` → its first `runners` key |

The runner is *not* named in any script — it is read from config. As declared today
(`orchestrations/config/provider-sets.json` + the `llm-defaults.*.json` it points at):

| Stack (`--stack`) | Runner that must be on PATH | Credentials it declares as required |
|---|---|---|
| `claude` (**default**) | `claude` | none |
| `openrouter` | `claude` | `OPENROUTER_API_KEY`, `MINIMAX_API_KEY` |
| `codemie` | `codemie-claude` | none |
| `mockserver` | `claude` | none |

Run `./orchestrations-installer/install.sh --check` to have the machine answer this for itself
rather than trusting the table.

### Node version

`install.sh` only checks that `node` **exists** — it does *not* check the version. The version
requirement is enforced elsewhere and still real:

- `package.json` → `"engines": { "node": ">=20.0.0" }`
- `.nvmrc` → `20`
- `pipeline-health.sh` warns when the major version is `< 18` and says "20 is what's tested"
- `CLAUDE.md`: **system node on this machine is v14.17.0 and is too old.** Use
  `~/.nvm/versions/node/v20.20.0/bin/node`.

If your default `node` is not 20, put it on `PATH` before installing, or pass it explicitly —
`install.sh`, `pipeline-services.sh` and `pipeline-health.sh` all honour `NODE_BIN`:

```bash
export PATH="$HOME/.nvm/versions/node/v20.20.0/bin:$PATH"
# or
NODE_BIN=~/.nvm/versions/node/v20.20.0/bin/node ./orchestrations-installer/install.sh
```

Installing without Node 20 on `PATH` will pass the installer's `need node` check and then fail at
`npm run build`, because tsup needs it.

### Optional — a container runtime (docker or podman)

**Docker is optional, always.** The dashboards, Langfuse and Grafana are observability; the pipeline
runs without them (`install.sh` header: "DOCKER IS OPTIONAL, ALWAYS ... An installer that fails
because a container is missing teaches people to skip the installer"). With no runtime running, an
`auto` install prints a warning and continues.

- The runtime is **declared, never inferred**: `EPAM_CONTAINER_RUNTIME=docker|podman`. Unset, the
  resolver (`orchestrations-installer/lib/container-runtime.sh`) discovers one.
- `pipeline-health.sh` *probes* (`docker info` / `podman info`) rather than trusting `command -v` —
  a stopped daemon or missing WSL2 integration passes a PATH check and fails the first real `up -d`.

### Platform and headroom (from `pipeline-health.sh`)

- Linux, WSL2 or macOS. Anything else is warned about as untested.
- `bash >= 4` — "this pipeline's own scripts assume bash >=4 in places".
- **>= 2 GB free memory** is a hard FAIL ("a run is likely to OOM this machine"); under 4 GB is a
  warning — "fine for a single run, tight for a run plus dashboards".
- **>= 5 GB free disk** at the install root, or it warns.

### What the pipeline needs but the installer cannot supply

- **Client codelines cloned on disk.** A brownfield project's `JIRA_CODELINE_ROOT` must exist and
  contain git repos; the pipeline *scans* that directory — nothing lists repos by name.
- **Jira credentials** — see §5, this is the gotcha.

---

## 2. Install

### 2a. From your own checkout (installs the tree you are standing in)

```bash
./orchestrations-installer/install.sh
```

Without `--dest`, `install.sh` only ever configures the tree it is already sitting inside.

### 2b. Into a new folder, from a tagged ref (what everyone else uses)

```bash
./orchestrations-installer/install.sh --dest ~/amsd-pipeline --ref v1.51
# or, with no checkout at all — install.sh self-clones:
npx amsd-pipeline --dest ~/amsd-pipeline --ref v1.51
```

`--dest` is what makes the installer useful to anyone who is not this checkout: it packages the
named ref (`git archive`) into `$DEST` and then installs **that** tree. `--ref` defaults to `HEAD`;
tags are fetched first, so a ref someone else just pushed still resolves.

Re-running `--dest` against an **existing** install is the supported update path, and it is
deliberately non-destructive:

- `orchestrations-installer/run-state-paths.json` lists paths the extraction never touches at all
  (`orchestrations/logs`, `orchestrations/projects/*/runs`, `launch-dashboard/data`,
  `launch-dashboard/spool`, `phase-cost.jsonl`, `orchestrations/agents/kb`,
  `orchestrations/projects/*/kb`).
- `operator-config-paths.json` and `generated-run-state-paths.json` are snapshotted before the
  extraction and restored after it, so your `config.env` (and a run's minted agent state) survive an
  update while a *fresh* install still receives them for the first time.

### 2c. All flags

Read from `install.sh`'s own argument parser — this is the complete list:

| Flag | Effect |
|---|---|
| `--dest <path>` | Package the ref into `<path>` and install **that** tree. Creates it if absent. |
| `--ref <tag\|sha\|branch>` | Which commit to package. Default `HEAD`. |
| `--repo <url>` | Clone source when `install.sh` was obtained alone (npx, raw download). Default `https://github.com/dune94/amsd-pipeline.git`, also settable as `EPAM_REPO`. |
| `--stack <name>` | Which provider set to install for. Default: `provider-sets.json`'s `defaultSet`, or `EPAM_PROVIDER_SET`. An unknown name errors and lists the declared stacks. |
| `--no-docker` | Skip the observability stack and the launch dashboard entirely. |
| `--docker` | Require a container runtime — fails if none is running (`auto` merely warns). |
| `--replay on\|off` | Default `off`. `on` installs/uses Langfuse as the **recorder** so a run can be replayed later for $0. Also settable as `EPAM_REPLAY`. An invalid value is rejected, never silently downgraded to `off`. |
| `--check` | Verify an existing install, change nothing. |
| `--uninstall` | Remove **only** this install's docker footprint (containers, network, volumes, images it built) plus the host daemons. **Never deletes files** — your `.env` and run evidence stay. Accepts `--dest`. |
| `--help`, `-h` | Prints the header comment. |

Environment variables the installer reads: `EPAM_PROVIDER_SET`, `EPAM_REPLAY`,
`EPAM_CONTAINER_RUNTIME`, `EPAM_REPO`, `EPAM_PROJECT`, `EPAM_BIN_DIR` (default `~/.local/bin`),
`EPAM_COMPOSE_FILE`, `EPAM_MIN_DIST_BYTES`, `EPAM_LAUNCH_HEALTH_TRIES`,
`EPAM_LAUNCH_HEALTH_INTERVAL`, `NODE_BIN`, and (for §4) `JIRA_URL`, `JIRA_PROJECT_KEY`,
`JIRA_CODELINE_ROOT`.

---

## 3. The first install creates `.env` — fill it in and run install.sh again

On a machine with no `.env` at the install root, the installer copies the template and says so:

```
! .env created from .env.example — FILL IT IN before running
```

Two things to know about that file:

1. **`.env.example` is generated, not hand-maintained.** Every install regenerates it from
   `orchestrations/config/provider-sets.json` and `orchestrations/config/env-vars.json`
   (`lib/generate-env-example.sh`), so it lists exactly the credentials the declared stacks and
   features need. Your real `.env` is never touched. The copy checked into git is not what you will
   see after an install.
2. **The installer then checks the values, not just the file.** If the selected stack declares a
   required credential that is still empty, the install FAILS:
   `✗ the '<stack>' stack needs these, still empty in .env: OPENROUTER_API_KEY ...`

So the first install of a stack with required credentials is a two-step operation:

```bash
./orchestrations-installer/install.sh --dest ~/amsd-pipeline --ref v1.51   # creates .env, then fails
$EDITOR ~/amsd-pipeline/.env                                              # fill it in
./orchestrations-installer/install.sh --dest ~/amsd-pipeline --ref v1.51  # re-run — now it completes
```

On the default `claude` stack, which declares no required credentials, an install can complete with
an empty `.env`; the file is still created and still needs the Jira values below before a brownfield
run will start.

Feature-scoped variables the generated template includes (`orchestrations/config/env-vars.json`):
`JIRA_EMAIL`, `JIRA_TOKEN`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`,
`GITHUB_PERSONAL_ACCESS_TOKEN`. With `--replay on`, the two Langfuse keys are a hard requirement —
"a run not recorded can never be replayed", so the installer refuses rather than recording nothing.

---

## 4. Project configuration (the three things nothing can derive)

`JIRA_URL`, `JIRA_PROJECT_KEY` and `JIRA_CODELINE_ROOT` are answers, not defaults. If you export
them together with `EPAM_PROJECT=<name>` (and that project directory exists), the installer writes
`orchestrations/projects/<name>/config.env` for you:

```bash
EPAM_PROJECT=metrolinx \
JIRA_URL=https://example.atlassian.net \
JIRA_PROJECT_KEY=AMSD \
JIRA_CODELINE_ROOT=/path/to/codelines \
./orchestrations-installer/install.sh --dest ~/amsd-pipeline
```

That file holds **non-secret values only** — the installer never prompts for, echoes, or writes a
token into project config.

---

## 5. Jira credentials are NOT carried into a new install — copy them by hand

**This is a real gotcha, discovered in practice.**

A project's tokens live in the file its `config.env` declares as `SECRETS_FILE`. For the metrolinx
project that is:

```
<install>/orchestrations/jira/metrolinx.env
```

It holds `JIRA_EMAIL` and `JIRA_TOKEN` (plus `CODEGRAPH_ENABLED`) — **not the root `.env`**, and not
`orchestrations/projects/metrolinx/config.env`, which deliberately contains only `JIRA_URL`,
`JIRA_PROJECT_KEY` and the tracker schema.

Why a fresh `--dest` install will not have it:

- `.gitignore:104` ignores `orchestrations/jira/*.env` (only `*.env.example` is committed), so the
  file is untracked;
- `--dest` populates the new tree with `git archive`, which can only ship tracked files;
- it is **not** listed in `operator-config-paths.json` or `generated-run-state-paths.json`, so
  nothing snapshots or restores it either.

Copy it forward yourself:

```bash
cp ~/previous-install/orchestrations/jira/metrolinx.env \
   ~/amsd-pipeline/orchestrations/jira/metrolinx.env
chmod 600 ~/amsd-pipeline/orchestrations/jira/metrolinx.env
```

If you skip this, the install still reports ready, and the run dies at the launcher with
`JIRA_TOKEN is not set. Export it or add it to .env before launching.` — because metrolinx's
`config.env` declares `REQUIRED_KEYS=JIRA_TOKEN`.

---

## 6. What a successful install has done

- `.env` present and this stack's required credentials filled in.
- `dist/epam.js` built (from a source checkout) or verified (a packaged, `src/`-less install). It is
  only a hard requirement for stacks whose runner is the `epam` CLI; on `claude`/`codemie` a stub is
  reported but tolerated.
- An `epam` shim written to `${EPAM_BIN_DIR:-$HOME/.local/bin}/epam`, pointing at **this** install.
  You are warned (never silently edited into a profile) if that directory is not on `PATH`.
- With a container runtime, the observability stack
  (`docker-compose.observability.yml`) and `launch-dashboard/docker-compose.yml` are up, each under
  a project name and subnet unique to this install so two installs cannot collide. Baseline ports —
  Langfuse `3100`, dashboards `8092`, ClickHouse `8123`, Grafana `3001`, launch UI `8099` — are kept
  exactly on a normal single-install machine, and stepped by +10 per retry only on a real collision.
  The identity that was actually used is written to `<install>/.pipeline-services-state.env`.
- Two **host** daemons started (neither is dockerized): `snapshot-watch.js` and, when the launch
  dashboard came up healthy, `runner-host.js`. Both matter — without `snapshot-watch.js` a run's own
  pre-flight hard-fails, and without `runner-host.js` a run queued from the dashboard sits "pending"
  forever.
- On a first launch-dashboard install, `launch-dashboard/.env` is created with a **fixed, known**
  `LAUNCH_PASSWORD=abcd1234`, printed by the installer. It gates a loopback-only UI; change it
  through the dashboard UI after first login.
- `<install>/install-manifest.json` records stack, runner, container runtime, dashboards mode,
  replay mode, project, install root, version and launch-dashboard status.
- `pipeline-health.sh --dest <install>` runs as the last step. It is **advisory** — but if it
  reports problems the installer's final word is "installed, but NOT ready to launch" and it
  exits 1.

---

## 7. Running a ticket — the simplified start script

**It already exists: `orchestrations/scripts/pipeline`.** Do not write another one; its own header
says why — "It is a WRAPPER, not a second pipeline ... A second implementation of the run is how two
things that must agree start to drift."

```bash
cd <install>
./orchestrations/scripts/pipeline --list                    # projects and the ticket prefix each owns
./orchestrations/scripts/pipeline --jira AMSD-1919 --dry-run # check everything, start nothing
./orchestrations/scripts/pipeline --jira AMSD-1919           # run it
```

Everything else is derived. The ticket's prefix selects the project (each project's `config.env`
declares its own `JIRA_PROJECT_KEY`), the project names its codelines, and the active provider set
names the models.

**Environment it needs:** normally none — the values come from files.

- `EPAM_PROVIDER_SET` (optional) picks the stack; unset, `provider-sets.json`'s `defaultSet` wins.
  `install.sh`'s closing hint spells the switch out:
  `EPAM_PROVIDER_SET=<claude|codemie|openrouter|mockserver> ./orchestrations/scripts/pipeline --jira ABC-1234`
- `NODE_BIN` (optional) if Node 20 is not the `node` on `PATH`.

**What it refuses to start on**, printed as a single "✗ this run cannot start:" list:

- no `.env` at the repo root;
- no active provider set and no declared default;
- the project has no overlay `config.<set>.env` for the active stack;
- the stack's runner is not on `PATH`;
- `jq` or `git` missing.

Docker is reported, never required — "dashboards unavailable (docker not running) — the run itself
does not need them".

It then `exec`s the tested launcher: `orchestrate.sh --project <name> --yes`, which is what loads
the env files, in this order (project config wins, deliberately, so a stale global `.env` can never
point a run at the wrong Jira):

1. `<install>/.env`
2. `orchestrations/projects/<name>/config.env`
3. the `SECRETS_FILE` that config declares — e.g. `orchestrations/jira/metrolinx.env`
4. the project config again, so it wins over the secrets file

`orchestrate.sh` then hard-fails on any key listed in the project's `REQUIRED_KEYS` (plus the active
set's own required keys) that is still empty. That is the loud failure you get if §5 was skipped.

### Stopping and restarting the services

Not the same as installing, and **not** `--uninstall` (which deletes volumes):

```bash
bash orchestrations-installer/pipeline-services.sh --stop  [--dest PATH]
bash orchestrations-installer/pipeline-services.sh --start [--dest PATH] [--mock]
```

`--start` reuses the exact subnet/ports/project names recorded in `.pipeline-services-state.env`, so
a stop/start never re-rolls a different identity. `--mock` additionally brings up the MockServer
rehearsal stack; `--stop` always takes it down.

### Checking a machine at any time

```bash
bash orchestrations-installer/pipeline-health.sh --dest <install>   # can I launch a run right now?
./orchestrations-installer/install.sh --check                       # did the install itself complete?
```

They ask different questions on purpose — `--check` is about files and build state, health is about
runtimes, credentials, daemons and probed service endpoints.
