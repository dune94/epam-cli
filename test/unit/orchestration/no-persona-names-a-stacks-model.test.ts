/**
 * A PERSONA MUST NOT NAME A MODEL. THE STACK DECIDES THAT.
 *
 * The prd-model-coordinator persona instructed, in prose: default to model="MiniMax-M3",
 * aiProvider="minimax". Run on the claude stack, the coordinator therefore wrote a model that is on
 * no declared claude ladder into every story of the PRD.
 *
 * A model off the ladder has no successor, so every caller reads it as "already at the top": the
 * writer would spend its whole attempt budget on one rung and never escalate, and the FOLLOWING run
 * refuses to start at all. Caught 2026-08-28 by the launcher pre-flight, before any writer spend —
 * but only after every mock3 PRD since 2026-08-18 had carried it.
 *
 * The permitted models are whatever the resolved provider set declares, which is why the default
 * belongs in the run's data (ladder-models.js emits it, opening model first) and never in a persona
 * written once and read on every stack. This test holds the rule for ALL personas, not just the one
 * that broke: a persona that names a model is wrong whichever stack happens to be running.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
/**
 * EVERY profile SOURCE, not just the one that was noticed.
 *
 * The persona was fixed in profiles.canonical.json and left untouched in profiles.json.original —
 * so the model name was removed from one source and kept in another, which is how the same defect
 * comes back on the next run that restores from the other file. The rule has always been that the
 * three profile files move together.
 *
 * profiles.json is GENERATED from these and is deliberately not listed: it is restored per run, and
 * editing it would be editing output instead of the thing that produces it.
 */
const PROFILE_SOURCES = [
  'orchestrations/agents/profiles.canonical.json',
  'orchestrations/agents/profiles.json.original',
].map((p) => join(ROOT, p));

/** Every model name any declared provider set can resolve to — the stack's own vocabulary. */
function declaredModels(): string[] {
  const out = new Set<string>();
  for (const set of ['claude', 'codemie', 'openrouter', 'mockserver']) {
    const f = join(ROOT, `orchestrations/config/llm-defaults.${set}.json`);
    if (!existsSync(f)) continue;
    const doc = JSON.parse(readFileSync(f, 'utf8'));
    for (const ladder of Object.values<any>(doc.ladders || {})) {
      if (ladder?.startModel) out.add(ladder.startModel);
      for (const hop of ladder?.modelLadder || []) {
        if (hop?.from) out.add(hop.from);
        if (hop?.to) out.add(hop.to);
      }
    }
  }
  return [...out];
}

describe('NO PERSONA NAMES A MODEL', () => {
  it('no profile SOURCE mentions a model any stack declares', () => {
    const models = declaredModels();
    expect(models.length, 'no models resolved — this test would pass vacuously').toBeGreaterThan(3);

    const offenders: string[] = [];
    for (const file of PROFILE_SOURCES) {
      if (!existsSync(file)) continue;
      for (const [name, body] of Object.entries<any>(JSON.parse(readFileSync(file, 'utf8')))) {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        for (const m of models) {
          if (text.includes(m)) offenders.push(`${file.split('/').pop()}: ${name} names "${m}"`);
        }
      }
    }
    expect(offenders, 'a persona names a specific model, so it is right on one stack and wrong on '
      + 'every other — the model belongs to the resolved provider set, not to the prose')
      .toEqual([]);
  });
});

describe('THE DEFAULT COMES FROM THE RESOLVED LADDER', () => {
  it('ladder-models.js offers an opening model to default to', () => {
    // What the persona must defer to instead of naming one. Driven by the real producer.
    const out = execFileSync(process.execPath,
      [join(ROOT, 'orchestrations/scripts/lib/handlers/ladder-models.js')],
      { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: 'claude' } });
    const models = JSON.parse(out);
    expect(Array.isArray(models) && models.length, `no models emitted: ${out}`).toBeTruthy();
    expect(models[0], 'the opening model must be a claude model on the claude stack')
      .toMatch(/^claude-/);
  });

  it('and every model it offers can actually escalate or is the top', () => {
    // The property the pre-flight enforces: a model on the ladder has a successor, or is the last.
    const doc = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/llm-defaults.claude.json'), 'utf8'));
    const reachable = new Set<string>();
    for (const ladder of Object.values<any>(doc.ladders || {})) {
      if (ladder?.startModel) reachable.add(ladder.startModel);
      for (const hop of ladder?.modelLadder || []) reachable.add(hop.to);
    }
    const out = execFileSync(process.execPath,
      [join(ROOT, 'orchestrations/scripts/lib/handlers/ladder-models.js')],
      { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: 'claude' } });
    const offered: string[] = JSON.parse(out);
    expect(offered.filter((m) => !reachable.has(m)),
      'a model is offered as a default that no ladder can reach').toEqual([]);
  });
});

describe('THE RENDERED PROMPT CARRIES THE RUNNING STACK\'S VOCABULARY', () => {
  // Asserting the ARTIFACT, not the template source: a placeholder declared but never supplied
  // renders as itself, and the coordinator would read "__MC_PERMITTED_MODELS__" as its permitted set.

  const render = (set: string) => {
    const models = JSON.parse(execFileSync(process.execPath,
      [join(ROOT, 'orchestrations/scripts/lib/handlers/ladder-models.js')],
      { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: set } }) || '[]');
    const providers = JSON.parse(execFileSync(process.execPath,
      [join(ROOT, 'orchestrations/scripts/lib/handlers/ladder-providers.js')],
      { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: set } }) || '[]');
    const tpl = JSON.parse(readFileSync(
      join(ROOT, 'orchestrations/prompts/templates/prd-model-coordinator.json'), 'utf8'));
    const body = Array.isArray(tpl.body) ? tpl.body.join('\n') : tpl.body;
    return { models, providers, rendered: body
      .replace('__MC_PERMITTED_MODELS__', JSON.stringify(models))
      .replace('__MC_PERMITTED_PROVIDERS__', JSON.stringify(providers)) };
  };

  it('offers claude models, and no other stack\'s, when claude is the set', () => {
    const { models, rendered } = render('claude');
    expect(models.length, 'no models resolved — the assertions below would be vacuous').toBeGreaterThan(1);
    expect(rendered).toContain(models[0]);
    expect(rendered, 'the claude prompt still offers another stack\'s model')
      .not.toMatch(/MiniMax|glm-5/);
    expect(rendered, 'a declared placeholder went unsupplied and renders as its own name')
      .not.toContain('__MC_PERMITTED_');
  });

  it('offers a different vocabulary on a different stack — the template is stack-neutral', () => {
    const claude = render('claude').rendered;
    const codemie = render('codemie').rendered;
    expect(claude, 'both stacks rendered the same permitted set, so the values are not being read '
      + 'from the resolved set at all').not.toEqual(codemie);
  });

  it('names a provider the stack can actually route', () => {
    const { providers, rendered } = render('claude');
    expect(providers).toContain('claude');
    expect(rendered).toContain('claude');
  });
});
