/**
 * THE CROSS-REFERENCE IS WRITTEN WHEN THE AGENTS ARE MINTED, NOT DISCOVERED LATER.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * Minting is the only moment the pipeline knows what it just created. If the agent→seam
 * cross-reference is not produced there, the alternative is discovering at runtime that an
 * agent has no seam — which the operator ruled out directly:
 *
 *   "you cannot just say after mint - oh, it has no seam and then treat it as a bug - that
 *    will not work at all and is a poor design."
 *
 *   "Cross reference must be updated/re-created during minting."
 *
 * So minting resolves every agent in the roster through the SAME total resolver the runtime
 * uses, and records the result in the registry. Two consequences, both deliberate:
 *
 *   - The mapping becomes EXPLICIT and auditable. A pattern is how an agent resolves the first
 *     time; the cross-reference is the record of what it resolved TO, which an operator can
 *     read, diff and override.
 *   - An agent that resolves to nothing FAILS THE MINT. The failure lands where it can be
 *     fixed — before any story runs — instead of three hours into a run as an agent quietly
 *     running unconfigured.
 *
 * The engine names no agent and no seam. Minting reads the roster it produced and the registry
 * declares the shapes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const MINT = join(ROOT, 'orchestrations/scripts/mint-agents-step.js');
const SEAM_JS = join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fixture(roster: Record<string, string>, registry: unknown) {
  const d = mkdtempSync(join(tmpdir(), 'mintxref-')); dirs.push(d);
  writeFileSync(join(d, 'profiles.json'), JSON.stringify(roster, null, 2));
  writeFileSync(join(d, 'invocation-profiles.json'), JSON.stringify(registry, null, 2));
  return { dir: d, roster: join(d, 'profiles.json'), registry: join(d, 'invocation-profiles.json') };
}

/** Call the exported cross-reference writer directly — the unit, not a whole mint run. */
function writeXref(rosterPath: string, registryPath: string) {
  const r = spawnSync(process.execPath, ['-e', `
    const m = require(${JSON.stringify(MINT)});
    if (typeof m.writeAgentSeamCrossReference !== 'function') {
      process.stderr.write('NOT_EXPORTED'); process.exit(3);
    }
    m.writeAgentSeamCrossReference(${JSON.stringify(rosterPath)}, ${JSON.stringify(registryPath)});
  `], { encoding: 'utf8' });
  return r;
}

const REGISTRY = {
  seamPatterns: [
    { match: '-investigator$', seam: 'code-graph-detective' },
    { match: '-engineer$', seam: 'impl-failure-analyst' },
  ],
  defaultSeam: 'cpa-inference',
  profiles: {
    'code-graph-detective': { ladder: 'high' },
    'impl-failure-analyst': { ladder: 'high' },
    'cpa-inference': { ladder: 'medium' },
  },
};

describe('the writer is exported so minting can call it', () => {
  it('mint-agents-step.js exports writeAgentSeamCrossReference', () => {
    const r = writeXref('/nonexistent', '/nonexistent');
    expect(r.stderr, 'the cross-reference writer does not exist yet').not.toContain('NOT_EXPORTED');
  });
});

describe('EVERY MINTED AGENT IS RECORDED AGAINST THE SEAM IT ENTERS BY', () => {
  it('writes an entry for each agent in the roster', () => {
    const f = fixture(
      { 'gotransit-investigator': 'brief', 'typescript-engineer': 'brief', 'odd-name': 'brief' },
      REGISTRY);
    const r = writeXref(f.roster, f.registry);
    expect(r.status, r.stderr).toBe(0);
    const reg = JSON.parse(readFileSync(f.registry, 'utf8'));
    expect(reg.agentSeams['gotransit-investigator']).toBe('code-graph-detective');
    expect(reg.agentSeams['typescript-engineer']).toBe('impl-failure-analyst');
    expect(reg.agentSeams['odd-name']).toBe('cpa-inference');
  });

  it('an agent that is itself a seam is not rewritten into the cross-reference', () => {
    // profiles[<agent>] already wins at resolution; duplicating it adds a second place to
    // drift from.
    const f = fixture({ 'cpa-inference': 'brief' }, REGISTRY);
    writeXref(f.roster, f.registry);
    const reg = JSON.parse(readFileSync(f.registry, 'utf8'));
    expect(reg.agentSeams['cpa-inference']).toBeUndefined();
  });

  it('RE-CREATED each mint — an agent no longer in the roster is dropped', () => {
    const f = fixture({ 'a-investigator': 'brief' }, {
      ...REGISTRY,
      agentSeams: { 'gone-investigator': 'code-graph-detective' },
    });
    writeXref(f.roster, f.registry);
    const reg = JSON.parse(readFileSync(f.registry, 'utf8'));
    expect(reg.agentSeams['a-investigator']).toBe('code-graph-detective');
    expect(reg.agentSeams['gone-investigator'], 'a stale agent survived the re-mint').toBeUndefined();
  });

  it('an operator override for a still-present agent is preserved', () => {
    // The cross-reference is regenerated, but a deliberate decision about an agent that still
    // exists is not something a re-mint should silently revert.
    const f = fixture({ 'x-investigator': 'brief' }, {
      ...REGISTRY,
      agentSeams: { 'x-investigator': 'cpa-inference' },
    });
    writeXref(f.roster, f.registry);
    const reg = JSON.parse(readFileSync(f.registry, 'utf8'));
    expect(reg.agentSeams['x-investigator'], 'an explicit override was overwritten by a pattern')
      .toBe('cpa-inference');
  });
});

describe('AN AGENT THAT RESOLVES TO NOTHING FAILS THE MINT', () => {
  it('exits non-zero when the registry can resolve no seam', () => {
    const f = fixture({ 'unmappable-thing': 'brief' }, {
      profiles: { 'code-graph-detective': { ladder: 'high' } },   // no patterns, no default
    });
    const r = writeXref(f.roster, f.registry);
    expect(r.status, 'minting succeeded while leaving an agent unconfigured').not.toBe(0);
  });

  it('the error names the agent, so it can be fixed before any story runs', () => {
    const f = fixture({ 'unmappable-thing': 'brief' }, { profiles: {} });
    expect(writeXref(f.roster, f.registry).stderr).toContain('unmappable-thing');
  });

  it('the registry is NOT written when resolution fails', () => {
    const before = { profiles: {} };
    const f = fixture({ 'unmappable-thing': 'brief' }, before);
    writeXref(f.roster, f.registry);
    expect(JSON.parse(readFileSync(f.registry, 'utf8')),
      'a partial cross-reference was left behind').toEqual(before);
  });
});

describe('IT USES THE SAME RESOLVER THE RUNTIME USES', () => {
  it('mint-agents-step.js imports the shared resolver rather than reimplementing it', () => {
    // Two implementations of "which seam is this agent" is two answers to the same question.
    const src = readFileSync(MINT, 'utf8');
    expect(src).toMatch(/seam-invocation/);
    expect(src).toMatch(/resolveSeam/);
  });

  it('the cross-reference writer names no agent and no seam', () => {
    // Scoped to this function deliberately. writeRosterDiff — pre-existing, and NOT part of
    // this change — classifies agents with kindOf(k) === 'investigator' to group its markdown
    // report, so a whole-file assertion fails on code this test is not about. That literal is
    // a real hardcoding of an agent kind in the engine and is recorded as its own item; it is
    // not silently swept into a change about seam resolution.
    const src = readFileSync(MINT, 'utf8');
    const start = src.indexOf('function writeAgentSeamCrossReference');
    expect(start, 'the writer is gone — the test is stale').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\nmodule.exports', start))
      .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    for (const leak of ['investigator', 'engineer', 'code-graph-detective', 'cpa-inference']) {
      expect(body, `'${leak}' belongs in the registry, not the mint step`).not.toContain(leak);
    }
  });

  it('the shared resolver is what decides — proven by agreement', () => {
    const f = fixture({ 'q-investigator': 'brief' }, REGISTRY);
    writeXref(f.roster, f.registry);
    const written = JSON.parse(readFileSync(f.registry, 'utf8')).agentSeams['q-investigator'];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { resolveSeam } = require(SEAM_JS);
    expect(written).toBe(resolveSeam('q-investigator', f.registry));
  });
});
