/**
 * THE FIRST RETRY COULD NOT BE TOLD WHY IT FAILED.
 *
 * On a deterministic-check violation, claude.sh builds the coordinator amendment with
 *
 *     --arg prior_diagnosis_section "${_last_fa_diagnosis:+ ...section... }"
 *
 * `${var:+...}` expands to an EMPTY STRING when no prior failure-analyst diagnosis exists — which is
 * the normal state of the FIRST violation, before any analyst has run. But
 * coordinator-amendment.json declares __PRIOR_DIAGNOSIS_SECTION__ as a placeholder and lists no
 * `mayBeEmpty`, so engine-prompt.js throws, the render produces nothing, and render_or_keep falls
 * back to the PREVIOUS amendment.
 *
 * The retry then runs without being told what went wrong, reproduces the same violation, and
 * HealingBroken fires — which invokes the failure analyst anyway. The "skip the analyst, the
 * violation is already precisely known" optimisation saves nothing and costs an attempt.
 *
 * Live 2026-09-11, openrouter run 20260910T222155Z: exactly two render failures, at 00:58:55 and
 * 01:02:35, both BEFORE the first healing event was written at 01:04:08 — and none afterwards. The
 * timing matches the cause exactly.
 *
 * engine-prompt.js names the remedy in its own error: "declare the placeholder in the template's
 * `mayBeEmpty` if absent is a real state for it." Absent IS a real state here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const TPL = join(ROOT, 'orchestrations/prompts/templates/coordinator-amendment.json');
const ID = 'coordinator-amendment';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderEngineTemplate } = require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));

/** Every placeholder the deterministic_check variant needs, with the diagnosis section absent. */
const VALUES_NO_DIAGNOSIS = {
  __PRIOR_DIAGNOSIS_SECTION__: '',
  __VERIFICATION_FAILURE__: 'relative import check: src/x.ts imports ../../y',
  __EXISTING_AMENDMENT__: '## Existing amendment\nprevious guidance',
};

describe('an absent prior diagnosis is a real state, not a failure', () => {
  it('the template really is the one that broke — it declares the placeholder', () => {
    const t = JSON.parse(readFileSync(TPL, 'utf8'));
    const decl = JSON.stringify(t);
    expect(decl, 'the placeholder is gone — this test is stale')
      .toContain('__PRIOR_DIAGNOSIS_SECTION__');
  });

  it('renders the deterministic_check variant with NO prior diagnosis', () => {
    let rendered = '';
    expect(() => { rendered = renderEngineTemplate(ID, VALUES_NO_DIAGNOSIS, 'deterministic_check'); },
      'the render threw on an empty prior-diagnosis section, so the retry was never told what ' +
      'went wrong and repeated the same violation').not.toThrow();
    expect(rendered.length, 'rendered nothing').toBeGreaterThan(0);
  });

  it('still carries the failure it DOES know about', () => {
    const out = renderEngineTemplate(ID, VALUES_NO_DIAGNOSIS, 'deterministic_check');
    expect(out, 'the deterministic-check failure did not reach the prompt')
      .toContain('relative import check');
  });

  it('still includes the diagnosis when there IS one — the section is not disabled', () => {
    const out = renderEngineTemplate(ID, {
      ...VALUES_NO_DIAGNOSIS,
      __PRIOR_DIAGNOSIS_SECTION__: '\n\n## Prior failure-analyst diagnosis\nANALYZE is build-time config',
    }, 'deterministic_check');
    expect(out).toContain('ANALYZE is build-time config');
  });

  it('a genuinely required placeholder still refuses to be empty', () => {
    expect(() => renderEngineTemplate(ID,
      { ...VALUES_NO_DIAGNOSIS, __VERIFICATION_FAILURE__: '   ' }, 'deterministic_check'),
      'an empty verification failure was accepted — the agent would answer about silence')
      .toThrow(/EMPTY values/);
  });
});
