/**
 * TWO MITIGATIONS FOR A REVIEWER THAT CAN BE CONFIDENTLY WRONG.
 *
 * Live 2026-08-07: the roster reviewer reported, with a plausible account of what it had
 * checked, that a codeline did not declare a testing package. The package was in that
 * codeline's devDependencies and installed on disk. Nothing in the pipeline noticed.
 *
 * Retries do not help — a careless read reproduces on every attempt, and the ladder never
 * fires because nothing looks like an error. A stronger model helps at the margin but
 * guarantees nothing. So:
 *
 *  1. A NAMED LADDER, bound to seams whose judgement everything downstream rests on. Which
 *     seam climbs which ladder is data in the registry; which models a ladder contains is the
 *     project's own config. No seam, ladder or model name appears in engine code.
 *  2. DETERMINISTIC RE-CHECKING of the reviewer's own structured findings. A claim about
 *     whether a named thing is present is settleable; the reviewer states it in a structured
 *     field and the pipeline re-runs exactly that check, discarding what the repository
 *     refutes. Judgements it cannot settle are kept untouched.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { verifyFindings } = require('../../../orchestrations/scripts/lib/verify-findings.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function estate(deps: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-')); dirs.push(dir);
  mkdirSync(join(dir, '.epam'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: deps }));
  writeFileSync(join(dir, '.epam', 'dependency-check.json'), JSON.stringify({
    manifestFile: 'package.json', manifestKeys: ['dependencies', 'devDependencies'],
  }));
  return dir;
}

const finding = (subject: string, expected: string, kind = 'dependency_declared') => ({
  agent: 'an-engineer', severity: 'blocking', claim: 'c', checked: 'k', found: 'f',
  verification: { kind, codeline: 'alpha', subject, expected },
});

describe('a refuted finding is discarded', () => {
  it('THE LIVE FALSE POSITIVE: claiming absent what the manifest declares', () => {
    const dir = estate({ 'a-testing-package': '^1.0.0' });
    const r = verifyFindings([finding('a-testing-package', 'absent')], [{ name: 'alpha', path: dir }]);
    expect(r.kept, 'a false claim survived and would have cost a correction cycle').toHaveLength(0);
    expect(r.refuted).toHaveLength(1);
    expect(r.refuted[0]._refutedBy).toMatch(/is present in alpha/);
  });

  it('a TRUE absence is kept, and marked verified', () => {
    const dir = estate({ 'something-else': '^1.0.0' });
    const r = verifyFindings([finding('a-missing-package', 'absent')], [{ name: 'alpha', path: dir }]);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]._verified, 'a confirmed finding is not marked as independently checked').toBe(true);
    expect(r.refuted).toHaveLength(0);
  });

  it('a claim of presence is checked the same way, in both directions', () => {
    const dir = estate({ 'a-package': '^1.0.0' });
    expect(verifyFindings([finding('a-package', 'present')], [{ name: 'alpha', path: dir }]).kept).toHaveLength(1);
    expect(verifyFindings([finding('nope', 'present')], [{ name: 'alpha', path: dir }]).refuted).toHaveLength(1);
  });
});

describe('judgements are never discarded', () => {
  it('a finding with no verification field is kept untouched', () => {
    const dir = estate({});
    const r = verifyFindings([{ agent: 'a', severity: 'blocking', claim: 'two roles own the same files' }],
      [{ name: 'alpha', path: dir }]);
    expect(r.kept).toHaveLength(1);
    expect(r.refuted).toHaveLength(0);
  });

  it('one declared not mechanically checkable is kept', () => {
    const dir = estate({});
    const r = verifyFindings([finding('', 'absent', 'not_mechanically_checkable')], [{ name: 'alpha', path: dir }]);
    expect(r.kept).toHaveLength(1);
  });

  it('a check that cannot run keeps the finding and flags it unsettled', () => {
    const r = verifyFindings([finding('x', 'absent')], [{ name: 'other', path: '/nonexistent' }]);
    expect(r.kept, 'a finding was dropped because the check could not run').toHaveLength(1);
    expect(r.unsettled).toHaveLength(1);
  });

  it('with no manifest config nothing is refuted — the engine does not guess', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nocfg-')); dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { x: '1' } }));
    const r = verifyFindings([finding('x', 'absent')], [{ name: 'alpha', path: dir }]);
    expect(r.refuted).toHaveLength(0);
    expect(r.unsettled).toHaveLength(1);
  });
});

describe('a path finding cannot read outside its codeline', () => {
  it('an escaping subject is not resolved', () => {
    const dir = estate({});
    const r = verifyFindings([finding('../../etc', 'present', 'path_exists')], [{ name: 'alpha', path: dir }]);
    expect(r.refuted, 'a finding sent the check outside the repository').toHaveLength(0);
    expect(r.unsettled).toHaveLength(1);
  });
});

describe('the ladder binds by configuration, not by code', () => {
  const REG = join(__dirname, '../../../orchestrations/agents/invocation-profiles.json');

  it('a seam with a ladder resolves models from the project config', () => {
    process.env.AGENT_PROFILES_REGISTRY = REG;
    process.env.EPAM_MODEL_LADDER_HIGHEST = 'model-a=model-b';
    const env = spec.seamInvocationEnv('roster-review', 'orchestrations/logs');
    // The chain is exported under the GENERIC name every consumer reads. It used to also be
    // written to EPAM_MODEL_LADDER_HIGH — from a HIGHEST-tier ladder — which was a mis-named
    // export that could have handed a seam the wrong tier's chain.
    expect(env.EPAM_MODEL_LADDER).toBe('model-a=model-b');
    expect(env.EPAM_MODEL, 'the seam does not START on the first rung').toBe('model-a');
    expect(env.EPAM_REASONING_EFFORT).toBe('high');
  });

  it('the reviewer runs at LOW temperature — falsification wants determinism', () => {
    process.env.AGENT_PROFILES_REGISTRY = REG;
    const env = spec.seamInvocationEnv('roster-review', 'orchestrations/logs');
    expect(Number(env.EPAM_TEMPERATURE)).toBeLessThan(0.5);
  });

  it('the detective runs hotter — investigation benefits from more than one hypothesis', () => {
    process.env.AGENT_PROFILES_REGISTRY = REG;
    const env = spec.seamInvocationEnv('code-graph-detective', 'orchestrations/logs');
    expect(Number(env.EPAM_TEMPERATURE)).toBeGreaterThan(0.5);
  });

  it('a seam with no ladder is untouched — nothing is bound implicitly', () => {
    process.env.AGENT_PROFILES_REGISTRY = REG;
    const env = spec.seamInvocationEnv('tc-writer', 'orchestrations/logs');
    expect(env.EPAM_MODEL_LADDER).toBeUndefined();
    expect(env.EPAM_MODEL).toBeUndefined();
  });

  it('every seam whose failure is SILENT climbs it — reviewer, detective, verdict, scope, guard', () => {
    process.env.AGENT_PROFILES_REGISTRY = REG;
    process.env.EPAM_MODEL_LADDER_HIGHEST = 'model-a=model-b';
    // Each of these makes a judgement nothing downstream re-checks: the roster reviewer, the
    // detective's fix site, the team lead's verdict, which codelines are in scope at all, and
    // the vocabulary the VC guard enforces. A weak answer from any of them is not an error —
    // it is a wrong answer that reads as a right one.
    for (const seam of ['roster-review', 'code-graph-detective', 'team-lead-review',
                        'codeline-discovery', 'guard-vocabulary']) {
      const env = spec.seamInvocationEnv(seam, 'orchestrations/logs');
      expect(env.EPAM_MODEL_LADDER, `${seam} is not on the configured ladder`).toBe('model-a=model-b');
      expect(env.EPAM_REASONING_EFFORT, `${seam} is not at high effort`).toBe('high');
    }
  });

  it('seams that PRODUCE rather than judge are left alone — their output is reviewed', () => {
    process.env.AGENT_PROFILES_REGISTRY = REG;
    for (const seam of ['tc-writer', 'ac-elaboration', 'prd-change-summarizer']) {
      expect(spec.seamInvocationEnv(seam, 'orchestrations/logs').EPAM_MODEL_LADDER,
        `${seam} was bound to a ladder it does not need`).toBeUndefined();
    }
  });

  it('an unresolvable agent THROWS rather than silently getting nothing', () => {
    // INVERTED 2026-08-12. This asserted {} — the fail-open that left all 64 MINTED agents
    // unconfigured, with nothing said. Resolution is now total: an agent that matches no
    // profile, no cross-reference, no pattern and no declared default is a registry error,
    // raised where it can be fixed rather than three hours into a run.
    process.env.AGENT_PROFILES_REGISTRY = REG;
    // With a defaultSeam declared, an unknown agent resolves to it — that IS the fix. The
    // throw is for a registry that declares neither a pattern nor a default, proven in
    // seam-resolution-is-total.test.ts against a fixture.
    expect(spec.seamInvocationEnv('no-such-seam', 'orchestrations/logs'),
      'an unknown agent still gets nothing').not.toEqual({});
  });

  it('a named ladder with no models configured does not silently invent one', () => {
    process.env.AGENT_PROFILES_REGISTRY = REG;
    delete process.env.EPAM_MODEL_LADDER_HIGHEST;
    const env = spec.seamInvocationEnv('roster-review', 'orchestrations/logs');
    expect(env.EPAM_MODEL_LADDER).toBeUndefined();
    expect(env.EPAM_REASONING_EFFORT, 'the rest of the profile was discarded too').toBe('high');
  });
});
