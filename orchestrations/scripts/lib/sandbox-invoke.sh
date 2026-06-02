#!/usr/bin/env bash
# sandbox-invoke.sh — wraps the Claude CLI in a Docker/Podman sandbox.
#
# Drop-in replacement for the `claude` CLI binary. Receives the same
# arguments and stdin that claude.sh would pass to $CLAUDE_CMD, but
# executes them inside an isolated container with:
#   - Only PROJECT_ROOT bind-mounted read-write
#   - CPU and memory limits
#   - No privilege escalation (--no-new-privileges, --cap-drop ALL)
#   - Non-root user (uid 1000)
#   - Network: bridge (required for Anthropic API calls)
#
# Env vars that control sandbox behaviour (all optional):
#   EPAM_SANDBOX_IMAGE    Container image (default: epam-cli-sandbox:latest)
#   EPAM_SANDBOX_CPUS     CPU limit      (default: 2)
#   EPAM_SANDBOX_MEMORY   Memory limit   (default: 4g)
#   PROJECT_ROOT          Project dir to mount r/w (default: $PWD)
#
# Usage (set automatically by run-agent-orchestration.sh --sandbox):
#   export CLAUDE_CMD=/path/to/lib/sandbox-invoke.sh
set -euo pipefail

RUNTIME=""
for _rt in docker podman; do
    if command -v "$_rt" &>/dev/null; then
        RUNTIME="$_rt"
        break
    fi
done

if [[ -z "$RUNTIME" ]]; then
    echo "[sandbox-invoke] ERROR: neither docker nor podman found in PATH" >&2
    exit 1
fi

SANDBOX_IMAGE="${EPAM_SANDBOX_IMAGE:-epam-cli-sandbox:latest}"
SANDBOX_CPUS="${EPAM_SANDBOX_CPUS:-2}"
SANDBOX_MEMORY="${EPAM_SANDBOX_MEMORY:-4g}"
PROJECT_ROOT="${PROJECT_ROOT:-$PWD}"

# Resolve API key: ANTHROPIC_API_KEY takes precedence, fall back to EPAM wrapper var
API_KEY="${ANTHROPIC_API_KEY:-${EPAM_API_KEY_ANTHROPIC:-}}"

if [[ -z "$API_KEY" ]]; then
    echo "[sandbox-invoke] WARNING: no ANTHROPIC_API_KEY set — agent may fail to authenticate" >&2
fi

# Unique container name avoids collisions when multiple stories run in parallel
CONTAINER_NAME="epam-sandbox-$(date +%s%3N)-$$-$RANDOM"

exec "$RUNTIME" run \
    --rm \
    -i \
    --name "$CONTAINER_NAME" \
    --user "$(id -u):$(id -g)" \
    --workdir "$PROJECT_ROOT" \
    -v "${PROJECT_ROOT}:${PROJECT_ROOT}:rw" \
    -e "ANTHROPIC_API_KEY=${API_KEY}" \
    -e "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1" \
    -e "CLAUDE_CODE_SKIP_TELEMETRY=1" \
    -e "HOME=/home/agent" \
    --cpus="${SANDBOX_CPUS}" \
    --memory="${SANDBOX_MEMORY}" \
    --memory-swap="${SANDBOX_MEMORY}" \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    "${SANDBOX_IMAGE}" \
    claude "$@"
