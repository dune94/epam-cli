/**
 * AN AGENT THAT DOES NOT EXIST YET STILL NEEDS A SEAM.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * agents/invocation-profiles.json names 17 seams by hand. A run MINTS 64 agents whose names
 * are generated per project and per codeline — gotransit-investigator, upexpress-investigator,
 * contentstack-live-preview-integration-engineer — none of which can possibly appear in a file
 * written before the project existed.
 *
 * seamInvocationEnv returns {} for every one of them, silently, and its own docstring calls
 * that intentional: "A seam with no entry gets {} and runs on whatever the run already
 * provides." So a minted agent has no ladder, no declared effort, no temperature — and nothing
 * says so. Discovering it later and calling it a bug is not a design.
 *
 * Operator, 2026-08-12: "for minted agents — how will this work — they will need seam to enter
 * the pipeline and ladder will have to work with no hard coding — you cannot just say after
 * mint - oh, it has no seam and then treat it as a bug - that will not work at all and is a
 * poor design."
 *
 * SO RESOLUTION IS TOTAL. Every agent name resolves to a seam, by DECLARED PATTERN rather than
 * by being individually listed, and an unresolvable name is a HARD FAILURE — never {}.
 *
 * The patterns live in the REGISTRY, which is configuration. No agent name, seam name or
 * pattern appears in the engine: a new agent kind is a registry edit, exactly like a new
 * ladder is a project edit.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SEAM_JS = join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function load() {
  delete require.cache[require.resolve(SEAM_JS)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  return require(SEAM_JS);
}

/** A registry fixture, so these assertions test the MECHANISM, not the shipped data. */
function registry(doc: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'seamreg-')); dirs.push(d);
  writeFileSync(join(d, 'invocation-profiles.json'), JSON.stringify(doc, null, 2));
  return join(d, 'invocation-profiles.json');
}

const withPatterns = {
  seamPatterns: [
    { match: '-investigator$', seam: 'code-graph-detective' },
    { match: '-engineer$', seam: 'impl-failure-analyst' },
  ],
  defaultSeam: 'cpa-inference',
  profiles: {
    'code-graph-detective': { ladder: 'high', reasoningEffort: 'high' },
    'impl-failure-analyst': { ladder: 'high', temperature: '0.7' },
    'cpa-inference': { ladder: 'medium' },
    'team-lead-review': { ladder: 'highest' },
  },
};

const env = { EPAM_MODEL_LADDER_HIGH: 'a=b|b=c', EPAM_MODEL_LADDER_MEDIUM: 'm=n' };

describe('the shipped registry can never name a minted agent', () => {
  it('it lists far fewer profiles than a run mints', () => {
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    expect(Object.keys(reg.profiles).length).toBeLessThan(30);
    // The 2026-08-11 run minted 64.
  });
});

describe('RESOLUTION IS TOTAL — a minted name still gets a seam', () => {
  it('a per-codeline investigator resolves by pattern', () => {
    const { resolveSeam } = load();
    expect(resolveSeam('gotransit-investigator', registry(withPatterns))).toBe('code-graph-detective');
  });

  it('a differently-named codeline resolves the same way — no name is enumerated', () => {
    const { resolveSeam } = load();
    for (const n of ['upexpress-investigator', 'metrolinx-investigator', 'anything-at-all-investigator']) {
      expect(resolveSeam(n, registry(withPatterns))).toBe('code-graph-detective');
    }
  });

  it('a minted role agent resolves by its own pattern', () => {
    const { resolveSeam } = load();
    expect(resolveSeam('contentstack-live-preview-integration-engineer', registry(withPatterns)))
      .toBe('impl-failure-analyst');
  });

  it('an exact profile name still wins over any pattern', () => {
    const { resolveSeam } = load();
    expect(resolveSeam('team-lead-review', registry(withPatterns))).toBe('team-lead-review');
  });

  it('an unmatched name falls to the DECLARED default', () => {
    const { resolveSeam } = load();
    expect(resolveSeam('something-nobody-anticipated', registry(withPatterns))).toBe('cpa-inference');
  });
});

describe('A MINTED AGENT GETS A REAL LADDER, NOT AN EMPTY OBJECT', () => {
  it('THE DEFECT: it no longer returns {}', () => {
    const { seamInvocationEnv } = load();
    const out = seamInvocationEnv('gotransit-investigator', null, { registryFile: registry(withPatterns), env });
    expect(out, 'a minted agent still gets nothing').not.toEqual({});
  });

  it('it gets the model and ladder of the seam it resolved to', () => {
    const { seamInvocationEnv } = load();
    const out = seamInvocationEnv('gotransit-investigator', null, { registryFile: registry(withPatterns), env });
    expect(out.EPAM_MODEL).toBe('a');
    expect(out.EPAM_MODEL_LADDER).toBe('a=b|b=c');
  });

  it('and the seam\'s declared effort', () => {
    const { seamInvocationEnv } = load();
    const out = seamInvocationEnv('gotransit-investigator', null, { registryFile: registry(withPatterns), env });
    expect(out.EPAM_REASONING_EFFORT).toBe('high');
  });
});

describe('AN UNRESOLVABLE SEAM IS A HARD FAILURE, NEVER SILENCE', () => {
  it('a registry with no patterns AND no default throws', () => {
    // Silence here is what made "it has no seam" discoverable only as a later bug.
    const { resolveSeam } = load();
    const bare = registry({ profiles: { 'team-lead-review': { ladder: 'highest' } } });
    expect(() => resolveSeam('some-minted-agent', bare)).toThrow(/seam/i);
  });

  it('the error names the agent that could not be resolved', () => {
    const { resolveSeam } = load();
    const bare = registry({ profiles: {} });
    expect(() => resolveSeam('gotransit-investigator', bare)).toThrow(/gotransit-investigator/);
  });

  it('a default naming a profile that does not exist throws', () => {
    const { resolveSeam } = load();
    const broken = registry({ defaultSeam: 'ghost', profiles: { a: { ladder: 'high' } } });
    expect(() => resolveSeam('x', broken)).toThrow(/ghost/);
  });

  it('a pattern naming a profile that does not exist throws', () => {
    const { resolveSeam } = load();
    const broken = registry({
      seamPatterns: [{ match: '-investigator$', seam: 'ghost' }],
      profiles: { a: { ladder: 'high' } },
    });
    expect(() => resolveSeam('x-investigator', broken)).toThrow(/ghost/);
  });
});

describe('NO AGENT OR SEAM NAME IS COMPILED INTO THE ENGINE', () => {
  it('seam-invocation.js names no agent, seam or pattern', () => {
    const src = readFileSync(SEAM_JS, 'utf8')
      .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    for (const leak of ['investigator', 'engineer', 'code-graph-detective', 'team-lead-review',
      'cpa-inference', 'contentstack']) {
      expect(src, `'${leak}' belongs in the registry, not the engine`).not.toContain(leak);
    }
  });

  it('the SHIPPED registry declares patterns and a default, so real minted agents resolve', () => {
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    expect(Array.isArray(reg.seamPatterns), 'no seamPatterns declared — minted agents cannot resolve').toBe(true);
    expect(reg.seamPatterns.length).toBeGreaterThan(0);
    expect(reg.defaultSeam, 'no defaultSeam declared').toBeTruthy();
    expect(reg.profiles[reg.defaultSeam], 'defaultSeam names a profile that does not exist').toBeTruthy();
    for (const p of reg.seamPatterns) {
      expect(reg.profiles[p.seam], `pattern '${p.match}' names missing profile '${p.seam}'`).toBeTruthy();
    }
  });

  it('every real minted agent name from the live roster resolves', () => {
    const { resolveSeam } = load();
    const roster = JSON.parse(readFileSync(
      join(ROOT, 'orchestrations/projects/metrolinx/runs/20260809T045158Z/lanes/gotransit/checkpoint/profiles.json'),
      'utf8'));
    const names = Object.keys(roster);
    expect(names.length).toBeGreaterThan(20);
    for (const n of names) {
      expect(() => resolveSeam(n, REGISTRY), `minted agent '${n}' resolves to no seam`).not.toThrow();
    }
  });
});
