# EPAM CLI Demo — Setup Instructions

## ⚠️ API Keys Required

The demo requires valid LLM API keys. The included keys are **expired/invalid**.

### Get Your API Keys

#### Anthropic Claude (Recommended)
1. Go to: https://console.anthropic.com/settings/keys
2. Create a new API key
3. Add to `.env`:
   ```bash
   EPAM_API_KEY_CLAUDE=sk-ant-...
   ```

#### OpenAI GPT
1. Go to: https://platform.openai.com/api-keys
2. Create a new API key
3. Add to `.env`:
   ```bash
   EPAM_API_KEY_OPENAI=sk-...
   ```

#### Google Gemini
1. Go to: https://makersuite.google.com/app/apikey
2. Create a new API key
3. Add to `.env`:
   ```bash
   EPAM_API_KEY_GEMINI=...
   ```

---

## Quick Start

```bash
cd /home/bjerome/projects/ai/epam-cli-demo

# 1. Edit .env and add your API key
nano .env

# 2. Start chat
node dist/epam.js chat

# 3. Try MCP query (requires MCP servers running)
@jira how many tickets?

# 4. Exit
/exit
```

---

## MCP Sources (Optional)

MCP sources provide live client data (JIRA, Confluence, etc.). These are optional.

### Start MCP Servers

```bash
# Requires Docker and valid API tokens
docker compose -f /home/bjerome/projects/ai/codemie/docker-compose.codemie.yml up -d mcp-jira mcp-confluence mcp-drawio
```

### Configure in .env

```bash
MCP_JIRA_URL=http://localhost:9010
MCP_CONFLUENCE_URL=http://localhost:9020
MCP_DRAWIO_URL=http://localhost:9040
```

---

## Troubleshooting

### "Network error: fetch failed"

**Cause:** Invalid or missing API key

**Fix:**
1. Check `.env` has valid API key
2. Test connectivity:
   ```bash
   curl https://api.anthropic.com/v1/messages \
     -H "Authorization: Bearer YOUR_KEY" \
     -H "Content-Type: application/json" \
     -H "anthropic-version: 2023-06-01" \
     -X POST \
     -d '{"model":"claude-sonnet-4-6","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
   ```
3. Should return `400` or `200` (not `401`)

### "All providers exhausted"

**Cause:** All providers in chain failed

**Fix:**
1. Check `.epam/settings.json` for provider list
2. Ensure at least one provider has valid API key
3. Try single provider:
   ```bash
   node dist/epam.js chat --provider claude
   ```

### MCP Queries Not Working

**Cause:** MCP servers not running

**Fix:**
1. MCP is optional - chat works without it
2. To enable, start MCP servers (see above)
3. Or remove MCP URLs from `.env`

---

## Demo Script

```bash
# 1. Setup (one time)
cd /home/bjerome/projects/ai/epam-cli-demo
# Edit .env with your API key

# 2. Start chat
node dist/epam.js chat

# 3. Show hint text
# "Type @ to query MCP sources, / for commands..."

# 4. Try MCP query (will silently fail if MCP servers off)
@jira how many tickets?

# 5. Normal chat
Build a React todo app

# 6. Show failover (remove API key, then try)
/exit

# 7. Show manual MCP command
node dist/epam.js chat
/mcp status
```

---

**Demo Ready Once API Keys Added!** 🎉
