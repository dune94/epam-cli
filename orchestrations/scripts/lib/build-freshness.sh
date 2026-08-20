# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# build-freshness.sh — is what actually runs current with the source it was built from?
#
# `epam` is `exec node .../dist/epam.js`. Every test in the suite reads src/, so a change that is
# written, tested, committed and never built looks shipped from every angle a test can see.
#
# Live 2026-08-09: tool-usage logging was wired, unit-tested and reported working, and the run
# emitted nothing — dist had been built eighteen hours earlier. Nine passing tests, zero events.
#
# Live 2026-08-20: the plugin-strictness fix (3b51ab9) was written in TypeScript, tested, committed
# and never built. preflight-static.sh reported PASS because it reads source; the launcher's own
# gate caught it at launch. Had that gate not existed, the run would have used a binary without the
# fix and produced conclusions about a pipeline that was not running the change.
#
# THAT GATE EXISTED IN ONE LAUNCHER OF EIGHT. This is the single implementation both the desk-side
# pre-flight and every launcher can call, so the other seven stop being able to start on a stale
# binary silently.
#
#   build_is_current [repo-root]   → 0 when the build is current, non-zero with a reason when not
#
# FAILS RATHER THAN REBUILDS. A check that silently recompiles under an operator who did not ask
# changes what is being run without saying so.
# ─────────────────────────────────────────────────────────────────────────────

build_is_current() {
    local _root="${1:-${REPO_ROOT:-$PWD}}"
    local _dist="$_root/dist/epam.js"
    local _build_cmd="~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/tsup"

    if [ ! -d "$_root/src" ]; then
        return 0                     # nothing is built from here; nothing to be stale
    fi

    if [ ! -f "$_dist" ]; then
        echo "dist/epam.js does not exist — the pipeline has no binary to run." >&2
        echo "  Build: $_build_cmd" >&2
        return 1
    fi

    # The FIRST source file newer than the build is enough; -print -quit stops there rather than
    # walking a whole tree to say the same thing.
    #
    # Tests and type declarations are excluded because they are not built into the binary: a newer
    # spec file is not a stale build, and treating it as one would make this fire constantly and
    # be switched off — which is how a real gate becomes noise.
    local _newer
    _newer=$(find "$_root/src" -type f \( -name '*.ts' -o -name '*.js' -o -name '*.json' \) \
        ! -name '*.test.ts' ! -name '*.spec.ts' ! -name '*.d.ts' \
        -newer "$_dist" -print -quit 2>/dev/null)

    if [ -n "$_newer" ]; then
        echo "dist/epam.js is OLDER than ${_newer#"$_root"/} — the pipeline would run a stale binary." >&2
        echo "  Build: $_build_cmd" >&2
        return 1
    fi
    return 0
}
