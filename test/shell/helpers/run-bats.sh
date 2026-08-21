#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# run-bats.sh — run the shell suite with a REAL `env` on PATH.
#
# WHY THIS WRAPPER EXISTS, AND WHY IT MUST NOT BE REMOVED.
#
# bats re-enters itself with `exec env BATS_ROOT=... .../libexec/bats-core/bats`. On this machine
# ~/.local/bin/env is NOT coreutils env: it is a PATH-setup snippet meant to be SOURCED (the kind uv
# and rustup install), and ~/.local/bin precedes /usr/bin. So `env` resolved to a script that
# adjusts PATH, prints nothing and exits 0 — bats exec'd a no-op and reported success.
#
# Measured 2026-08-20, before this wrapper:
#
#     bats a-test-that-must-fail.bats   -> exit 0, no output
#     bats /tmp/does-not-exist.bats     -> exit 0, no output
#
# A suite on that runner is green from the first commit and proves nothing — the exact defect class
# this suite exists to catch, installed as the thing meant to catch it.
#
# Pinning PATH here rather than fixing the shell is deliberate: the suite must not depend on an
# operator's environment being right. If `env` is ever shadowed again, this still runs.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BATS_BIN="$REPO_ROOT/node_modules/bats/bin/bats"

[ -x "$BATS_BIN" ] || { echo "[shell-suite] bats not installed at $BATS_BIN — run npm install" >&2; exit 2; }

# THE RUNNER PROVES IT CAN FAIL BEFORE IT IS TRUSTED.
#
# A self-check, every run: a test that must fail, must fail. Without it, a future change to PATH,
# to bats, or to this wrapper silently returns the suite to reporting success for everything.
_probe=$(mktemp "${TMPDIR:-/tmp}/bats-probe-XXXXXX.bats")
printf '@test "the runner can fail" {\n  [ 1 -eq 2 ]\n}\n' > "$_probe"
if PATH="/usr/bin:/bin:$PATH" bash "$BATS_BIN" "$_probe" >/dev/null 2>&1; then
    rm -f "$_probe"
    echo "[shell-suite] FATAL: the runner reported SUCCESS for a test that must fail." >&2
    echo "[shell-suite]        Every result it produces is meaningless. Refusing to run." >&2
    echo "[shell-suite]        Check that \`env\` resolves to coreutils: command -v env" >&2
    exit 2
fi
rm -f "$_probe"

# A RUN THAT EXECUTED NOTHING IS NOT A PASS.
#
# `bats test/shell/` reports `1..0` and exits 0: bats does not recurse without -r, and a directory
# with no .bats at its top level is simply "no tests". That is the same shape as the broken `env`
# this wrapper already guards against — a runner reporting success for zero work — so -r is always
# passed and an empty plan is refused.
#
# NOT `exec env PATH=... bash ...`. The first version of this line did exactly that and produced no
# output at all, because `env` is the very thing that is shadowed. A wrapper written to work around
# a broken `env` must not call `env`; an assignment prefix needs no external binary.
_out=$(mktemp "${TMPDIR:-/tmp}/bats-out-XXXXXX")
PATH="/usr/bin:/bin:$PATH" bash "$BATS_BIN" -r "$@" | tee "$_out"
_rc=${PIPESTATUS[0]}

if grep -qE '^1\.\.0$' "$_out"; then
    rm -f "$_out"
    echo "[shell-suite] FATAL: the run executed ZERO tests and would have reported success." >&2
    echo "[shell-suite]        Check the path given: $*" >&2
    exit 2
fi
rm -f "$_out"
exit "$_rc"
