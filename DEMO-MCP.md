# EPAM CLI Demo — MCP RAG Configuration

## Demo Environment

**Location:** `/home/bjerome/projects/ai/epam-cli-demo`

**Version:** 0.1.0

---

## MCP Sources Configured

| Source | Port | URL | Status |
|--------|------|-----|--------|
| **JIRA** | 9010 | http://localhost:9010 | ✅ Configured |
| **Confluence** | 9020 | http://localhost:9020 | ✅ Configured |
| **Draw.io** | 9040 | http://localhost:9040 | ✅ Configured |

---

## Quick Start

```bash
cd /home/bjerome/projects/ai/epam-cli-demo

# Start chat
node dist/epam.js chat

# Or use global command (if linked)
epam-cli chat
```

---

## Demo Flow

### 1. Auto-Query (Keyword Detection)

```bash
epam [qwen/qwen-max] › Show me authentication tickets

[MCP SOURCES]

JIRA:
  • PROJ-123: Auth module refactor (In Progress)
  • PROJ-456: SSO integration (In Review)

Based on the JIRA tickets above...
```

### 2. Explicit @mention Query

```bash
epam [qwen/qwen-max] › @confluence auth documentation

[MCP SOURCES]

CONFLUENCE:
  • Auth Architecture Guide (Updated 2 days ago)
  • SSO Setup Instructions (Updated last week)
```

### 3. Query All Sources

```bash
epam [qwen/qwen-max] › @all authentication

[MCP SOURCES]

JIRA:
  • PROJ-123: Auth refactor (In Progress)

CONFLUENCE:
  • Auth Guide (Updated 2 days ago)

DRAW.IO:
  • Auth Flow Diagram v2.3
```

### 4. Manual MCP Command

```bash
epam [qwen/qwen-max] › /mcp jira authentication

[MCP SOURCES]
[JIRA] 2 result(s):
  • PROJ-123: Auth module refactor
    Status: In Progress
    URL: https://metrolinx.atlassian.net/browse/PROJ-123
```

---

## Environment Variables

Located in `.env`:

```bash
# MCP Sources (RAG Asset Discovery)
MCP_JIRA_URL=http://localhost:9010
MCP_CONFLUENCE_URL=http://localhost:9020
MCP_DRAWIO_URL=http://localhost:9040
```

---

## MCP Servers

Ensure these Docker containers are running:

```bash
# Check status
docker compose -f /home/bjerome/projects/ai/codemie/docker-compose.codemie.yml ps

# Expected output:
# mcp-jira         Running
# mcp-confluence   Running
# mcp-drawio       Running
```

---

## Troubleshooting

### MCP Sources Not Connecting

1. **Check Docker containers:**
   ```bash
   docker ps | grep mcp-
   ```

2. **Test connectivity:**
   ```bash
   curl http://localhost:9010/query -X POST \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"query":"test"}}'
   ```

3. **Check .env file:**
   ```bash
   cat .env | grep MCP_
   ```

### Auto-Query Not Triggering

- Ensure keywords match: `ticket`, `jira`, `doc`, `confluence`, `diagram`, `drawio`
- Use explicit @mention: `@jira`, `@confluence`, `@drawio`, `@all`

---

## Demo Script

```bash
# 1. Navigate to demo
cd /home/bjerome/projects/ai/epam-cli-demo

# 2. Start chat
node dist/epam.js chat

# 3. Show hint text
# (Displayed automatically on chat start)

# 4. Demo auto-query
Show me authentication tickets

# 5. Demo explicit query
@confluence auth docs

# 6. Demo all sources
@all authentication

# 7. Demo manual command
/mcp jira PROJ

# 8. Exit
/exit
```

---

## Features Summary

| Feature | Status |
|---------|--------|
| Auto-query keywords | ✅ |
| @mention queries | ✅ |
| /mcp manual command | ✅ |
| Hybrid response format | ✅ |
| JIRA integration | ✅ |
| Confluence integration | ✅ |
| Draw.io integration | ✅ |
| MCP protocol (JSON-RPC 2.0) | ✅ |

---

**Demo Ready!** 🎉
