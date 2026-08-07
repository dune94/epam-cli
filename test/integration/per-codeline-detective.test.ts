/**
 * EACH CODELINE INVESTIGATES ITSELF.
 *
 * The roster mints one investigator per codeline, briefed on that repository — its layout,
 * its conventions, the dependencies that matter in it. A lane uses its own; the canonical
 * code-graph-detective is the fallback for a codeline that has none.
 *
 * Looked up BY CODELINE, never by position or order. Two lanes running the same story must
 * not be able to pick up each other's investigator: a detective briefed on another repository
 * reports findings about files that may not exist here, and those findings become the writer's
 * declared files and the input to the deterministic fix-site coverage gate. That is the
 * contamination the per-codeline split exists to prevent, and it is silent in both directions
 * — a phantom file gets a reviewer to reject correct work, and a coverage check passes on
 * another repo's evidence.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roster = require('../../orchestrations/scripts/lib/agent-roster.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let prev: string | undefined;
beforeEach(() => { prev = process.env.EPAM_PROJECT_CONFIG_DIR; delete process.env.EPAM_PROJECT_CONFIG_DIR; });
afterAll(() => { if (prev !== undefined) process.env.EPAM_PROJECT_CONFIG_DIR = prev; });

const PROPOSALS = [
  { name: 'an-engineer', kind: 'implementer', systemPrompt: 'owns src/. '.repeat(20), rationale: 'r' },
  { name: 'alpha-detective', kind: 'investigator', codeline: 'alpha', systemPrompt: 'knows alpha. '.repeat(20), rationale: 'r' },
  { name: 'beta-detective', kind: 'investigator', codeline: 'beta', systemPrompt: 'knows beta. '.repeat(20), rationale: 'r' },
];

function ws() {
  const dir = mkdtempSync(join(tmpdir(), 'perdet-')); dirs.push(dir);
  const profilesPath = join(dir, 'profiles.json');
  writeFileSync(profilesPath, JSON.stringify({ 'code-graph-detective': 'the canonical one' }, null, 2));
  roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: PROPOSALS });
  return { dir, profilesPath };
}

describe('an investigator is bound to one codeline', () => {
  it('each codeline resolves to its OWN detective', () => {
    const { dir } = ws();
    expect(roster.investigatorForCodeline(dir, 'alpha')).toBe('alpha-detective');
    expect(roster.investigatorForCodeline(dir, 'beta')).toBe('beta-detective');
  });

  it('THE CONTAMINATION GUARD: one codeline never resolves to another\'s detective', () => {
    const { dir } = ws();
    expect(
      roster.investigatorForCodeline(dir, 'alpha'),
      'a lane picked up another repository\'s investigator',
    ).not.toBe('beta-detective');
    expect(roster.investigatorForCodeline(dir, 'beta')).not.toBe('alpha-detective');
  });

  it('a codeline with no investigator resolves to nothing — the caller falls back', () => {
    const { dir } = ws();
    expect(
      roster.investigatorForCodeline(dir, 'gamma'),
      'an unminted codeline was handed some other codeline\'s detective',
    ).toBe('');
  });

  it('an empty or missing codeline name resolves to nothing', () => {
    const { dir } = ws();
    expect(roster.investigatorForCodeline(dir, '')).toBe('');
    expect(roster.investigatorForCodeline(dir, undefined)).toBe('');
  });
});

describe('investigators stay out of the write path', () => {
  it('neither detective is offered as an implementer', () => {
    const { dir } = ws();
    expect(roster.projectRoles(dir)).toEqual(['an-engineer']);
    expect(roster.projectInvestigators(dir).sort()).toEqual(['alpha-detective', 'beta-detective']);
  });

  it('each detective still gets a brief it can work from', () => {
    const { dir, profilesPath } = ws();
    const profiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
    expect(profiles['alpha-detective']).toMatch(/knows alpha/);
    expect(profiles['beta-detective']).toMatch(/knows beta/);
  });

  it('the canonical detective is untouched — it remains the fallback', () => {
    const { dir, profilesPath } = ws();
    expect(JSON.parse(readFileSync(profilesPath, 'utf8'))['code-graph-detective']).toBe('the canonical one');
  });
});

describe('the codeline mapping survives a re-read', () => {
  it('it is persisted, not held in memory', () => {
    const { dir } = ws();
    const raw = JSON.parse(readFileSync(roster.projectInvestigatorsPath(dir), 'utf8'));
    expect(raw.byCodeline).toEqual({ alpha: 'alpha-detective', beta: 'beta-detective' });
  });

  it('clearing removes the mapping too', () => {
    const { dir, profilesPath } = ws();
    roster.clearProjectRoster(dir, profilesPath);
    expect(roster.investigatorForCodeline(dir, 'alpha')).toBe('');
  });
});

/**
 * AN INVESTIGATOR WITHOUT A CODELINE IS UNREACHABLE, AND MUST BE REFUSED.
 *
 * The lane resolves its investigator BY CODELINE. One minted without that field is registered,
 * briefed, given a KB — and bound to nothing: every lane falls through to the canonical
 * detective and the per-codeline briefs never run.
 *
 * Live 2026-08-07: one run supplied the field, the next did not, and the whole mechanism
 * silently stopped working between two runs of IDENTICAL code. The schema marks codeline
 * optional because JSON Schema cannot make it conditional on kind — which makes refusing it
 * the merge's job, not the model's.
 */
describe('an investigator must name its codeline', () => {
  function ws2() {
    const dir = mkdtempSync(join(tmpdir(), 'unbound-')); dirs.push(dir);
    const profilesPath = join(dir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({ 'code-graph-detective': 'canonical' }, null, 2));
    return { dir, profilesPath };
  }
  const brief = 'reads and reports. '.repeat(20);

  it('THE REGRESSION: one with no codeline is rejected, not registered', () => {
    const { dir, profilesPath } = ws2();
    const res = roster.mergeProjectAgents({
      profilesPath, agentsDir: dir,
      proposals: [{ name: 'an-investigator', kind: 'investigator', systemPrompt: brief, rationale: 'r' }],
    });
    expect(res.minted, 'an unbound investigator was minted — no lane can ever reach it').toHaveLength(0);
    expect(res.rejected[0].reason).toMatch(/must name the one codeline/i);
    expect(roster.projectInvestigators(dir)).toEqual([]);
  });

  it('an empty or whitespace codeline is refused too', () => {
    const { dir, profilesPath } = ws2();
    const res = roster.mergeProjectAgents({
      profilesPath, agentsDir: dir,
      proposals: [
        { name: 'blank-one', kind: 'investigator', codeline: '', systemPrompt: brief, rationale: 'r' },
        { name: 'spaces-one', kind: 'investigator', codeline: '   ', systemPrompt: brief, rationale: 'r' },
      ],
    });
    expect(res.minted).toHaveLength(0);
    expect(res.rejected).toHaveLength(2);
  });

  it('an IMPLEMENTER needs no codeline — it spans the project', () => {
    const { dir, profilesPath } = ws2();
    const res = roster.mergeProjectAgents({
      profilesPath, agentsDir: dir,
      proposals: [{ name: 'an-engineer', kind: 'implementer', systemPrompt: brief, rationale: 'r' }],
    });
    expect(res.minted).toHaveLength(1);
    expect(roster.projectRoles(dir)).toEqual(['an-engineer']);
  });

  it('a bound investigator still mints and still resolves', () => {
    const { dir, profilesPath } = ws2();
    roster.mergeProjectAgents({
      profilesPath, agentsDir: dir,
      proposals: [{ name: 'alpha-inv', kind: 'investigator', codeline: 'alpha', systemPrompt: brief, rationale: 'r' }],
    });
    expect(roster.investigatorForCodeline(dir, 'alpha')).toBe('alpha-inv');
  });
});
