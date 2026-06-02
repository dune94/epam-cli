# EPAM CLI — Quick Start

## Live demo (Skyscanner travel app, ~10 min)

**Required:** `RAPIDAPI_KEY` (Skyscanner subscription on RapidAPI)

```bash
# 1. Clone and install
git clone https://github.com/dune94/epam-cli && cd epam-cli
npm install

# 2. Set your API key
export EPAM_API_KEY_ANTHROPIC=<your-anthropic-key>
export RAPIDAPI_KEY=<your-rapidapi-key>

# 3. Build the Skyscanner app from scratch via multi-agent orchestration
bash orchestrations/scripts/run-travel-app-test.sh
```

The orchestration runs three phases (scaffold → core → ui\_and\_review), builds a
full TypeScript + Express + HTML dashboard app autonomously, and prints a scorecard
at the end. Open `orchestrations/dashboards/live/monitor.html` in a browser to watch
progress in real time.

---

## Keyless preview (canned dashboard)

No API keys required — renders a completed run from the demo log snapshot.

```bash
# 1. Switch dashboards to demo logs
bash scripts/demo-mode.sh on

# 2. Serve dashboards
npm run dashboards:serve

# 3. Open http://localhost:8080/scorecard.html
#    (restore live logs when done)
bash scripts/demo-mode.sh off
```

---

## Optional features

| Feature | Required env var(s) |
|---|---|
| Langfuse LLM tracing | `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY` |
| Jira webhook triggers | `JIRA_WEBHOOK_SECRET`, `JIRA_BASE_URL`, `JIRA_API_TOKEN` |
| Redis session sharing | `EPAM_REDIS_URL` |
| Semantic RAG (CPA) | `EPAM_API_KEY_OPENAI` |
| OpenTelemetry | `OTEL_EXPORTER_OTLP_ENDPOINT` |

None of the above are required for the live demo or keyless preview.
