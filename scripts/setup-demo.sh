#!/bin/bash

# EPAM CLI Demo Setup Script
# Creates a dedicated demo instance at /home/bjerome/projects/ai/epam-cli-demo

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEMO_DIR="/home/bjerome/projects/ai/epam-cli-demo"
PROJECT_NAME="epam-cli-demo"

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
echo -e "${GREEN}║     EPAM CLI — Demo Instance Setup                   ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# Check prerequisites
log "Checking prerequisites..."

if ! command -v node &> /dev/null; then
    error "Node.js is required but not installed"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    error "Node.js 20+ required (found: $(node -v))"
    exit 1
fi

success "Node.js $(node -v) found"

# Create demo directory
log "Creating demo directory: $DEMO_DIR"

if [ -d "$DEMO_DIR" ]; then
    warning "Demo directory already exists"
    read -p "Overwrite? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        error "Aborted"
        exit 1
    fi
    rm -rf "$DEMO_DIR"
fi

mkdir -p "$DEMO_DIR"

# Copy project files
log "Copying project files..."
cp -r "$PROJECT_DIR/src" "$DEMO_DIR/"
cp -r "$PROJECT_DIR/dist" "$DEMO_DIR/" 2>/dev/null || true
cp "$PROJECT_DIR/package.json" "$DEMO_DIR/"
cp "$PROJECT_DIR/package-lock.json" "$DEMO_DIR/"
cp "$PROJECT_DIR/tsconfig.json" "$DEMO_DIR/"
cp "$PROJECT_DIR/tsup.config.ts" "$DEMO_DIR/"
cp "$PROJECT_DIR/README.md" "$DEMO_DIR/"

# Create demo-specific directories
log "Creating demo configuration..."
mkdir -p "$DEMO_DIR/.epam"
mkdir -p "$DEMO_DIR/test-evidence"

# Create demo settings
cat > "$DEMO_DIR/.epam/demo-settings.json" << 'EOF'
{
  "demoMode": true,
  "budgetGuardrails": {
    "warningAt": 0.001,
    "hardLimitAt": 0.002,
    "onHardLimit": "downgrade"
  },
  "llmChain": [
    { "provider": "codemie", "model": "claude-opus-4-6" },
    { "provider": "codemie", "model": "claude-sonnet-4-5" }
  ],
  "provider": "codemie",
  "model": "claude-opus-4-6",
  "tools": {
    "dangerousSkipApproval": false
  }
}
EOF

# Create demo README
cat > "$DEMO_DIR/DEMO-README.md" << 'EOF'
# EPAM CLI — Demo Instance

This is a dedicated demo instance for showcasing EPAM CLI capabilities.

## Quick Start

### 1. Install Dependencies

```bash
cd /home/bjerome/projects/ai/epam-cli-demo
npm install
npm run build
```

### 2. Authenticate with Codemie

```bash
node dist/epam.js provider login codemie
```

This opens a browser window for OAuth authentication. Complete the login and return to terminal.

### 3. Verify Authentication

```bash
node dist/epam.js provider status codemie
```

Expected output:
```
✓ codemie
  source:     SSO OAuth
  API URL:    https://...
  expires:    [future date]
  status:     ACTIVE
```

### 4. Start Demo Chat

```bash
node dist/epam.js chat
```

## Demo Flow

### Scenario 1: Provider Switch (Budget Limit)

1. Start chat: `node dist/epam.js chat`
2. Have a conversation (spend ~$0.002)
3. Budget warning appears
4. Interactive prompt: "Switch model to stay within budget?"
5. Press Y to confirm
6. Shows context retained, continues seamlessly

### Scenario 2: Build React Todo App

```
/plan Build a React Todo app with add/delete/complete features
# Review and approve plan
# Watch implementation
```

### Scenario 3: Session Replay

```bash
node dist/epam.js replay
# Select session to replay
# Watch agent reasoning turn-by-turn
```

### Scenario 4: Team Sync

```bash
node dist/epam.js sync status
node dist/epam.js sync push
```

## Configuration

- **Settings:** `.epam/demo-settings.json`
- **Credentials:** `~/.epam/credentials.json`
- **Sessions:** `.epam/sessions/`

## Updates

To update from main project:

```bash
cd /home/bjerome/projects/ai/epam-cli
./scripts/update-demo.sh

cd /home/bjerome/projects/ai/epam-cli-demo
npm install
npm run build
```

## Troubleshooting

### "No credentials found"
Run: `node dist/epam.js provider login codemie`

### "Credentials expired"
Run: `node dist/epam.js provider login codemie` (re-authenticate)

### Build errors
```bash
rm -rf dist node_modules
npm install
npm run build
```

## Demo Checklist

- [ ] Codemie OAuth working
- [ ] Provider switch demo ready (budget set low)
- [ ] React Todo app demo scripted
- [ ] /replay demo session recorded
- [ ] prd-viewer.html accessible at http://localhost:8092

---

**Demo Instance Created:** $(date)
**Last Updated:** $(date)
EOF

# Create update script
cat > "$PROJECT_DIR/scripts/update-demo.sh" << 'EOF'
#!/bin/bash

# Update demo instance from main project

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEMO_DIR="/home/bjerome/projects/ai/epam-cli-demo"

echo "Updating demo instance..."

# Copy updated files
cp -r "$PROJECT_DIR/src" "$DEMO_DIR/"
cp -r "$PROJECT_DIR/dist" "$DEMO_DIR/" 2>/dev/null || true
cp "$PROJECT_DIR/package.json" "$DEMO_DIR/"
cp "$PROJECT_DIR/package-lock.json" "$DEMO_DIR/"

echo "Demo updated successfully!"
echo ""
echo "Next steps:"
echo "  cd $DEMO_DIR"
echo "  npm install"
echo "  npm run build"
EOF

chmod +x "$PROJECT_DIR/scripts/update-demo.sh"

# Install dependencies
log "Installing dependencies..."
cd "$DEMO_DIR"
npm install --silent

# Build project
log "Building project..."
npm run build --silent

# Create demo launch script
cat > "$DEMO_DIR/demo.sh" << 'EOF'
#!/bin/bash
# Quick demo launcher

DEMO_DIR="/home/bjerome/projects/ai/epam-cli-demo"
cd "$DEMO_DIR"

case "${1:-chat}" in
    login)
        echo "Authenticating with Codemie..."
        node dist/epam.js provider login codemie
        ;;
    status)
        node dist/epam.js provider status codemie
        ;;
    chat)
        node dist/epam.js chat
        ;;
    replay)
        node dist/epam.js replay
        ;;
    sync)
        node dist/epam.js sync status
        ;;
    *)
        echo "Usage: $0 {login|status|chat|replay|sync}"
        exit 1
        ;;
esac
EOF

chmod +x "$DEMO_DIR/demo.sh"

# Final verification
echo ""
success "Demo instance setup complete!"
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Demo Instance Ready                                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Location: $DEMO_DIR"
echo ""
echo "Quick Start:"
echo "  cd $DEMO_DIR"
echo "  ./demo.sh login    # Authenticate with Codemie"
echo "  ./demo.sh chat     # Start demo chat"
echo ""
echo "Update from main project:"
echo "  $PROJECT_NAME/scripts/update-demo.sh"
echo ""
echo "See DEMO-README.md for full documentation."
echo ""
