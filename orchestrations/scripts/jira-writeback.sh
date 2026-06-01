#!/usr/bin/env bash
# jira-writeback.sh — Post pipeline milestone updates back to Jira.
#
# Called at four milestones during orchestration:
#   spec        — AC elaboration complete; updates issue description
#   cpa         — CPA estimate ready; posts cost/time comment
#   story-complete — story done; transitions to In Review, posts PR link
#   review-done    — review complete; transitions to Done or Reopened
#
# Usage:
#   jira-writeback.sh --milestone <spec|cpa|story-complete|review-done> \
#                     --jira-key  <PROJ-123> \
#                    [--data      <json-string>]
#
# No-ops silently when JIRA_URL is unset. Never exits non-zero (errors are
# logged to stderr but do not fail the orchestration pipeline).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_CMD="${NODE_CMD:-$(command -v node 2>/dev/null || echo 'node')}"
JIRA_CLIENT_JS="$SCRIPT_DIR/lib/jira-client.js"

# ── Arg parsing ──────────────────────────────────────────────────────────────
MILESTONE=""
JIRA_KEY=""
DATA="{}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --milestone) MILESTONE="$2"; shift 2 ;;
    --jira-key)  JIRA_KEY="$2";  shift 2 ;;
    --data)      DATA="$2";      shift 2 ;;
    *) echo "[jira-writeback] unknown arg: $1" >&2; shift ;;
  esac
done

# ── Guard: no-op when Jira not configured ────────────────────────────────────
if [ -z "${JIRA_URL:-}" ]; then
  exit 0
fi

if [ -z "$MILESTONE" ] || [ -z "$JIRA_KEY" ]; then
  echo "[jira-writeback] --milestone and --jira-key are required" >&2
  exit 0
fi

if [ ! -f "$JIRA_CLIENT_JS" ]; then
  echo "[jira-writeback] jira-client.js not found: $JIRA_CLIENT_JS" >&2
  exit 0
fi

# ── Milestone handlers ────────────────────────────────────────────────────────

case "$MILESTONE" in

  spec)
    # AC elaboration: post elaborated ACs as a comment
    AC_TEXT=$(echo "$DATA" | "$NODE_CMD" -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const acs = d.acceptanceCriteria || d.acs || [];
      console.log('*Elaborated Acceptance Criteria (epam-cli CPA pass):*\n' +
        acs.map((a,i) => (i+1)+'. '+a).join('\n'));
    " 2>/dev/null || echo "AC elaboration complete.")

    "$NODE_CMD" -e "
      const j = require('$JIRA_CLIENT_JS');
      j.addComment('$JIRA_KEY', \`$AC_TEXT\`).then(
        () => process.stdout.write('[jira-writeback] spec comment posted: $JIRA_KEY\n'),
        e  => process.stderr.write('[jira-writeback] spec comment failed: ' + e.message + '\n')
      );
    " || true
    ;;

  cpa)
    # CPA estimate: post cost and time comment
    COMMENT=$(echo "$DATA" | "$NODE_CMD" -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const min  = d.aiMinutes  || d.estimatedAiMinutes || '?';
      const cost = d.cost       || d.estimatedCost      || '?';
      const conf = d.confidence || '?';
      console.log('*epam-cli CPA estimate:* ' + min + ' min / \$' + cost +
        ' (confidence: ' + conf + ')');
    " 2>/dev/null || echo "CPA estimate complete.")

    "$NODE_CMD" -e "
      const j = require('$JIRA_CLIENT_JS');
      j.addComment('$JIRA_KEY', \`$COMMENT\`).then(
        () => process.stdout.write('[jira-writeback] cpa comment posted: $JIRA_KEY\n'),
        e  => process.stderr.write('[jira-writeback] cpa comment failed: ' + e.message + '\n')
      );
    " || true
    ;;

  story-complete)
    # Transition to In Review and post PR link
    PR_URL=$(echo "$DATA" | "$NODE_CMD" -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(d.prUrl || d.pr_url || '');
    " 2>/dev/null || echo "")

    COMMENT="Story implementation complete by epam-cli orchestration."
    [ -n "$PR_URL" ] && COMMENT="$COMMENT PR: $PR_URL"

    "$NODE_CMD" -e "
      const j = require('$JIRA_CLIENT_JS');
      Promise.all([
        j.transitionIssue('$JIRA_KEY', 'In Review'),
        j.addComment('$JIRA_KEY', '$COMMENT'),
      ]).then(
        () => process.stdout.write('[jira-writeback] story-complete posted: $JIRA_KEY\n'),
        e  => process.stderr.write('[jira-writeback] story-complete failed: ' + e.message + '\n')
      );
    " || true
    ;;

  review-done)
    # Transition to Done or Reopened based on review result
    RESULT=$(echo "$DATA" | "$NODE_CMD" -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log((d.result || d.verdict || 'pass').toLowerCase());
    " 2>/dev/null || echo "pass")

    if [[ "$RESULT" == "pass" || "$RESULT" == "approved" ]]; then
      TRANSITION="Done"
      COMMENT="Review passed. Story closed by epam-cli."
    else
      TRANSITION="Reopened"
      COMMENT="Review failed — story reopened for rework. Reason: $(echo "$DATA" | "$NODE_CMD" -e "
        const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
        console.log(d.reason || d.summary || 'see review artifact');
      " 2>/dev/null || echo 'see review artifact')"
    fi

    "$NODE_CMD" -e "
      const j = require('$JIRA_CLIENT_JS');
      Promise.all([
        j.transitionIssue('$JIRA_KEY', '$TRANSITION'),
        j.addComment('$JIRA_KEY', \`$COMMENT\`),
      ]).then(
        () => process.stdout.write('[jira-writeback] review-done posted: $JIRA_KEY ($TRANSITION)\n'),
        e  => process.stderr.write('[jira-writeback] review-done failed: ' + e.message + '\n')
      );
    " || true
    ;;

  *)
    echo "[jira-writeback] unknown milestone: $MILESTONE" >&2
    ;;
esac

exit 0
