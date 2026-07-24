#!/usr/bin/env bash
# setup.sh — First-time Jira Docker setup guide.
# Waits for Jira to be ready, then walks through initial configuration.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JIRA_URL="${JIRA_URL:-http://localhost:8080}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
info() { echo -e "${CYAN}[setup]${NC} $*"; }
err()  { echo -e "${RED}[setup]${NC} $*" >&2; }

# ── Step 1: Start containers ──────────────────────────────────────────────
log "Starting Jira + PostgreSQL containers..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d
echo ""

# ── Step 2: Wait for Jira to be reachable ────────────────────────────────
log "Waiting for Jira to be reachable at $JIRA_URL ..."
log "First boot typically takes 3–5 minutes while Jira initialises its database."
echo ""

TIMEOUT=300
ELAPSED=0
INTERVAL=10
until curl -sf -o /dev/null "$JIRA_URL/status" 2>/dev/null; do
  if [ $ELAPSED -ge $TIMEOUT ]; then
    err "Timeout after ${TIMEOUT}s — Jira did not become ready."
    err "Check logs: docker compose -f $SCRIPT_DIR/docker-compose.yml logs jira"
    exit 1
  fi
  printf "  waiting... %ds elapsed\r" "$ELAPSED"
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done
echo ""
log "Jira is reachable."

# ── Step 3: License setup (manual) ───────────────────────────────────────
echo ""
warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
warn "  MANUAL STEP REQUIRED: Jira Setup Wizard"
warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
info "1. Open your browser and navigate to: $JIRA_URL"
info "   (WSL2 users: use \$(ip addr show eth0 | grep 'inet ' | awk '{print \$2}' | cut -d/ -f1):8080)"
echo ""
info "2. When prompted for a license, get a FREE developer license:"
info "   → Go to: https://my.atlassian.com/products/index"
info "   → Sign in with your Atlassian account (or create one — free)"
info "   → Under Jira Software, click 'New Trial License'"
info "   → Select 'Jira Software (Server)' — choose 10 users"
info "   → Copy the license key and paste it into the setup wizard"
echo ""
info "3. Complete the wizard:"
info "   → Choose 'I'll set it up myself'"
info "   → Database: the PostgreSQL settings are pre-configured"
info "   → Create an admin user. NOTE: save these credentials —"
info "     you will set JIRA_EMAIL and JIRA_TOKEN in .env"
info "   → Skip the email configuration (can set up later)"
echo ""
warn "Press ENTER once you have completed the Jira setup wizard and can log in."
read -r

# ── Step 4: Collect credentials ──────────────────────────────────────────
echo ""
log "Setting up credentials..."
read -rp "  Enter the Jira admin username you created: " JIRA_ADMIN_USER
read -rsp "  Enter the Jira admin password: " JIRA_ADMIN_PASS
echo ""

# Test credentials
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" \
  -u "${JIRA_ADMIN_USER}:${JIRA_ADMIN_PASS}" \
  "$JIRA_URL/rest/api/2/myself" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
  err "Credentials test failed (HTTP $HTTP_CODE). Check username/password."
  exit 1
fi
log "Credentials verified."

# ── Step 5: Write .env ────────────────────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/.env"
cat > "$ENV_FILE" <<EOF
JIRA_URL=${JIRA_URL}
JIRA_EMAIL=${JIRA_ADMIN_USER}
JIRA_TOKEN=${JIRA_ADMIN_PASS}
JIRA_PROJECT_KEY=SKY
JIRA_PROJECT_NAME=Skyscanner Mini-App
JIRA_WORKTREE_BE=/home/bradleyjerome/projects/skyscanner-app
JIRA_WORKTREE_FE=/home/bradleyjerome/projects/skyscanner-app-frontend
EOF
chmod 600 "$ENV_FILE"
log ".env written to $ENV_FILE"

# ── Step 6: Create project ────────────────────────────────────────────────
log "Creating Jira project SKY..."
HTTP_CODE=$(curl -sf -o /tmp/jira-project-create.json -w "%{http_code}" \
  -u "${JIRA_ADMIN_USER}:${JIRA_ADMIN_PASS}" \
  -H "Content-Type: application/json" \
  -X POST "$JIRA_URL/rest/api/2/project" \
  -d '{
    "key": "SKY",
    "name": "Skyscanner Mini-App",
    "projectTypeKey": "software",
    "projectTemplateKey": "com.pyxis.greenhopper.jira:gh-kanban-template",
    "description": "Brownfield pipeline test project — seeded from travel-app-prd.canonical.json",
    "assigneeType": "UNASSIGNED"
  }' 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
  log "Project SKY created."
elif [ "$HTTP_CODE" = "400" ]; then
  warn "Project SKY may already exist — continuing."
else
  err "Project creation returned HTTP $HTTP_CODE. See /tmp/jira-project-create.json"
  exit 1
fi

echo ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "  Jira setup complete."
log ""
log "  Next step: seed stories from the canonical PRD:"
log "    node $SCRIPT_DIR/seed-from-prd.js"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
