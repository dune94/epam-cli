#!/usr/bin/env bash
# repro_writer_baseline <project-root> — the branch the test-writer diffs against, as "<branch>\t<source>".
# NO GUESSED BRANCH: the project's declaration (JIRA_BASELINE_BRANCH), else the repository's checked-out
# branch ("checked-out", which the caller reports), else nothing. One definition for every caller of the
# test-writer — Step 3.54 and the gates' test-only remediation.
repro_writer_baseline() {
    local _root="${1:-${PROJECT_ROOT:-}}" _b="${JIRA_BASELINE_BRANCH:-}"
    if [ -n "$_b" ]; then printf '%s\tdeclared\n' "$_b"; return 0; fi
    _b=$(git -C "$_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    [ "$_b" = "HEAD" ] && _b=""
    [ -n "$_b" ] && printf '%s\tchecked-out\n' "$_b"
    return 0
}
