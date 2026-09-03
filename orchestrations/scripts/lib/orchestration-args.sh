#!/usr/bin/env bash
# orchestration-args.sh — WHAT THIS RUN WAS ASKED TO DO.
#
# Extracted verbatim from run-agent-orchestration.sh, where it sat as a top-level `while` loop
# among that file's 87 function definitions. Inline code runs only when the script runs, so no unit
# test could reach it: these 88 lines decide the phase, the mode, whether stories are reset and
# whether the sandbox is used — every run passes through them — and not one had ever been executed
# by a test. The launch stage sat at 12.9% for exactly this reason, and no amount of testing the
# file as it stood could move it.
#
# PURE CODE MOVEMENT. Assignments in a bash function without `local` are global, so every variable
# this sets reaches the rest of the script as before; `exit` still exits the script; and $0 is
# unchanged inside a function, so the usage text still names the orchestrator rather than this file.
# The only difference is the one wanted: it can be called, with arguments, by a test.
#
# Requires from its caller: error(), and the defaults it overwrites (PHASE, DRY_RUN, ORCH_MODE and
# the rest), exactly as the orchestrator sets them immediately above the original loop.
#
# Usage:  parse_orchestration_args "$@"

parse_orchestration_args() {
while [[ $# -gt 0 ]]; do
    case $1 in
        --phase)
            if [ -z "$2" ] || [[ "$2" == --* ]]; then
                error "--phase requires a phase name"
                exit 1
            fi
            export PHASE="$2"
            shift 2
            ;;
        --reset)
            export RESET_STORIES=true
            shift
            ;;
        --dry-run)
            export DRY_RUN=true
            shift
            ;;
        --skip-cleanup)
            export SKIP_CLEANUP=true
            shift
            ;;
        --sandbox)
            export EPAM_SANDBOX=true
            shift
            ;;
        --allow-network)
            export EPAM_SANDBOX_ALLOW_NETWORK=true
            shift
            ;;
        --mode)
            if [ -z "${2:-}" ] || [[ "${2:-}" == --* ]]; then
                error "--mode requires a value: bash|hybrid"
                exit 1
            fi
            if [[ "$2" != "bash" && "$2" != "hybrid" ]]; then
                error "Invalid --mode: $2 (must be 'bash' or 'hybrid')"
                exit 1
            fi
            export ORCH_MODE="$2"
            shift 2
            ;;
        --help|-h)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Orchestrates parallel execution of stories using git worktrees.
Runs setup stories on main, then launches primary and independent agents
in parallel, waits for completion, and runs review.

Options:
  --phase NAME        Phase to execute (default: phase_wearables_test)
  --mode MODE         Orchestration mode: bash (default) or hybrid
  --reset             Reset all story completed flags before running (clean re-run)
  --dry-run           Show execution plan without running
  --skip-cleanup      Don't cleanup worktrees on exit (for debugging)
  --sandbox           Run each agent invocation inside a Docker/Podman container
                      (filesystem isolation, resource limits, no privilege escalation)
  --allow-network     Used with --sandbox: documents intent to allow full network
                      (network is always required for LLM API calls)
  --help              Show this help message

Timeout env vars:
  STORY_TIMEOUT_SECS      Override flat timeout per story (skips effort-based scaling)
  EPAM_PAUSE_ON_TIMEOUT   "true" = pause for operator on double timeout (default: false)
  EPAM_MAX_PAUSE_SECS     Hard ceiling on pause duration (default: 300s); auto-resumes

Sandbox env vars (used with --sandbox):
  EPAM_SANDBOX_IMAGE   Container image  (default: epam-cli-sandbox:latest)
  EPAM_SANDBOX_CPUS    CPU limit        (default: 2)
  EPAM_SANDBOX_MEMORY  Memory limit     (default: 4g)

Examples:
  $(basename "$0")                                    # Run test phase
  $(basename "$0") --phase phase11_wearable_foundation
  $(basename "$0") --dry-run                          # Preview plan
  $(basename "$0") --skip-cleanup                     # Keep worktrees

EOF
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            exit 1
            ;;
    esac
done
}
