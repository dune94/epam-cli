/**
 * The team-lead reviewer must NEVER silently approve an unreviewed change.
 *
 * Found live 2026-07-23: the review-agent (tool-enabled, no ladder/timeout)
 * thrashed to its iteration cap producing "Agent reached maximum iterations"
 * (no verdict), and team-lead-review.sh's parse-fallback defaulted a non-verdict
 * to {"verdict":"approved"} — so an unreviewed fix (with over-engineered halving
 * logic the concision veto should have caught) was rubber-stamped APPROVED.
 *
 * Fixes: (1) run_review_prompt escalates up the model ladder + tight iteration
 * cap + retry, and on total failure emits an explicit changes_requested (never
 * approved); (2) the JSON parse-fallback defaults to changes_requested, not
 * approved.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SH = join(__dirname, '../../../orchestrations/scripts/team-lead-review.sh');
const src = readFileSync(SH, 'utf8');

describe('reviewer ladder + resilience', () => {
  it('has ladder-lookup + provider-resolution helpers', () => {
    expect(src).toMatch(/_ladder_next_model\(\)/);
    expect(src).toMatch(/_provider_for_model\(\)/);
    expect(src).toMatch(/EPAM_MODEL_LADDER_HIGH/);
  });

  it('run_review_prompt retries with ladder escalation and a tight iteration cap', () => {
    expect(src).toMatch(/review-agent ladder escalation \(attempt/);
    expect(src).toMatch(/EPAM_MAX_ITERATIONS="\$\{REVIEW_MAX_ITERATIONS:-12\}"/);
    expect(src).toMatch(/REVIEW_MAX_ATTEMPTS/);
  });

  it('detects a thrashed/empty/stalled review and retries instead of accepting it', () => {
    expect(src).toMatch(/reached maximum iterations\|prompt runner timed out\|agent reached maximum/);
    expect(src).toMatch(/produced NO verdict \(thrash\/empty\)/);
  });

  // The ladder + provider helpers actually resolve correctly (real bash execution).
  it('ladder helpers resolve glm-5.1 → kimi-k3 and its provider', () => {
    const out = execFileSync('bash', ['-c', `
      source <(sed -n '/^_ladder_next_model()/,/^}/p;/^_provider_for_model()/,/^}/p' ${SH})
      export EPAM_MODEL_LADDER_HIGH="z-ai/glm-5.2=z-ai/glm-5.1|z-ai/glm-5.1=moonshotai/kimi-k3"
      export EPAM_MODEL_PROVIDER_MAP="moonshotai/*=qwen|z-ai/*=qwen"
      echo "$(_ladder_next_model z-ai/glm-5.1)|$(_provider_for_model moonshotai/kimi-k3)|$(_ladder_next_model z-ai/glm-5.2)"
    `], { encoding: 'utf8' }).trim();
    expect(out).toBe('moonshotai/kimi-k3|qwen|z-ai/glm-5.1');
  });
});

describe('reviewer NEVER silently approves an unreviewed change', () => {
  it('a total review failure emits changes_requested (blocker), not approved', () => {
    expect(src).toMatch(/failed to produce a verdict after .* attempt\(s\).*NOT approved/);
    // the fallback JSON on total failure is changes_requested, not approved
    expect(src).toMatch(/"verdict":"changes_requested"[\s\S]*review incomplete — not reviewed/);
  });

  it('an unparseable verdict defaults to changes_requested, not approved', () => {
    expect(src).toMatch(/result = \{'verdict': 'changes_requested'/);
    expect(src).toMatch(/STORY_VERDICT=\$\(echo "\$REVIEW_JSON" \| jq -r '\.verdict \/\/ "changes_requested"'/);
  });

  it('an unavailable runner blocks rather than auto-approving', () => {
    expect(src).toMatch(/review-agent unavailable.*NOT.*auto-approving|blocking rather than auto-approving/i);
  });
});
