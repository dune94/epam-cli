/**
 * THE WRITER MUST RENDER ON A BROWNFIELD DEFECT, WHICH HAS NO ACs.
 *
 * story-writer-main is the WRITER's own prompt — the instructions the implementer executes. It
 * declared __ACCEPTANCE_CRITERIA__ as a required input. Brownfield supplies none, so the render
 * refused and the writer produced nothing:
 *
 *   [render-engine-prompt] FAILED to render 'story-writer-main'
 *   Error: [engine-prompt] 'story-writer-main' was given EMPTY values for: __ACCEPTANCE_CRITERIA__
 *   WARNING Story AMSD-1919: all 5 declared deliverable(s) exist but are UNCHANGED since baseline
 *           — no real work done
 *
 * Live 2026-09-02, run 20260902T022134Z, on the first resume that ever reached the writer.
 *
 * WHY IT WAS MISSED. The earlier brownfield-AC fix found eight templates demanding acceptance
 * criteria, corrected the four a SEAM names in the registry, and left five alone on the reasoning
 * that "no seam names them, so the registry never runs them and they cannot block a run". That was
 * wrong: four of the five are rendered directly by their caller rather than through a seam, and
 * story-writer-main is rendered by claude.sh. Registry membership is not the test of whether a
 * template runs — a render site is.
 *
 * THE WRITER IS NOT LEFT WITHOUT CRITERIA. It already declares __VERIFICATION_CRITERIA__ and
 * __UNCOVERED_VC_BLOCK__, which is precisely what brownfield does supply. Removing the AC input
 * anchors it on the criteria that exist rather than the ones that never will.
 *
 * The two *-ac-remediator templates are deliberately untouched: authoring acceptance criteria is
 * their entire job, so requiring them is correct. They must simply not run on brownfield.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const TPL = join(REPO, 'orchestrations/prompts/templates/story-writer-main.json');
const CLAUDE_SH = join(REPO, 'orchestrations/scripts/claude.sh');
const tpl = JSON.parse(readFileSync(TPL, 'utf8'));
const body = String(tpl.body || JSON.stringify(tpl.bodies || ''));
const sh = readFileSync(CLAUDE_SH, 'utf8');

describe('the writer runs on a brownfield defect', () => {
  it('the template is real and still carries the writer\'s own instructions', () => {
    expect(tpl.placeholders, 'no placeholders declared').toBeTruthy();
    expect(body.length, 'the writer template body is empty').toBeGreaterThan(500);
  });

  it('IT DOES NOT DEMAND ACCEPTANCE CRITERIA', () => {
    expect(tpl.placeholders,
      'story-writer-main still requires __ACCEPTANCE_CRITERIA__, so the writer cannot render on a '
      + 'brownfield defect and produces nothing')
      .not.toContain('__ACCEPTANCE_CRITERIA__');
    expect(body, '__ACCEPTANCE_CRITERIA__ still appears in the body')
      .not.toContain('__ACCEPTANCE_CRITERIA__');
  });

  it('AND IT STILL RECEIVES THE CRITERIA BROWNFIELD DOES SUPPLY', () => {
    // Removing the input must not leave the writer with nothing to build against — the mistake
    // made on code-review-cycle, which was left with a diff and no criteria at all.
    expect(tpl.placeholders, 'the writer lost its verification criteria')
      .toContain('__VERIFICATION_CRITERIA__');
    expect(body, '__VERIFICATION_CRITERIA__ is declared but not placed in the body')
      .toContain('__VERIFICATION_CRITERIA__');
  });

  it('THE CALLER NO LONGER SUPPLIES IT — an unused value refuses the render', () => {
    // engine-prompt refuses "values it does not use" as well as empty ones, so leaving the arg in
    // place would swap one render failure for another.
    const at = sh.indexOf('render_engine_prompt story-writer-main');
    expect(at, 'the render site was not found').toBeGreaterThan(-1);
    const callBlock = sh.slice(Math.max(0, at - 3000), at);
    expect(callBlock,
      'claude.sh still passes __ACCEPTANCE_CRITERIA__ to story-writer-main, which the template no '
      + 'longer declares — the render will be refused as an unused value')
      .not.toContain('"__ACCEPTANCE_CRITERIA__"');
  });

  it('THE GUARD IS INTACT — a contract correction, not a disabled check', () => {
    const guard = readFileSync(join(REPO, 'orchestrations/scripts/lib/engine-prompt.js'), 'utf8');
    expect(guard, 'the empty-value guard was removed instead of the contract corrected')
      .toMatch(/was given EMPTY values for/);
  });
});
