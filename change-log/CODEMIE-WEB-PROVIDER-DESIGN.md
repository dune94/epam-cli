# CodeMie Web provider set — design and estimate

Status: **BUILDING** (operator go 2026-09-28: "go ahead with the spike then the build"). Spike done 2026-09-28.

Build state 2026-09-28 (local commit, not released):
- Wired: seam hub arm, story-writer arm, run exit handler (plugins stopped), result-named failure classes
  (`auth` halts like `credit`), pre-flight `signInProbe`, installer `pythonEnv` (`--check` verifies only).
- £0 greenfield (greenfield-proof) GREEN on codemie-web through the mock agent + mock CodeMie (real SDK, real
  plugin process): 123 calls, 26 private "Pipeline greenfield-proof <agent>" assistants, writer wrote via plugin.
- Regression: test/unit/orchestration with vs without the change — no new failure (the split-map golden
  layout needed +5 for the new source line).
- OPEN: £0 brownfield — the mock agent has no stand-ins for the 7 brownfield-only seams (any set).
- OPEN: lib/story-attempt.sh was already over its 2800-line split ceiling (2852); the writer arm adds 33.

## Requirements (operator, 2026-09-28, verbatim where quoted)

- Pipeline agents run as **CodeMie web assistants** — "these agents will be visible by the Team — this is a
  HARD REQUIREMENT do not drift to alternatives". No local-agent/proxy substitutes.
- "I need this option in place as well equally important as GHCP."
- "Do not share agents codemie web with the Team until we have made brownfield and greenfield green with
  this new provider. Keep agents local, to my name only." → every assistant `shared: false`, in the
  operator's personal project, until a green greenfield AND a green brownfield run on this set.
- Naming: **`Pipeline [codeline] [agent name]`**.
- Must not break existing providers, greenfield or brownfield.

## What is proven (POC, ~/projects/ai/codemie-web-poc, 2026-09-28)

- A **stored** CodeMie assistant with the **`Plugin` toolkit**, bound to a `Plugin` integration holding a
  plugin key, calls tools on this machine through a local `codemie-plugins` process that connects
  **outbound** (NATS, :443). It listed, read and wrote a sandbox directory; the file is on disk.
- `askVirtual` does **not** bind the Plugin tool — stored assistants only.
- Before the integration exists the plugin engine answers `Authorization Violation`.
- Chat accepts per-call `llm_model`, `system_prompt`, `output_schema`, `background_task`; the response
  carries `generated`, `tokens_used`, `success`, `agent_error`, `tool_errors`.
- The `development` toolkit always exposes list/read/write/diff-update/git/run-command, rooted at
  `--repo-path`; run-command allows everything except a short deny list. No read-only switch.
- `codemie-plugins` hard-codes `~/.codemie/config.json` (shared with the CodeMie CLI) → run it with its
  own `HOME`.

## Spike results (2026-09-28, ~/projects/ai/codemie-web-poc, private assistants only)

| Question | Result |
|---|---|
| Long chats on a STORED assistant | claude-sonnet-5 sync 52 s / 13.9k chars; gpt-5.5 sync 48 s / 20.4k chars; both `success:true` — no ~40 s drop |
| `background_task` + `tasks.get` polling | both COMPLETED in 54–55 s — kept as the fallback path, not the default |
| `output_schema` per chat | both models returned a parsed object (`generated` is an object) |
| `llm_model` per chat | accepted by both — one assistant per (codeline, agent) serves every ladder rung |
| Read-only toolkit (`plugin_ro.py`: list, recursive list, read, search) | read + search worked; no write tool offered; nothing written |
| Two plugins (two keys) at once | both connected; each assistant's calls reached only its own plugin |
| `tokens_used` | **null** — cost comes from the platform's spending analytics, not the response |
| Model ids | the claude ladder ids exist in CodeMie's catalog under the same names (claude-sonnet-5, claude-opus-4-8, claude-opus-5, claude-haiku-4-5-20251001) — the map is identity, verified against `llms.list()` at pre-flight |

## Design

### 1. A provider set, declared like the others
`orchestrations/config/provider-sets.json` gains `codemie-web` (settingsFile
`llm-defaults.codemie-web.json`, projectEnvSuffix `codemie-web`, credential: none — it rides the CodeMie
CLI SSO login). The settings file `inheritFrom`s the claude ladders (as the copilot set does) and maps
each ladder model to a CodeMie catalog id from `llms.list()` (catalog fetched once per run, kept in the
run's logs; a ladder model CodeMie does not serve is refused at pre-flight, never guessed).
Config, not code: `config/codemie-web.json` — `project` (the operator's personal project),
`nameTemplate` (`Pipeline {codeline} {agent}`), `shared: false`, plugin engine URI, model map overrides.

### 2. One assistant per (codeline, agent), created on demand, never shared
- Name `Pipeline <codeline> <agent>`; `<codeline>` is the lane's codeline, or the project name for
  project-level agents (ingest, mint, roster review); `<agent>` is the seam or minted role.
- Create-or-update by name in the configured personal project, `shared: false`, idempotent; ids cached in
  the install (`.codemie-web/assistants.json`). The system prompt stays the seam's rendered prompt sent
  per chat (`system_prompt` override), so a template change never needs an assistant rewrite; the stored
  assistant carries the persona and its toolkit binding only.
- Model per call via `llm_model` (the ladder rung) — one assistant serves every rung.

### 3. Local reach: one plugin per codeline, two keys
- For each codeline in the run: a `codemie-plugins` process rooted at the lane's clone, its own `HOME`
  under the install, its own key. Keys are stored in the install's `.env` (never printed, never
  committed), each registered once as a user-level `Plugin` integration (`Pipeline <codeline> rw`).
- **Read-only agents** (spec, detective, CPA, reviewers — `toolGrant` read) must not get write or run:
  a second, pipeline-shipped **read-only toolkit** (list, read, search) per codeline, built on the
  `codemie-plugins` toolkit framework (it ships an `example` toolkit), with its own key/integration
  (`Pipeline <codeline> ro`). Write-granted agents (story writer, repro-test writer, TC writer where
  granted) bind the `development` toolkit. Tool-free agents bind no toolkit at all.
- Lifecycle: started by the lane before its first seam, health-checked (the engine's "connected N tools"),
  stopped by the run's exit handler (all exits, including pause). No plugin runs outside a run.

### 4. The call: a runner like Copilot's, one place
`lib/codemie-web-runner.sh` `codemie_web_invoke <prompt_file> <model> <agent> <codeline> <result_json>`,
called by the hub (`llm-handler.sh` arm) and the story writer (`lib/story-attempt.sh` arm), exactly as
`copilot_invoke` is. It resolves the assistant, ensures the plugin, chats with `llm_model`,
`system_prompt`, `output_schema` (JSON seams), `save_history:false`, and writes the claude-shaped result
JSON through a judge (`lib/codemie-web-result.js`): answer, `tokens_used` → usage, `success:false` /
`agent_error` / empty `generated` → failure with a class.

### 5. Retry and self-heal
Failure classes read by `classify_failure_class`: `credit` (402/budget/quota — halt, no climb),
`auth` (SSO expired → `codemie profile refresh` once, then fail), `rate_limit`, `transient` (5xx/connect
— retry), `empty` (success with no text — the mx-tracker failure mode — retry, then climb),
`plugin` (tool errors / plugin not connected — restart the plugin once). The ladder climbs by model
(`llm_model`), unchanged.

### 6. Zero-cost proof (the harness)
The CodeMie API is redirected (declared `redirect` in provider-sets, like copilot) to a mock CodeMie
server in `test/mock-agent`: assistants/integrations CRUD, `llms.list`, and chat answered by the mock
agent's generative seams. Tool effects are applied through the real local plugin toolkit functions (the
stand-in "calls" read/write on the lane's clone), so the files land where the pipeline checks them.
A rehearsal that would reach the real CodeMie is refused (the vendorEdge rule).

### 7. Not in scope now
Sharing to the team (after green); per-codeline datasources in CodeMie; reasoning effort (CodeMie chat
has no effort parameter — carried only by model choice); the run-owned-copies backlog item.

## Risks

| Risk | Mitigation |
|---|---|
| Long chats: mx-tracker saw `claude-sonnet-5` replies >~40 s dropped (empty, success=true) on the assistant chat API | spike first; `background_task` + poll if it holds; `empty` failure class; model map prefers models that hold |
| run-command on a client codeline from a web agent | only write-granted agents get the development toolkit; plugin runs only during the run, rooted at the lane's clone |
| SSO expiry mid-run (~24 h) | refresh on `auth`, keep-alive like mx-tracker |
| CodeMie credits | `credit` class halts; spend read from the platform analytics for the cost ledger |
| Assistant sprawl | one per (codeline, agent), idempotent by name, a cleanup command for the personal project |

## Estimate

| Work | Est. |
|---|---|
| Spike on the unknowns: long chats + `background_task`, `llm_model`/`output_schema` per chat, `tokens_used`, two plugins at once, read-only toolkit | 0.5 d |
| Provider set, settings/inheritance, CodeMie catalog mapping, config file | 0.5 d |
| Assistant registry (name template, create/update, personal project, not shared, id cache, cleanup) | 0.5 d |
| Plugin lifecycle per codeline (keys, integrations, `HOME` isolation, start/health/stop on every exit) + read-only toolkit | 1 d |
| Runner + judge + hub arm + story-writer arm | 1 d |
| Failure classes, retry, SSO refresh, credit halt | 0.5 d |
| Zero-cost harness: mock CodeMie API + tool effects; unit tests; mutation checks | 1.5 d |
| £0 greenfield + brownfield on the new set; no-regression proof on the other sets | 0.5 d (mostly wall time) |
| **Engineering total** | **~6 days** |
| Live: greenfield then brownfield to green on CodeMie credits (operator approves each launch) | 1–2 d |
| After green, on the operator's word: re-scope assistants to the team project, `shared: true` | 0.25 d |
