/**
 * EVERY AGENT RESOLVES TO A PROMPT.
 *
 * Operator direction, 2026-08-15: every prompt lives in the template layer — all of them, no
 * exceptions — and there must be a LINK from the agent registry to the project layer's
 * prompts. A prompt nobody can trace to an agent is a prompt nobody reviews.
 *
 * The registry already has the link: a seam declares `template: <id>`. Only 5 of 25 seams
 * declared one when this was written, while all 20 of the others carry a `ladder`, which
 * means every one of them invokes a model — from a prompt embedded in a shell string.
 *
 * THIS TEST IS THE MIGRATION CHECKLIST. It is derived from the engine's own registry rather
 * than from a grep, because a text sweep under-reports: the register in memory records that a
 * single-method sweep missed a whole file and undercounted by a factor of three. Every seam
 * that invokes a model must name a template; every named template must exist. Each migration
 * turns one entry green.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT. It does not require a project-layer copy to exist on
 * disk, because provisioning differs by design: metrolinx takes the template layer as is, and
 * mock3 generates from it. What must hold everywhere is that the LINK resolves — an agent
 * pointing at a template that does not exist fails at the seam that needed it, mid-run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');

const registry = () => JSON.parse(readFileSync(REGISTRY, 'utf8'));

/**
 * A seam invokes a model when it declares a ladder — that is the field that resolves which
 * model runs. A deterministic step has none, and must not be required to name a prompt.
 */
function modelInvokingSeams(): Array<[string, any]> {
  const r = registry();
  return Object.entries(r.profiles || {}).filter(([, v]: any) => v && v.ladder);
}

describe('the registry is the authority on which agents need a prompt', () => {
  it('is not vacuous — the registry lists seams and some invoke a model', () => {
    const seams = modelInvokingSeams();
    expect(seams.length).toBeGreaterThan(10);
  });

  it('every model-invoking seam names its template', () => {
    // RED until every embedded prompt is migrated. The failure lists exactly what is left,
    // so this doubles as the checklist rather than needing one maintained by hand.
    const missing = modelInvokingSeams()
      .filter(([, v]: any) => !v.template)
      .map(([k]) => k);
    expect(missing, `${missing.length} seam(s) invoke a model from an embedded prompt`).toEqual([]);
  });

  it('every template a seam names actually exists in the template layer', () => {
    // A dangling link fails at the seam that needed it, hours into a run, naming a file
    // nobody provisioned — the same shape as the coupled-pair gate's missing manifest.
    const dangling = modelInvokingSeams()
      .filter(([, v]: any) => v.template)
      .filter(([, v]: any) => !existsSync(join(TEMPLATES, `${v.template}.json`)))
      .map(([k, v]: any) => `${k} -> ${v.template}`);
    expect(dangling, 'seam(s) point at a template that does not exist').toEqual([]);
  });

  it('no seam names a template that carries a project fact', () => {
    // A template is generic by definition; a project detail in one makes it wrong for every
    // other project while looking correct for the one it names.
    const offenders: string[] = [];
    for (const [seam, v] of modelInvokingSeams()) {
      const t = (v as any).template;
      if (!t) continue;
      const p = join(TEMPLATES, `${t}.json`);
      if (!existsSync(p)) continue;
      const doc = JSON.parse(readFileSync(p, 'utf8'));
      const body = doc.body ?? JSON.stringify(doc.bodies ?? '');
      const hit = /metrolinx|gotransit|upexpress|contentstack|travel-app|skyscanner|hello-dolly/i.exec(body);
      if (hit) offenders.push(`${seam} -> ${t} names '${hit[0]}'`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the templates that exist are reachable from an agent', () => {
  it('reports templates no seam points at, so orphans are visible', () => {
    // Not a failure: policy fragments (blocker-discipline, test-ownership) bind agents
    // without being a seam's own prompt, and the bootstrap pair is used by the builder.
    // Printing them keeps an orphan from hiding, which is how a prompt stops being reviewed.
    const named = new Set(modelInvokingSeams().map(([, v]: any) => v.template).filter(Boolean));
    const boot = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/bootstrap.json'), 'utf8'));
    const all: string[] = [...boot.copyVerbatim, ...boot.generated];
    const orphans = all.filter((id) => !named.has(id) && !boot.copyVerbatim.includes(id));
    // eslint-disable-next-line no-console
    if (orphans.length) console.log(`[alignment] templates no seam names: ${orphans.join(', ')}`);
    expect(Array.isArray(orphans)).toBe(true);
  });
});
