/**
 * A GATE THE ENGINE CALLS MUST HAVE SOMEONE TO CALL.
 *
 * runtime-boundary-review is wired end to end — the seam is linked (qa-gate:runtime-boundary), the
 * prompt is provisioned per project, the adapter resolves the codeline's configuration surface — and
 * the roster carries no `runtime-boundary` persona at all. So the gate refused on every run:
 *
 *   [runtime-boundary] cannot render its prompt — refusing to gate with no instructions
 *
 * It refused SAFELY, which is why it went unnoticed: a gate that declines is quiet, and the run is
 * reported green around it. The gate exists to catch the class no other gate covers — code that is
 * correct, tested, secure and still cannot execute as the codeline is configured — so its silence
 * removed exactly the check that three full brownfield implementations had already failed.
 *
 * This is the scanner, not the site: every persona key the engine looks up must exist in every
 * roster SOURCE, so the next gate wired without a brief fails here rather than in silence.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const SOURCES = [
  'orchestrations/agents/profiles.canonical.json',
  'orchestrations/agents/profiles.json.original',
].map((p) => join(ROOT, p));

/**
 * Every persona key the engine reads out of a profiles file.
 *
 * Matched in-process rather than through a shell grep: escaping this pattern across JS, the shell
 * and ERE silently matched NOTHING on the first attempt, and a scanner that finds nothing reports a
 * clean sweep. The vacuity check below is what caught it.
 */
function personaKeysTheEngineExpects(): string[] {
  const keys = new Set<string>();
  for (const dir of ['orchestrations/scripts', 'orchestrations/scripts/lib']) {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (!f.endsWith('.sh')) continue;
      const text = readFileSync(join(ROOT, dir, f), 'utf8');
      // the shape every caller uses to pull a brief: jq -r '.["<persona>"]' over a profiles file
      for (const m of text.matchAll(/\.\[\s*"([a-z0-9-]+)"\s*\]/g)) {
        const near = text.slice(Math.max(0, (m.index ?? 0) - 200), (m.index ?? 0) + 200);
        if (/profile/i.test(near)) keys.add(m[1]);
      }
    }
  }
  return [...keys];
}

describe('EVERY PERSONA THE ENGINE EXPECTS EXISTS', () => {
  it('finds persona lookups to check — otherwise this passes vacuously', () => {
    expect(personaKeysTheEngineExpects().length).toBeGreaterThan(5);
  });

  for (const src of SOURCES) {
    it(`${src.split('/').pop()} carries every persona the engine looks up`, () => {
      if (!existsSync(src)) return;
      const roster = JSON.parse(readFileSync(src, 'utf8'));
      const missing = personaKeysTheEngineExpects().filter((k) => !(k in roster));
      expect(missing, 'the engine calls a gate that has no brief — it will refuse to run, quietly, '
        + 'and the run will be reported green around the check that never happened').toEqual([]);
    });
  }
});

describe('THE RUNTIME-BOUNDARY PERSONA SAYS WHAT ITS GATE IS FOR', () => {
  const persona = () => {
    const roster = JSON.parse(readFileSync(SOURCES[0], 'utf8'));
    const p = roster['runtime-boundary'];
    return typeof p === 'string' ? p : JSON.stringify(p ?? '');
  };

  it('is about execution, not style, coverage or vulnerabilities', () => {
    expect(persona()).toMatch(/execut|run/i);
  });

  it('names no framework, stack or vendor — the codeline is discovered, never assumed', () => {
    // A persona that names a framework is right on one codeline and wrong on every other, exactly
    // as the prd-model-coordinator persona was for models.
    const named = ['react', 'next.js', 'nextjs', 'angular', 'vue', 'django', 'spring', 'rails',
      'node.js', 'webpack', 'vite'].filter((f) => new RegExp(f, 'i').test(persona()));
    expect(named, 'the gate must read the project\'s own configuration, not recognise a stack by name')
      .toEqual([]);
  });

  it('tells the reviewer to report nothing rather than invent a finding', () => {
    expect(persona()).toMatch(/no finding|nothing|never invent|do not invent/i);
  });
});
