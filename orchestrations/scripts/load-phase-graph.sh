#!/usr/bin/env bash
# load-phase-graph.sh - Import orchestration phase data into Neo4j via Bolt
# EPAM CLI orchestration graph loader
#
# Thin wrapper around load-phase-graph.py -- handles .env loading and
# ensures the neo4j Python driver is installed before delegating.
#
# Usage:
#   ./load-phase-graph.sh                       # Import all phases
#   ./load-phase-graph.sh --phase phase_id      # Import specific phase only
#   ./load-phase-graph.sh --clear               # Clear graph then import

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$AUTOMATION_DIR")"

LOG_DIR="${LOG_DIR:-$AUTOMATION_DIR/logs}"
PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
log()     { echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# -- Ensure neo4j Python driver is installed --
if ! python3 -c "import neo4j" 2>/dev/null; then
  log "Installing neo4j Python driver..."
  pip3 install neo4j --quiet || { error "pip3 install neo4j failed"; exit 1; }
  success "neo4j driver installed"
fi

# -- Export LOG_DIR and PRD_FILE so Python script can pick them up --
export LOG_DIR PRD_FILE

# -- Delegate to Python loader (passes all args through) --
exec python3 "$SCRIPT_DIR/load-phase-graph.py" "$@"
