#!/usr/bin/env bash
# Generic, stack-agnostic credential/secret scanner for a git repo's STAGED
# diff. Flow-gap analysis finding #2 (2026-07-12): no commit site in this
# pipeline (Step 1.5 auto-commit, commit_completed_story() per-story commit,
# Step 3.2's worktree merges) scanned for accidentally-committed credentials
# before this. SAST (Step 4.2) is the first thing that even looks at code
# content for this, an LLM prompt not guaranteed to prioritize credential
# detection, and it runs long after several commits may have already landed
# in phase history. This scan is deliberately generic — no project/stack-
# specific patterns — so it belongs in the engine, not per-project config.
#
# Usage: scan-secrets.sh <git-root>
# Exit 0: clean (or nothing staged). Exit 1: a likely secret was found —
# prints which file(s)/pattern matched (never the matched value itself, to
# avoid re-leaking it into logs).
#
# Patterns are deliberately narrow to keep false positives low against real
# application code: well-known credential FORMATS (AWS keys, GitHub/Slack/
# OpenAI/Google token prefixes, PEM private key blocks) always fire; a
# generic "var named password/secret/token/apikey assigned a long literal"
# rule only fires when the literal does NOT look like a placeholder
# (test/example/dummy/fake/xxxx/changeme/your_/<...>/${...}/process.env/...).

set -u

GIT_ROOT="${1:?Usage: scan-secrets.sh <git-root> [commit-range]}"
RANGE="${2:-}"

# A staged-diff-only scan is blind to anything ALREADY COMMITTED but not yet
# pushed — which is exactly how a live Atlassian token reached the remote on
# 2026-07-24: the push carried 14 pre-existing commits, none of which were in
# `git diff --cached`. Passing a range (e.g. `origin/master..HEAD`) scans what a
# push would actually publish.
if [ -n "$RANGE" ]; then
    DIFF=$(git -C "$GIT_ROOT" diff -U0 "$RANGE" 2>/dev/null) || exit 0
    SCOPE="commit range $RANGE"
else
    DIFF=$(git -C "$GIT_ROOT" diff --cached -U0 2>/dev/null) || exit 0
    SCOPE="staged changes"
fi
[ -z "$DIFF" ] && exit 0

# Only inspect added lines (diff `+` lines), not removed/context lines.
ADDED=$(echo "$DIFF" | grep -E '^\+[^+]' || true)
[ -z "$ADDED" ] && exit 0

FOUND=""

# Lines that are unmistakably dummy/fixture values. Format-specific checks apply
# this too (not just the generic rule): security TESTS must be able to contain a
# credential-SHAPED string without the scanner blocking its own test suite. The
# markers are deliberately explicit (DUMMY/NOT-REAL/FAKE/PLACEHOLDER/CHANGEME) —
# a real leaked credential will not carry them.
#
# NOTE: `process.env` and `${...}` are deliberately NOT excused here (unlike in the
# generic rule). A hardcoded literal used as an env-var FALLBACK —
# `process.env.JIRA_TOKEN || 'ATATT<real>'` — is precisely how a live token sat in
# scripts/jira-proxy.js and reached the remote. A well-known credential FORMAT is a
# credential regardless of what else shares the line; only an explicit dummy marker
# excuses it.
PLACEHOLDER_RE='dummy|not-?a-?real|not-?real|fake|placeholder|changeme|xxxx|your_'

check_pattern() {
    local label="$1"
    local pattern="$2"
    local hits
    hits=$(echo "$ADDED" | grep -E -e "$pattern" | grep -viE "$PLACEHOLDER_RE" || true)
    if [ -n "$hits" ]; then
        FOUND="${FOUND}${FOUND:+, }${label}"
    fi
}

check_pattern "PEM private key block" '-----BEGIN (RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----'
check_pattern "AWS Access Key ID" 'AKIA[0-9A-Z]{16}'
check_pattern "GitHub token" 'gh[pousr]_[A-Za-z0-9]{30,}'
check_pattern "Slack token" 'xox[baprs]-[0-9A-Za-z-]{10,}'
check_pattern "OpenAI-style API key" 'sk-[A-Za-z0-9]{20,}'
check_pattern "Google API key" 'AIza[0-9A-Za-z_-]{35}'
# Atlassian (Jira/Confluence) API tokens — the format that actually escaped.
check_pattern "Atlassian API token" 'ATATT[A-Za-z0-9_.=+/-]{20,}'

# Generic: password/secret/token/apikey assigned a long literal that does NOT
# look like a placeholder. The quotes are OPTIONAL — requiring them made every
# bare `KEY=value` line invisible, i.e. the entire contents of every .env file,
# which is where the 2026-07-24 leak lived.
GENERIC_HIT=$(echo "$ADDED" | grep -iE "(password|passwd|secret|token|api[_-]?key)[\"']?[[:space:]]*[:=][[:space:]]*[\"']?[A-Za-z0-9_./+=-]{16,}[\"']?" \
    | grep -viE "test|example|dummy|fake|xxxx|changeme|your_|placeholder|process\.env|<[a-z_]+>|\\\$\{|=\\\$|set-during-setup|admin-password" || true)
[ -n "$GENERIC_HIT" ] && FOUND="${FOUND}${FOUND:+, }generic credential-shaped assignment"

if [ -n "$FOUND" ]; then
    echo "SECRET_SCAN: possible credential(s) detected in ${SCOPE}: $FOUND" >&2
    echo "SECRET_SCAN: refusing to commit — unstage and remove the credential, or use an environment variable / secret store instead." >&2
    exit 1
fi

exit 0
