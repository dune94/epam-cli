#!/usr/bin/env bash
# scaffold-be-repo.sh — Create a minimal backend (Node/TypeScript) git repo for multi-worktree runs.
# Called by run-agent-orchestration.sh (Jira pipeline mode) when the BE codeline worktree doesn't exist.
#
# Creates: git repo + package.json + tsconfig + vitest.config + src/
# The orchestration agents fill in the actual implementation.
#
# Usage: bash scaffold-be-repo.sh <target-dir>
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "[scaffold-be] Usage: scaffold-be-repo.sh <target-dir>" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo 'node')}"
[ -x "/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node" ] && \
  NODE_BIN="/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node"
NPM_BIN="$(dirname "$NODE_BIN")/npm"

GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${GREEN}[scaffold-be]${NC} $*"; }

mkdir -p "$TARGET/src"
cd "$TARGET"

# Init git repo
if [ ! -d ".git" ]; then
  git init -q
  git config user.email "epam-cli@local"
  git config user.name "epam-cli"
fi

# package.json
# App identity comes from the target directory (or APP_NAME), never a literal:
# a client brand baked in here was emitted into EVERY project the engine
# scaffolded, regardless of who that project was for.
APP_NAME="${APP_NAME:-$(basename "$(pwd)")}"
cat > package.json <<JSON
{
  "name": "${APP_NAME}",
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
// Backend entry point — implemented by orchestration agents
export {};
TS

# Placeholder src/public/index.html — server.ts serves this for GET /
# Without it GET / throws ENOENT at runtime (live gap found by spec-validator 2026-07-19)
mkdir -p src/public
cat > src/public/index.html <<'HTML'
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${APP_NAME}</title></head>
<body><h1>${APP_NAME}</h1><p>Dashboard placeholder — implemented by orchestration agents.</p></body>
</html>
HTML

# Install deps
log "Installing dependencies at $TARGET..."
timeout --kill-after=5s 120s "$NPM_BIN" install --silent --no-audit --no-fund 2>/dev/null || {
  log "npm install failed or timed out — agents will install on first run."
}

# Initial commit
git add -A
git commit -q -m "chore: scaffold backend repo for jira-first pipeline" \
  --author="epam-cli <epam-cli@local>" 2>/dev/null || true

log "Backend repo scaffolded at $TARGET"
