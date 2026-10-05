/**
 * A COHERENT APPROVAL ANSWERS THE REVIEWER'S OWN SELF-CONTRADICTION — NO CODE CHANGE IS OWED.
 *
 * Live AMSD-2974, 2026-10-05 (gotransit): review cycle 2 APPROVED while its own assessment marked a
 * criterion UNMET ("Keyboard+screen-reader walkthrough finds no WCAG 2.2 AA failures …; axe scan reports
 * no violations" — a check no code reviewer can perform). vc-assessment-gate turned that into a blocker,
 * correctly. Cycle 3 assessed it coherently and approved — and the give-up rule refused the approval as
 * "APPROVED after a blocker-level rejection, with the codeline UNCHANGED", HALTing the lane. The blocker
 * was never about the code; nothing in the code could have answered it.
 *
 * EXECUTED: the real vc-assessment-gate.js, the feedback file as team-lead-review.sh writes it
 * (jq '{verdict, summary, issues, reviewIncomplete}'), and the real _review_feedback_has_code_blocker /
 * _review_approval_is_giveup from lib/phase-assessment.sh.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const dir = mkdtempSync(join(tmpdir(), 'self-contradiction-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const VC = 'Keyboard+screen-reader walkthrough finds no WCAG 2.2 AA failures (4.1.3,4.1.2,1.4.3,2.2.1,1.4.10,3.3.1); axe scan reports no violations';

/** The review JSON through the real gate, then written as team-lead-review.sh writes the feedback file. */
function feedbackFrom(review: object, name: string): string {
  const gated = spawnSync(process.execPath, [join(SCRIPTS, 'lib/handlers/vc-assessment-gate.js'), JSON.stringify([VC])], { input: JSON.stringify(review), encoding: 'utf8' });
  expect(gated.status, gated.stderr).toBe(0);
  const f = join(dir, `${name}.json`);
  const fb = spawnSync('jq', ['-c', '{verdict, summary, issues, reviewIncomplete}'], { input: gated.stdout, encoding: 'utf8' });
  writeFileSync(f, fb.stdout);
  return f;
}
const hasCodeBlocker = (f: string) => spawnSync('bash', ['-c', `. ${JSON.stringify(join(SCRIPTS, 'lib/phase-assessment.sh'))} >/dev/null 2>&1; _review_feedback_has_code_blocker ${JSON.stringify(f)} && echo yes || echo no`], { encoding: 'utf8' }).stdout.trim();
const giveup = (prevBlocker: string) => spawnSync('bash', ['-c', `. ${JSON.stringify(join(SCRIPTS, 'lib/phase-assessment.sh'))} >/dev/null 2>&1; _review_approval_is_giveup ${prevBlocker} fp-same fp-same && echo giveup || echo stands`], { encoding: 'utf8' }).stdout.trim();

describe('the give-up rule after a rejection', () => {
  it('the live shape: an approval marking a criterion unmet is rejected — and is not a CODE blocker', () => {
    const f = feedbackFrom({ verdict: 'approved', summary: 'keys resolved', issues: [], vcAssessment: [{ criterion: VC, met: false, evidence: 'needs a manual walkthrough' }] }, 'contradiction');
    const fb = JSON.parse(require('node:fs').readFileSync(f, 'utf8'));
    expect(fb.verdict, 'the gate did not reject the self-contradicting approval — the test proves nothing').toBe('changes_requested');
    expect(fb.issues.some((i: any) => i.severity === 'blocker'), 'no blocker was injected').toBe(true);
    expect(hasCodeBlocker(f)).toBe('no');
    expect(giveup(hasCodeBlocker(f) === 'yes' ? '1' : '0'), 'a coherent approval with unchanged code was refused').toBe('stands');
  });

  it('a blocker about the code still arms the rule: an approval with unchanged code is refused', () => {
    const f = feedbackFrom({ verdict: 'changes_requested', summary: 'missing keys', issues: [{ severity: 'blocker', file: 'public/locales/en/common.json', description: 'missing translation key' }] }, 'code');
    expect(hasCodeBlocker(f)).toBe('yes');
    expect(giveup('1')).toBe('giveup');
  });

  it('both at once: the code blocker still counts', () => {
    const f = feedbackFrom({ verdict: 'approved', summary: 's', issues: [{ severity: 'blocker', file: 'a.ts', description: 'real defect' }], vcAssessment: [{ criterion: VC, met: false }] }, 'both');
    expect(hasCodeBlocker(f)).toBe('yes');
  });
});
