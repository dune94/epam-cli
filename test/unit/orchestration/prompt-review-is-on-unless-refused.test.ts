/**
 * RETEST OF bcd03df — "prompt review: on by default, provisioned first, given a source to review".
 *
 * The commit's own summary: prompt review was declared, built, and never ran. It was gated behind
 * EPAM_PROMPT_REVIEW_ENABLED, which no project set — so the one artefact every downstream agent
 * inherits was the only generated thing installed unexamined.
 *
 * The rule it established: ON unless a project explicitly turns it off. That is a different
 * statement from "there is a flag", and it is the one worth guarding: an opt-in that nobody opts
 * into is indistinguishable from a feature that does not exist.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/mint-agents-step.js'), 'utf8');

/** The shipped decision, evaluated rather than described. */
function enabledWith(value: string | undefined): boolean {
  const m = /_promptReviewEnabled\s*=\s*(.+?);\s*$/m.exec(SRC);
  if (!m) throw new Error('the prompt-review decision was not found in mint-agents-step.js');
  const expr = m[1];
  const process_ = { env: value === undefined ? {} : { EPAM_PROMPT_REVIEW_ENABLED: value } };
  // eslint-disable-next-line no-new-func
  return Function('process', `return (${expr});`)(process_);
}

describe('prompt review is on unless refused', () => {
  it('the decision exists in the shipped code — not just in a comment', () => {
    expect(SRC).toMatch(/_promptReviewEnabled\s*=/);
  });

  it('is ON when no project says anything', () => {
    // The defect: an opt-in nobody opted into. Every downstream agent inherits this artefact.
    expect(enabledWith(undefined), 'prompt review is off by default again — it will never run')
      .toBe(true);
  });

  it('is ON when a project sets it to 1', () => {
    expect(enabledWith('1')).toBe(true);
  });

  it('is OFF only when a project explicitly says 0', () => {
    // Refusal must still be possible, and must require saying so.
    expect(enabledWith('0'), 'a project can no longer turn prompt review off').toBe(false);
  });

  it('an unrecognised value does not silently disable it', () => {
    // "off unless exactly 1" would resurrect the original defect for anyone setting true/yes.
    expect(enabledWith('true')).toBe(true);
    expect(enabledWith('')).toBe(true);
  });
});
