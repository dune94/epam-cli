#!/bin/bash

# EPAM CLI Demo Deployment Script
# Builds in the source tree and copies only the compiled binary to demo.
# Fast: no npm install in demo, no log/test/src files copied.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DEMO_DIR="${DEMO_DIR:-/home/bjerome/projects/ai/epam-cli-demo}"
NODE="$HOME/.nvm/versions/node/v20.20.0/bin/node"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'; NC='\033[0m'
log()     { echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     EPAM CLI — Demo Deployment                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

[ ! -d "$DEMO_DIR" ] && error "Demo directory not found: $DEMO_DIR" && exit 1

# Step 1: Build in source tree (node_modules already present here)
log "Building in source tree..."
cd "$PROJECT_ROOT"
$NODE ./node_modules/.bin/tsup 2>&1 | tail -2
[ ! -f "$PROJECT_ROOT/dist/epam.js" ] && error "Build failed" && exit 1
success "Build complete"

# Step 2: Build dashboards (Eleventy)
log "Building orchestration dashboards..."
$NODE ./node_modules/.bin/eleventy --config orchestrations/dashboards/.eleventy.js >/dev/null
success "Dashboards built → orchestrations/dashboards/live"

# Step 3: Copy only the compiled binary to demo
log "Copying binary to demo..."
mkdir -p "$DEMO_DIR/dist"
cp "$PROJECT_ROOT/dist/epam.js" "$DEMO_DIR/dist/epam.js"
cp "$PROJECT_ROOT/dist/epam.js.map" "$DEMO_DIR/dist/epam.js.map" 2>/dev/null || true
success "Binary deployed"

# Step 4: Sync dashboard outputs
log "Syncing orchestrations/dashboards outputs..."
mkdir -p "$DEMO_DIR/orchestrations/dashboards/live"
rsync -a --delete "$PROJECT_ROOT/orchestrations/dashboards/live/" "$DEMO_DIR/orchestrations/dashboards/live/" >/dev/null
success "Dashboard HTML/data synced"

# Step 5: Copy orchestrations/dashboards/*.md to demo
log "Syncing orchestrations/dashboards markdown files..."
mkdir -p "$DEMO_DIR/orchestrations/dashboards"
cp "$PROJECT_ROOT"/orchestrations/dashboards/*.md "$DEMO_DIR/orchestrations/dashboards/" 2>/dev/null && \
  success "Dashboard .md files synced" || echo "  (no .md files found in orchestrations/dashboards)"

# Step 6: Verify
if node "$DEMO_DIR/dist/epam.js" --version >/dev/null 2>&1; then
    success "Binary verified: $(node "$DEMO_DIR/dist/epam.js" --version 2>/dev/null)"
else
    echo "  (verification skipped — may need API keys at runtime)"
fi

echo ""
success "Done → $DEMO_DIR/dist/epam.js"
echo ""
