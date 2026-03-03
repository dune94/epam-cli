#!/bin/bash

# EPAM CLI Demo Deployment Script
# Ensures clean, reliable deployment to demo instance

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DEMO_DIR="${DEMO_DIR:-/home/bjerome/projects/ai/epam-cli-demo}"

# Colors
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     EPAM CLI — Demo Deployment                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# Verify source exists
if [ ! -d "$PROJECT_ROOT/src" ]; then
    error "Source directory not found: $PROJECT_ROOT/src"
    exit 1
fi

# Verify demo directory exists
if [ ! -d "$DEMO_DIR" ]; then
    error "Demo directory not found: $DEMO_DIR"
    exit 1
fi

log "Deploying to: $DEMO_DIR"

# Step 1: Clean demo build artifacts and node_modules
log "Step 1: Cleaning demo..."
cd "$DEMO_DIR"
rm -rf dist node_modules .tsup* package-lock.json 2>/dev/null || true
success "Cleaned"

# Step 2: Copy only essential source files
log "Step 2: Copying source files..."
# Copy package files
cp "$PROJECT_ROOT/package.json" "$DEMO_DIR/"
cp "$PROJECT_ROOT/tsconfig.json" "$DEMO_DIR/"
cp "$PROJECT_ROOT/tsup.config.ts" "$DEMO_DIR/"
cp "$PROJECT_ROOT/vitest.config.ts" "$DEMO_DIR/" 2>/dev/null || true

# Copy src directory (fresh copy)
rm -rf "$DEMO_DIR/src" 2>/dev/null || true
cp -r "$PROJECT_ROOT/src" "$DEMO_DIR/"

# Copy test directory
rm -rf "$DEMO_DIR/test" 2>/dev/null || true
cp -r "$PROJECT_ROOT/test" "$DEMO_DIR/"

success "Source files copied"

# Step 3: Install dependencies
log "Step 3: Installing dependencies..."
npm install --silent 2>&1 | grep -v "npm warn" || true
success "Dependencies installed"

# Step 4: Build
log "Step 4: Building..."
npm run build --silent 2>&1 | tail -3
if [ -f "$DEMO_DIR/dist/epam.js" ]; then
    success "Build successful"
else
    error "Build failed - dist/epam.js not found"
    exit 1
fi

# Step 5: Verify build
log "Step 5: Verifying build..."
if node "$DEMO_DIR/dist/epam.js" --version >/dev/null 2>&1; then
    success "Binary verified"
else
    warning "Binary verification failed (may need API keys)"
fi

# Summary
echo ""
success "Demo deployment complete!"
echo ""
echo "Location: $DEMO_DIR"
echo ""
echo "Quick test:"
echo "  cd $DEMO_DIR"
echo "  node dist/epam.js --version"
echo ""
echo "To update in future:"
echo "  $SCRIPT_DIR/deploy-demo.sh"
echo ""
