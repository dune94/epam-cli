#!/usr/bin/env bash
# scaffold-frontend-repo.sh — Create a minimal frontend git repo for multi-worktree runs.
# Called by run-agent-orchestration.sh (Jira pipeline mode) when the codeline worktree doesn't exist.
#
# Creates: git repo + package.json + tsconfig + vitest.config + src/
# The orchestration agents fill in the actual implementation.
#
# Usage: bash scaffold-frontend-repo.sh <target-dir>
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "[scaffold-fe] Usage: scaffold-frontend-repo.sh <target-dir>" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo 'node')}"
[ -x "/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node" ] && \
  NODE_BIN="/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node"
NPM_BIN="$(dirname "$NODE_BIN")/npm"

GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${GREEN}[scaffold-fe]${NC} $*"; }

mkdir -p "$TARGET/src"
cd "$TARGET"

# Init git repo
if [ ! -d ".git" ]; then
  git init -q
  git config user.email "epam-cli@local"
  git config user.name "epam-cli"
fi

# package.json
cat > package.json <<'JSON'
{
  "name": "skyscanner-app-frontend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "tsx": "^4.0.0",
    "vitest": "^1.0.0",
    "@types/node": "^20.0.0"
  }
}
JSON

# tsconfig.json
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
JSON

# vitest.config.ts
cat > vitest.config.ts <<'TS'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true } });
TS

# .gitignore
cat > .gitignore <<'EOF'
node_modules/
dist/
*.log
EOF

# Placeholder src/index.ts so tsc doesn't fail on empty src/
cat > src/index.ts <<'TS'
// Frontend entry point — implemented by orchestration agents
export {};
TS

# Install deps
log "Installing dependencies at $TARGET..."
"$NPM_BIN" install --silent 2>/dev/null || {
  log "npm install failed — agents will install on first run."
}

# Initial commit
git add -A
git commit -q -m "chore: scaffold frontend repo for jira-first pipeline" \
  --author="epam-cli <epam-cli@local>" 2>/dev/null || true

log "Frontend repo scaffolded at $TARGET"
