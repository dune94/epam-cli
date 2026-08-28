/**
 * A MOCKED RUN THAT CAN REACH A PAID PROVIDER IS WORSE THAN NO MOCK.
 *
 * It looks free. Every log line says mock. The bill says otherwise, and nobody looks for a bill
 * after a rehearsal.
 *
 * This nearly shipped: the mockserver set was built by COPYING the codemie one, and the paid
 * wrapper came with it in two places —
 *   EPAM_MODEL_PROVIDER_MAP="claude-*=codemie-claude"
 *   finalFallback.provider   = "codemie-claude"
 * The fallback is the worse of the two: it is reached only when everything else has failed,
 * which is exactly where an escape is least noticed and most expensive.
 *
 * All three API keys are present in .env, so a stray call would have SUCCEEDED rather than
 * failed loudly.
 *
 * Asserted against VALUES, never prose: the settings file explains in its own comments WHY it
 * avoids codemie-claude, and a naive grep flags that explanation as the defect.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const CFG = join(ROOT, 'orchestrations/config');
const REG = JSON.parse(readFileSync(join(CFG, 'provider-sets.json'), 'utf8'));
const SET = 'mockserver';
const suffix = REG.sets[SET]?.projectEnvSuffix;
const settings = JSON.parse(readFileSync(join(CFG, REG.sets[SET].settingsFile), 'utf8'));

/** Providers that cost money — derived from the OTHER sets, never hand-listed. */
function paidProviders(): string[] {
  const out = new Set<string>();
  for (const [name, cfg] of Object.entries<any>(REG.sets)) {
    if (name === SET) continue;
    const f = join(CFG, cfg.settingsFile);
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      if (j.finalFallback?.provider) out.add(j.finalFallback.provider);
      Object.keys(j.runners || {}).forEach((r) => out.add(r));
    }
  }
  out.delete('claude');   // plain Claude Code is what the mock redirects
  return [...out];
}

describe('the mockserver set cannot reach a paid provider', () => {
  it('there ARE paid providers to check against — otherwise this passes vacuously', () => {
    expect(paidProviders().length).toBeGreaterThan(0);
  });

  it('the post-exhaustion fallback names no paid provider', () => {
    // The fallback is reached when everything else failed — the least-watched call in a run.
    expect(paidProviders()).not.toContain(settings.finalFallback?.provider);
  });

  it('its runner is not a paid one', () => {
    for (const r of Object.keys(settings.runners || {})) {
      expect(paidProviders(), `runner '${r}' costs money`).not.toContain(r);
    }
  });

  for (const p of readdirSync(join(ROOT, 'orchestrations/projects'))) {
    const f = join(ROOT, 'orchestrations/projects', p, `config.${suffix}.env`);
    if (!existsSync(f)) continue;
    it(`${p}: its overlay routes no model to a paid provider`, () => {
      // VALUES only. The settings file explains in prose why it avoids the paid wrapper;
      // grepping the whole text flags that explanation as the defect.
      const assignments = readFileSync(f, 'utf8').split('\n')
        .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
        .map((l) => l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, ''));
      const offenders = assignments.filter((v) => paidProviders().some((paid) => v.includes(paid)));
      expect(offenders, `${p} would spend money on a "mocked" run`).toEqual([]);
    });
  }
});
