# EPAM CLI — Quick Start

## Run a ticket (the supported path)

Install first — see **[INSTALL.md](INSTALL.md)** for prerequisites and the two-step install.

```bash
# what this install can run
./orchestrations/scripts/pipeline --list

# check a ticket without spending anything
./orchestrations/scripts/pipeline --jira AMSD-1234 --dry-run

# run it
./orchestrations/scripts/pipeline --jira AMSD-1234
```

The wrapper resolves the project from the ticket prefix, refuses to start with a plain list of
what is missing, and hands off to the tested launcher. Watch progress at
`orchestrations/dashboards/live/monitor.html`.

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
