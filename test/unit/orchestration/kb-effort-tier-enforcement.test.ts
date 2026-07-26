/**
 * Self-heal proposes an EFFORT TIER, never a raw budget integer.
 *
 * The pipeline already has a bounded assignment path the model participates in
 * correctly:
 *
 *   CPA estimates estimatedHours -> get_effort_tier() (<=2h low, <=6h medium,
 *   >6h high) -> resolve_effort_settings() (low=6, medium=10, high=15 iterations)
 *
 * The model expresses a judgement it CAN make — how big is this work — and
 * deterministic code owns every number.
 *
 * Self-heal was bypassing all of it by emitting integers, and got it wrong three
 * times out of three (14 after exhausting 15; then 1, "prevents iterative
 * retries"; then 14 again). Four successive guards tried to referee those numbers
 * and each was routed around, because the guard never had a trustworthy baseline
 * at admission.
 *
 * A tier dissolves that. There is nothing to compare numerically: the values are
 * ordered and total, so "is this an upgrade" is decidable wherever both are known.
 * And the upgrade check belongs in resolve_effort_settings, which is the one place
 * that holds BOTH the story's tier and the proposed one — no baseline plumbing, no
 * fail-open/fail-closed dilemma.
 *
 * Deliberately NOT a PRD mutation: the override travels as env, because editing
 * the PRD is never the fix for a story failure.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const compiler = require(join(LIB, 'constraint-compiler.js'));
const py = () => {
  const venv = join(LIB, '..', '.venv', 'bin', 'python3');
  try { execFileSync(venv, ['--version']); return venv; } catch { return 'python3'; }
};
const validate = (r: unknown) => {
  try {
    return JSON.parse(execFileSync(py(), [join(LIB, 'kb_schema.py'), 'validate-constraint'],
      { input: JSON.stringify(r), encoding: 'utf8' }));
  } catch (e: any) { return JSON.parse((e.stdout || '{"ok":false}').trim()); }
};

const base = {
  id: 'repro-test-writer-class-max-iterations',
  scope: { agent_role: 'repro-test-writer' },
  trigger: { signature: 'class:max_iterations' },
  reason: 'the agent exhausted its turns before writing the deliverable',
};

describe('effort_tier is expressible; raw budgets are not', () => {
  it('accepts a tier upgrade', () => {
    const r = validate({ ...base, enforcement: { kind: 'effort_tier', tier: 'high' } });
    expect(r.ok, `schema rejected a legitimate tier: ${r.detail}`).toBe(true);
  });

  it('rejects a tier outside the enum — the model cannot invent one', () => {
    expect(validate({ ...base, enforcement: { kind: 'effort_tier', tier: 'maximum' } }).ok).toBe(false);
    expect(validate({ ...base, enforcement: { kind: 'effort_tier', tier: '30' } }).ok).toBe(false);
  });

  it('still rejects a raw budget integer', () => {
    const r = validate({ ...base,
      enforcement: { kind: 'param', name: 'EPAM_MAX_ITERATIONS', value: '30' } });
    expect(r.ok, 'the integer channel is open again').toBe(false);
  });
});

describe('the tier compiles to an env override, not a PRD edit', () => {
  it('emits EPAM_EFFORT_TIER', () => {
    const { env } = compiler.compile([
      { ...base, status: 'active', enforcement: { kind: 'effort_tier', tier: 'high' } },
    ]);
    expect(env.EPAM_EFFORT_TIER, 'no channel to resolve_effort_settings').toBe('high');
  });

  it('carries no free text', () => {
    const { env } = compiler.compile([
      { ...base, status: 'active', enforcement: { kind: 'effort_tier', tier: 'high' } },
    ]);
    expect(JSON.stringify(env)).not.toMatch(/exhausted its turns/);
  });

  it('remains TOTAL over the schema kinds', () => {
    const schema = JSON.parse(execFileSync(py(),
      [join(LIB, 'kb_schema.py'), 'json-schema', 'constraint'], { encoding: 'utf8' }));
    const kinds = Object.values<any>(schema.$defs || schema.definitions || {})
      .map(d => d?.properties?.kind?.const).filter(Boolean);
    expect(kinds).toContain('effort_tier');
    expect(compiler.supportedKinds().sort()).toEqual(kinds.sort());
  });
});

describe('resolve_effort_settings applies the override UPGRADE-ONLY', () => {
  const src = readFileSync(join(LIB, '..', 'claude.sh'), 'utf8');

  it('honours EPAM_EFFORT_TIER', () => {
    expect(src, 'the compiled tier never reaches the effort resolver')
      .toMatch(/EPAM_EFFORT_TIER/);
  });

  it('refuses a DOWNGRADE — the same backwards reasoning in a new costume', () => {
    const i = src.indexOf('resolve_effort_settings()');
    const fn = src.slice(i, i + 2600);
    expect(fn,
      'a tier downgrade after a failure would repeat exactly the mistake the raw ' +
      'integers made — taking room away from an agent that ran out of it')
      .toMatch(/rank|upgrade|downgrade|-gt|higher/i);
  });
});
