/**
 * bootstrap.json RESTATES WHAT THE SEAM REGISTRY ALREADY DECLARES, SO THE TWO DRIFT.
 *
 * A seam that declares `template: X` will execute X, and therefore X needs a project copy —
 * otherwise it runs the immutable generic parent, unspecialised for the project. That makes the
 * list a FACT OF THE REGISTRY. bootstrap.generated restated it by hand, and hand-maintained copies
 * of a derivable fact only ever drift apart.
 *
 * Measured 2026-08-17, of bootstrap.generated's 44 entries:
 *
 *   25  also declared by a seam         — redundant; the registry already says this
 *   19  auxiliary sub-prompts           — legitimate; referenced inside a template body,
 *                                         named by no seam, and the registry cannot know them
 *    7  seam-run but ABSENT             — codeline-bridge, e2e-route-check, assign-agent-roles,
 *                                         spec-story-block, skill-assessment-prephase,
 *                                         prd-model-coordinator, prompt-review
 *
 * The 25 redundant entries are the entire drift surface: every new seam silently requires a second
 * edit to a file with no mechanism forcing it. The code comment recorded the gap at 6; it is 7 —
 * and the seventh is prompt-review, a seam added on 2026-08-17 by the same session that wrote the
 * comment. The mechanism failed on its own author within a commit of being described.
 *
 * The union in project-prompt-builder rescues it at runtime, so nothing is broken today. This
 * makes the class unrepresentable instead: bootstrap carries ONLY what the registry cannot know,
 * so there is nothing left to fall out of step.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const BOOTSTRAP = join(ROOT, 'orchestrations/prompts/bootstrap.json');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

const boot = JSON.parse(readFileSync(BOOTSTRAP, 'utf8'));
const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));

const generated: string[] = boot.generated || [];
const copyVerbatim: string[] = boot.copyVerbatim || [];
/** Every template a seam declares — the registry's own statement of what a seam runs. */
const seamRun = [...new Set(
  Object.values(registry.profiles || {} as Record<string, { template?: string }>)
    .map((p: any) => p.template)
    .filter(Boolean),
)] as string[];

describe('bootstrap duplicates the seam registry', () => {
  it('the inputs are non-empty — otherwise every assertion below is vacuous', () => {
    expect(seamRun.length, 'no seam declares a template — the registry read wrong').toBeGreaterThan(20);
    expect(generated.length, 'bootstrap.generated is empty — the read is wrong').toBeGreaterThan(0);
  });

  it('BOOTSTRAP DECLARES NOTHING THE REGISTRY ALREADY DECLARES', () => {
    // The 25. Each is a hand-kept copy of a fact the registry states authoritatively.
    const redundant = generated.filter((t) => seamRun.includes(t));
    expect(redundant,
      `bootstrap.generated restates ${redundant.length} template(s) the seam registry already `
      + `declares, and a hand-kept copy of a derivable fact drifts: ${redundant.join(', ')}`)
      .toEqual([]);
  });

  it('every seam-run template still reaches provisioning', () => {
    // The point is not to shorten the list — it is that the registry becomes the source. Removing
    // the 25 must not drop them, so this asserts the union covers every seam-declared template.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { provisioningList } = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js'));
    expect(typeof provisioningList,
      'project-prompt-builder does not expose the resolved list, so it cannot be asserted')
      .toBe('function');

    const resolved: string[] = provisioningList({ bootstrap: boot, registry });
    const missing = seamRun.filter((t) => !resolved.includes(t) && !copyVerbatim.includes(t));
    expect(missing,
      `these seams would execute the generic template: ${missing.join(', ')}`).toEqual([]);
  });

  it('the auxiliary prompts survive — the registry genuinely cannot know them', () => {
    // Sub-prompts referenced INSIDE a template body, named by no seam. Deriving alone drops them.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { provisioningList } = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js'));
    const resolved: string[] = provisioningList({ bootstrap: boot, registry });
    for (const aux of ['story-kind-hint-defect', 'detective-retry-note', 'vc-review']) {
      expect(resolved, `auxiliary prompt '${aux}' was dropped`).toContain(aux);
    }
  });

  it('a seam whose template is missing everywhere is an ERROR, not a silent omission', () => {
    // Inverting the union: the registry is the source, so a gap must fail rather than be rescued.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { provisioningList } = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js'));
    expect(() => provisioningList({
      bootstrap: { generated: [], copyVerbatim: [] },
      registry: { profiles: { x: { template: 'no-such-template-anywhere' } } },
      templateExists: () => false,
    })).toThrow(/no-such-template-anywhere/);
  });
});
