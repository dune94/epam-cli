/**
 * A FIRST ATTEMPT RENDERS, BECAUSE THERE IS NO PREVIOUS REFUSAL YET.
 *
 * Live 2026-08-24, AMSD-1919. The run reached the roster stage and died:
 *
 *   [roster] attempt 1/3 CALL FAILED: 'roster-specialisation' was given EMPTY values for:
 *   __PREVIOUS_REFUSAL__
 *
 * mint-agents-step.js passes `refusalBlock(refusal, 'roster')`. On attempt 1 there IS no refusal,
 * so it correctly returns ''. The blank-payload guard — added to stop agents being handed silence —
 * refused that empty value, because roster-specialisation.json declared no `mayBeEmpty`. A guard
 * fired on the one state that is legitimately empty.
 *
 * WHY NOTHING CAUGHT IT, AND WHY THIS TEST IS SHAPED THIS WAY.
 *
 * The per-agent harness fabricates placeholder values and falls back to
 * `(supplied value for __X__)`. It cannot produce an empty string, so it passed this seam twice —
 * once writing 57 of 57 agents — while the pipeline could not render the prompt at all.
 *
 * Worse, `every-seam-prompt-refuses-a-blank-payload` skips placeholders listed in `mayBeEmpty`;
 * with `mayBeEmpty: []` it ASSERTED that a blank __PREVIOUS_REFUSAL__ must be refused. The test
 * enforced the defect. Fixing the run would have broken the suite.
 *
 * So this test takes its value from the REAL PRODUCER — refusalBlock — and renders the REAL
 * template through the REAL renderer. No fixture I invented can drift from what the caller sends.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { refusalBlock } = require(join(LIB, 'refusal-block.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderEngineTemplate } = require(join(LIB, 'engine-prompt.js'));

/** Exactly what mint-agents-step.js:632 supplies, for the attempt given. */
const asTheMintSupplies = (refusal?: string) => ({
  __CANONICAL_COPY_PATH__: '/tmp/canonical.json',
  __OUT_PATH__: '/tmp/out.json',
  __PROJECT_CONTEXT__: 'Project config: /tmp/cfg\nTickets in scope: X-1: a ticket',
  __CODELINE_CONTEXT__: '- cl (/tmp/cl)',
  __PREVIOUS_REFUSAL__: refusalBlock(refusal, 'roster'),
  // DERIVED THE WAY THE CALLER DERIVES IT, not copied. The seam field is judged against a closed
  // list in the registry, and the prompt now carries that list; hand-writing a second copy here
  // would drift from the first the moment a seam is added.
  __DECLARED_SEAMS__: Object.keys(
    JSON.parse(readFileSync(join(LIB, '..', '..', 'agents', 'invocation-profiles.json'), 'utf8')).profiles || {},
  ).sort().map((x) => `- ${x}`).join('\n'),
});

describe('the value the caller really sends on attempt 1', () => {
  it('refusalBlock returns an empty string when there is no previous refusal', () => {
    // The premise. If this ever stops being true the rest of the test proves nothing.
    expect(refusalBlock(undefined, 'roster')).toBe('');
  });

  it('renders roster-specialisation on ATTEMPT 1 — the case that killed the run', () => {
    const out = renderEngineTemplate('roster-specialisation', asTheMintSupplies(undefined));
    expect(out.length, 'the prompt rendered empty').toBeGreaterThan(200);
    expect(out, 'a placeholder survived into the prompt').not.toMatch(/__[A-Z0-9_]+__/);
    // Not vacuous: the real instruction is present, so this is the whole prompt, not a fallback.
    expect(out).toMatch(/canonical/i);
  });

  it('renders on ATTEMPT 2 and CARRIES the refusal — the guard still does its job', () => {
    const why = 'the roster omitted 19 canonical agents';
    const out = renderEngineTemplate('roster-specialisation', asTheMintSupplies(why));
    expect(out, 'the retry was not told why it was refused').toContain(why);
  });
});

describe('every template a refusal is substituted into survives its first attempt', () => {
  // THE CLASS, NOT THE SITE. Any template rendered through the guarded renderer that declares
  // __PREVIOUS_REFUSAL__ must tolerate the empty first-attempt value, or it blocks a run the
  // first time it is reached — exactly once per run, on attempt 1, every time.
  const withRefusal = readdirSync(TEMPLATES).filter((f) => {
    if (!f.endsWith('.json')) return false;
    const t = JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8'));
    const body = t.bodies ? Object.values(t.bodies as Record<string, string>).join('\n') : String(t.body || '');
    return body.includes('__PREVIOUS_REFUSAL__');
  });

  it('there are such templates — otherwise this proves nothing', () => {
    expect(withRefusal.length).toBeGreaterThan(0);
  });

  for (const f of withRefusal) {
    it(`${f} declares __PREVIOUS_REFUSAL__ may be empty`, () => {
      const t = JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8'));
      expect(t.mayBeEmpty || [],
        `${f} will refuse attempt 1: refusalBlock() returns '' when nothing has been refused yet`)
        .toContain('__PREVIOUS_REFUSAL__');
    });
  }
});
