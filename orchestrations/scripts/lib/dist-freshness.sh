#!/usr/bin/env bash
# dist-freshness.sh — refuse to run a pipeline whose binary predates its source.
#
# `epam` is a two-line shim: `exec node .../dist/epam.js`. The pipeline never
# runs src/. On 2026-07-26 dist/epam.js was two days old, so an AgentRunner
# change committed that morning would have been a complete no-op in a live run —
# and would have LOOKED like it worked: the detective was still handed
# EPAM_MAX_TOOL_CALLS=7, and the binary would simply have ignored it. It was
# caught only by a manual check before launching.
#
# That is the silent-failure class precisely — a mechanism reporting success
# while doing nothing — and nothing verified it. This does.
#
# assert_dist_fresh <repo_root>
#   0 = binary is at least as new as the source (or nothing to check)
#   1 = source is newer than the built binary
#
# Fails OPEN on anything it cannot determine: a guard that blocks runs because
# of its own confusion is worse than the defect it prevents.
# This library is sourced by callers that may not define the pipeline's own
# logging helpers. Without a fallback, every diagnostic line here died as
# "error: command not found" and the caller reported that noise INSTEAD of the
# reason — seen live 2026-07-30, where the real message ("dist/ is STALE",
# naming the exact unbuilt file) was replaced by four lines of shell errors.
# A guard whose explanation is destroyed at the moment it fires is a guard that
# gets misdiagnosed.
if ! declare -F error >/dev/null 2>&1; then
    error() { printf '[dist-freshness] %s\n' "$*" >&2; }
fi

assert_dist_fresh() {
    local repo="${1:-}"
    [ "${EPAM_SKIP_DIST_CHECK:-0}" = "1" ] && return 0
    [ -n "$repo" ] && [ -d "$repo/src" ] || return 0
    local dist="$repo/dist/epam.js"
    # No dist at all: a source-only checkout running via tsx is not this defect.
    [ -f "$dist" ] || return 0

    local dist_mtime newer
    dist_mtime=$(stat -c %Y "$dist" 2>/dev/null) || return 0
    [ -n "$dist_mtime" ] || return 0

    # Shipped source only. A .test.ts is not compiled into the bundle, and
    # counting it would block every run started right after writing a test.
    newer=$(find "$repo/src" -type f \( -name '*.ts' -o -name '*.tsx' \) \
                 -not -name '*.test.ts' -not -name '*.spec.ts' \
                 -newermt "@${dist_mtime}" -print 2>/dev/null | head -3)

    [ -z "$newer" ] && return 0

    error "dist/ is STALE — the pipeline runs dist/epam.js, so these source changes would NOT execute:"
    while IFS= read -r _f; do
        [ -n "$_f" ] && error "    ${_f#"$repo"/}"
    done <<< "$newer"
    error "  Rebuild first:  \"\$NODE\" ./node_modules/.bin/tsup"
    error "  (override with EPAM_SKIP_DIST_CHECK=1 if you know the difference is irrelevant)"
    return 1
}
