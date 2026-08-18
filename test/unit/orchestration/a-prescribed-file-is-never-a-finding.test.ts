/**
 * A PRESCRIBED FILE IS NEVER A FINDING.
 *
 * blocker-discipline already protected one direction: the reviewer may not demand work
 * the plan does not name (rule 1), and may not fault a site the plan exempts for being
 * untouched (rule 2). Nothing protected the other direction — faulting the implementer
 * for changing a file the plan DID name.
 *
 * Live failure, run 20260814T213253Z (metrolinx, AMSD-2041). The plan named five sites.
 * The implementer changed exactly those five and no others. The reviewer rejected it:
 *
 *     "the change is over-engineered: it modifies 6 files when the prescribed minimal
 *      fix requires only 2 (contentstack.ts and _app.tsx)"
 *
 * The "2" is nowhere in the plan the reviewer was handed. Compliance was the thing
 * being rejected, so no attempt could pass; four cycles later the ladder was exhausted
 * and the retry destroyed work that had passed tests and tsc.
 *
 * These tests RENDER the reviewer block through the real prompt library — the same call
 * the pipeline makes — because the template is not what executes. The project-authority
 * copy is, and editing only the template leaves the fix inert. That is exactly what
 * happened while writing this: the template said one thing and the live prompt said
 * another until the project copy was re-minted.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/prompt-library.js');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/blocker-discipline.json');
const PROJECT_DIR = join(ROOT, 'orchestrations/projects/metrolinx');
const PROJECT_PROMPT = join(PROJECT_DIR, 'prompts/blocker-discipline.json');

/** Render the reviewer block exactly as the pipeline does. */
function renderReviewerBlock(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blocker-'));
  try {
    const values = join(dir, 'values.json');
    writeFileSync(values, '{}');
    const res = spawnSync(
      process.execPath,
      [LIB, 'render', 'blocker-discipline', PROJECT_DIR, values, 'reviewer'],
      { encoding: 'utf8' },
    );
    return (res.stdout || '') + (res.stderr || '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the reviewer may not reject compliance with the plan', () => {
  it('renders a non-empty block — otherwise every assertion below is vacuous', () => {
    const out = renderReviewerBlock();
    expect(out.length).toBeGreaterThan(200);
    expect(out).toMatch(/What may be a BLOCKER/);
  });

  it('states that changing a prescribed file is never a finding', () => {
    const out = renderReviewerBlock();
    expect(out).toMatch(/IS IT INSIDE THE PLAN/);
    expect(out).toMatch(/never raise a finding of any severity because a prescribed file was changed/i);
  });

  it('forbids asserting a smaller file set than the plan names', () => {
    // This is the precise move that made the live rejection unwinnable.
    const out = renderReviewerBlock();
    expect(out).toMatch(/never assert a smaller set of files than the plan names/i);
  });

  it('scopes the over-engineering veto to the plan, not the reviewer\'s own estimate', () => {
    const out = renderReviewerBlock();
    expect(out).toMatch(/materially larger than the PLAN OF RECORD/);
    // The unscoped wording is what licensed an invented standard.
    expect(out).not.toMatch(/materially larger than the prescribed minimal fix/);
  });

  it('keeps both original directions intact — this adds a rule, it does not replace one', () => {
    const out = renderReviewerBlock();
    expect(out).toMatch(/IS IT IN THE PLAN/);      // rule 1: no demands beyond the plan
    expect(out).toMatch(/DOES THE PLAN EXEMPT IT/); // rule 2: exempt sites stay untouched
    expect(out).toMatch(/CAN IT BE SATISFIED/);     // rule 3: blockers must be achievable
  });

  it('the project-authority copy is re-minted from the template, so the fix is not inert', () => {
    // The library executes the PROJECT copy. A template edit alone changes nothing, and
    // the recorded hash is what makes that drift detectable instead of silent.
    const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    const proj = JSON.parse(readFileSync(PROJECT_PROMPT, 'utf8'));
    const sha = createHash('sha256')
      .update(JSON.stringify(tpl.bodies, null, 0))
      .digest('hex');
    expect(
      proj.derivedFromSha256,
      'the template changed after this project prompt was minted — re-mint it, or the ' +
        'project runs an older prompt than the template claims',
    ).toBe(sha);
  });
});
