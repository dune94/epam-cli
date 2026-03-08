#!/bin/bash

# EPAM CLI TodoList Deployment Script
# Builds in the source tree and copies only the compiled binary.
# No logs, tests, src files, or node_modules are deployed.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DEPLOY_DIR="${DEPLOY_DIR:-/home/bjerome/projects/ai/epam-cli-todolist}"
NODE="$HOME/.nvm/versions/node/v20.20.0/bin/node"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'; NC='\033[0m'
log()     { echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     EPAM CLI — TodoList Deployment                   ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

[ ! -d "$DEPLOY_DIR" ] && error "Deploy directory not found: $DEPLOY_DIR" && exit 1

# Step 1: Build in source tree
log "Building in source tree..."
cd "$PROJECT_ROOT"
$NODE ./node_modules/.bin/tsup 2>&1 | tail -2
[ ! -f "$PROJECT_ROOT/dist/epam.js" ] && error "Build failed" && exit 1
success "Build complete"

# Step 2: Clean deploy dir (remove stale files, keep .epam config if present)
log "Cleaning deploy directory..."
rm -rf "$DEPLOY_DIR/dist" "$DEPLOY_DIR/logs" "$DEPLOY_DIR/coverage" "$DEPLOY_DIR/test"
success "Cleaned"

# Step 3: Copy only the compiled binary
log "Copying binary..."
mkdir -p "$DEPLOY_DIR/dist"
cp "$PROJECT_ROOT/dist/epam.js" "$DEPLOY_DIR/dist/epam.js"
cp "$PROJECT_ROOT/dist/epam.js.map" "$DEPLOY_DIR/dist/epam.js.map" 2>/dev/null || true
success "Binary deployed"

# Step 4: Copy package.json (needed for --version)
cp "$PROJECT_ROOT/package.json" "$DEPLOY_DIR/package.json"

# Step 5: Copy orchestrations/dashboards if present
if [ -d "$PROJECT_ROOT/orchestrations/dashboards" ]; then
    log "Syncing orchestrations/dashboards..."
    mkdir -p "$DEPLOY_DIR/orchestrations/dashboards"
    cp "$PROJECT_ROOT"/orchestrations/dashboards/*.md "$DEPLOY_DIR/orchestrations/dashboards/" 2>/dev/null && \
      success "Dashboard .md files synced" || echo "  (no .md files found)"
fi

# Step 6: Verify no logs or unwanted files deployed
log "Verifying clean deploy..."
for unwanted in logs coverage test src node_modules .env; do
    if [ -e "$DEPLOY_DIR/$unwanted" ]; then
        error "Unwanted path found: $DEPLOY_DIR/$unwanted"
        exit 1
    fi
done
success "No logs/test/src/node_modules/.env present"

# Step 7: Verify binary runs
if $NODE "$DEPLOY_DIR/dist/epam.js" --version >/dev/null 2>&1; then
    success "Binary verified: $($NODE "$DEPLOY_DIR/dist/epam.js" --version 2>/dev/null)"
else
    echo "  (verification skipped — may need API keys at runtime)"
fi

echo ""
success "Done → $DEPLOY_DIR/dist/epam.js"
echo ""
