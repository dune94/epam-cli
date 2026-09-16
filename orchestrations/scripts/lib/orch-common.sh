#!/usr/bin/env bash
# orch-common.sh — moved verbatim out of run-agent-orchestration.sh by tools/split-main-into-modules.py
# (5 functions). Sourced by run-agent-orchestration.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

log()     { echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"; }

error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }

info()    { echo -e "${CYAN}[INFO]${NC} $1"; }

warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
