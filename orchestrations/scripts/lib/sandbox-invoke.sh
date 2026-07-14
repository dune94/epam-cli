#!/usr/bin/env bash
# sandbox-invoke.sh — wraps a story-agent CLI invocation in a Docker/Podman
# sandbox. Drop-in replacement for whatever CLI claude.sh would otherwise
# call directly ($CLAUDE_CMD for the claude-compatible providers, or the
# epam-run branch for copilot/openai/qwen/cursor/minimax) — receives the
# same stdin/args, but executes inside an isolated container with:
#   - PROJECT_ROOT bind-mounted read-write, EXCEPT each dir declared in
#     .epam/dependency-check.json's "vendorDirs" (e.g. node_modules),
#     which gets its own nested read-only mount. This is what makes vendor
#     tampering structurally impossible rather than just detected after the
#     fact (chmod-based locking is same-UID-bypassable; a read-only bind
#     mount is enforced by the kernel and cannot be undone by anything
#     running inside the container, even as its own root).
#   - epam-cli's own install dir bind-mounted read-only at a fixed path, so
#     EPAM_SANDBOX_TARGET_CMD can invoke `epam` itself regardless of what
#     stack the TARGET project uses — epam is always the same Node.js tool.
#   - CPU and memory limits
#   - No privilege escalation (--no-new-privileges, --cap-drop ALL)
#   - Non-root user (same uid:gid as the host caller)
#   - Network: bridge (required for provider API calls)
#
# Env vars that control sandbox behaviour (all optional):
#   EPAM_SANDBOX_IMAGE       Container image (default: epam-cli-sandbox:latest)
#   EPAM_SANDBOX_CPUS        CPU limit      (default: 2)
#   EPAM_SANDBOX_MEMORY      Memory limit   (default: 4g)
#   EPAM_SANDBOX_TARGET_CMD  Binary (+ leading args) to run inside the
#                            container, space-separated (default: "claude").
#                            e.g. "node /opt/epam-cli/dist/epam.js run" for
#                            the epam-run provider branch. The invocation's
#                            OWN args (--provider, --model, etc.) are still
#                            passed as "$@" and appended after this.
#   PROJECT_ROOT             Project dir to mount r/w (default: $PWD)
#
# Any exported env var whose name ends in _API_KEY or starts with EPAM_ is
# forwarded into the container automatically (value taken from the host
# shell) — no per-provider name hardcoded here.
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

# epam-cli's own repo root (this script lives at
# <repo>/orchestrations/scripts/lib/sandbox-invoke.sh) — bind-mounted
# read-only into the container so EPAM_SANDBOX_TARGET_CMD can invoke the
# `epam` CLI regardless of the TARGET project's own language/stack.
EPAM_CLI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EPAM_CLI_MOUNT_PATH="/opt/epam-cli"

# Vendor-dir read-only mounts: reads the SAME .epam/dependency-check.json
# "vendorDirs" key claude.sh's own _get_vendor_dirs()/_vendor_lock() already
# use — no new config, no vendor/tool name hardcoded here. Opt-in: no config
# file or no "vendorDirs" key = no extra mounts.
VENDOR_MOUNT_ARGS=()
_DEPENDENCY_CHECK_FILE="$PROJECT_ROOT/.epam/dependency-check.json"
if [[ -f "$_DEPENDENCY_CHECK_FILE" ]] && command -v jq &>/dev/null; then
    while IFS= read -r _vendor_dir; do
        [[ -z "$_vendor_dir" ]] && continue
        _abs_vendor_dir="$PROJECT_ROOT/$_vendor_dir"
        if [[ -d "$_abs_vendor_dir" ]]; then
            VENDOR_MOUNT_ARGS+=(-v "${_abs_vendor_dir}:${_abs_vendor_dir}:ro")
        fi
    done < <(jq -r '.vendorDirs[]? // empty' "$_DEPENDENCY_CHECK_FILE" 2>/dev/null)
fi

# Forward any provider API key / EPAM_* env var present on the host, by
# name only (Docker takes the value from the host shell for a bare
# `-e NAME`) — generic pattern match, no per-provider name hardcoded.
# Excludes EPAM_SANDBOX_* itself: those are this wrapper's own control
# knobs, not something the agent inside the container needs to see.
FORWARD_ENV_ARGS=()
while IFS= read -r _envname; do
    [[ -z "$_envname" ]] && continue
    [[ "$_envname" == EPAM_SANDBOX_* ]] && continue
    FORWARD_ENV_ARGS+=(-e "$_envname")
done < <(compgen -e | grep -E '(_API_KEY$|^EPAM_)' || true)

# Target command to run inside the container — defaults to the original
# `claude` behaviour; callers wanting to sandbox a different provider's CLI
# (e.g. epam-run) set EPAM_SANDBOX_TARGET_CMD before invoking this wrapper.
IFS=' ' read -ra TARGET_CMD_ARR <<< "${EPAM_SANDBOX_TARGET_CMD:-claude}"

# Unique container name avoids collisions when multiple stories run in parallel
CONTAINER_NAME="epam-sandbox-$(date +%s%3N)-$$-$RANDOM"

exec "$RUNTIME" run \
    --rm \
    -i \
    --name "$CONTAINER_NAME" \
    --user "$(id -u):$(id -g)" \
    --workdir "$PROJECT_ROOT" \
    -v "${PROJECT_ROOT}:${PROJECT_ROOT}:rw" \
    "${VENDOR_MOUNT_ARGS[@]}" \
    -v "${EPAM_CLI_ROOT}:${EPAM_CLI_MOUNT_PATH}:ro" \
    "${FORWARD_ENV_ARGS[@]}" \
    -e "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1" \
    -e "CLAUDE_CODE_SKIP_TELEMETRY=1" \
    -e "HOME=/home/agent" \
    --cpus="${SANDBOX_CPUS}" \
    --memory="${SANDBOX_MEMORY}" \
    --memory-swap="${SANDBOX_MEMORY}" \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    "${SANDBOX_IMAGE}" \
    "${TARGET_CMD_ARR[@]}" "$@"
