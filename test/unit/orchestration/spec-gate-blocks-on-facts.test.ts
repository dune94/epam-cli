/**
 * A GATE MUST BLOCK ON SOMETHING THAT CAN BE EXAMINED.
 *
 * The spec review gate had two signals. SPEC_REVIEW_BLOCKING_FLAGS — specific, enumerable,
 * checkable — defaulted to EMPTY. SPEC_REVIEW_MIN_QUALITY — a bare number the reviewer
 * invents — defaulted to 0.7 and was therefore the only thing that could stop a run.
 *
 * Live 2026-08-07: a lane halted at qualityScore 0.68, a 0.02 margin, while two lanes cleared.
 * Nothing in the artefacts can say whether that spec was materially worse or simply drew a
 * lower number, because "0.68" is not a claim about anything. The gate's own comments record
 * the same instability from earlier runs — lanes stopped at 0.78 and 0.72, and elsewhere every
 * lane sailing through at 0.45.
 *
 * Everything else a model asserts in this pipeline is either structurally constrained (enums,
 * schema-bound output) or independently re-checked (roster findings are re-run against the
 * repository). A scalar can be neither.
 *
 * So it is reported, not enforced, unless a project deliberately sets a bar. What still blocks
 * is what can be examined: declared blocking flags, and the deterministic missing-manifest-path
 * check.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const GUARDS = join(__dirname, '../../../orchestrations/scripts/lib/story-guards.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function gate(review: Record<string, unknown>, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'specgate-')); dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    stories: [{ id: 'S-1', status: 'pending', specification: { coordinatorReview: review } }],
  }));
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n');
  const res = spawnSync('bash', ['-c',
    // The lib expects its host to provide the log functions; sourced standalone they are
    // undefined and every advisory vanishes. Define them so the report is observable.
    `set +e\nwarning() { echo "$*"; }\ninfo() { echo "$*"; }\nerror() { echo "$*"; }\n` +
    `${exports}\nsource ${JSON.stringify(GUARDS)} >/dev/null 2>&1\n` +
    `spec_review_gate ${JSON.stringify(prd)}; echo "RC=$?"`,
  ], { encoding: 'utf8' });
  const out = (res.stdout || '') + (res.stderr || '');
  return { blocked: !/RC=0/.test(out), out };
}

describe('a low score alone no longer stops a run', () => {
  it('THE LIVE CASE: 0.68 with no flags is advisory, not blocking', () => {
    const r = gate({ verdict: 'needs_review', qualityScore: 0.68, flags: [] });
    expect(
      r.blocked,
      'a run was stopped by a number nobody can interrogate, on a 0.02 margin',
    ).toBe(false);
  });

  it('but it is REPORTED — an advisory nobody sees is a silent failure', () => {
    const r = gate({ verdict: 'needs_review', qualityScore: 0.68, flags: [] });
    expect(r.out).toMatch(/qualityScore \(telemetry/i);
    expect(r.out).toMatch(/0\.68/);
  });

  it('the score never gates, however low', () => {
    const r = gate({ verdict: 'needs_review', qualityScore: 0.05, flags: [] });
    expect(r.blocked, 'a scalar still stops a run').toBe(false);
  });
});

describe('what CAN be examined still blocks', () => {
  it('a flag the PROJECT declared blocking stops the run', () => {
    const r = gate({ verdict: 'needs_review', qualityScore: 0.95,
      flags: [{ flag: 'missing_fix_site', severity: 'blocking', why: 'the declared file is not there' }] },
      { SPEC_REVIEW_BLOCKING_FLAGS: 'missing_fix_site' });
    expect(
      r.blocked,
      'a specific, named objection did not block while a scalar used to',
    ).toBe(true);
  });

  it('a project may NARROW which blocking flags count', () => {
    const r = gate({ verdict: 'needs_review', qualityScore: 0.95,
      flags: [{ flag: 'style_nit', severity: 'blocking' }] },
      { SPEC_REVIEW_BLOCKING_FLAGS: 'missing_fix_site' });
    expect(r.blocked, 'a project narrowed the blocking set and an unlisted flag still blocked').toBe(false);
    expect(r.out, 'the narrowed-out objection vanished instead of being reported').toMatch(/style_nit/);
  });

  it('needs_review with NO flag does not block — it named nothing to act on', () => {
    const r = gate({ verdict: 'needs_review', qualityScore: 0.68, flags: [] });
    expect(r.blocked).toBe(false);
  });

  it('THE REAL HISTORY: uncertainty flags are advisory and do NOT halt the run', () => {
    // Every flag this reviewer has emitted on real runs is an uncertainty disclosure, and it
    // never returns "approved" on brownfield. Blocking on the verdict, or on flag presence,
    // halts every run — which is what happened on 20260804T145419Z across all three lanes.
    const r = gate({ verdict: 'needs_review', qualityScore: 0.78,
      flags: [
        { flag: 'blind_authoring', severity: 'advisory' },
        { flag: 'unverified_cx_shared_assumptions', severity: 'advisory' },
      ] });
    expect(r.blocked, 'advisory uncertainty halted an autonomous run').toBe(false);
  });

  it('a legacy bare-string flag is treated as advisory', () => {
    const r = gate({ verdict: 'needs_review', qualityScore: 0.5, flags: ['api_shape_uncertainty'] });
    expect(r.blocked, 'an older reviewer\'s output started blocking runs').toBe(false);
  });

  it('one declared flag among undeclared ones still stops it', () => {
    const r = gate({ verdict: 'needs_review', qualityScore: 0.9,
      flags: [
        { flag: 'api_shape_uncertainty', severity: 'advisory' },
        { flag: 'missing_fix_site', severity: 'blocking' },
      ] }, { SPEC_REVIEW_BLOCKING_FLAGS: 'missing_fix_site' });
    expect(r.blocked).toBe(true);
  });

  it('SELF-ASSESSED severity alone does NOT block — it is the same class as the score', () => {
    // This reviewer hallucinates a missing-manifest-path flag in 1 of 4 samples. Letting it
    // mark its own flag blocking would halt valid runs on its own word — precisely what the
    // computed manifest check exists to prevent. Severity ranks objections for a human; it
    // does not decide whether the pipeline stops.
    const r = gate({ verdict: 'needs_review', qualityScore: 0.95,
      flags: [{ flag: 'missing_manifest_path', severity: 'blocking' }] });
    expect(r.blocked, 'the model authorised its own halt').toBe(false);
  });

  it('an approved verdict does not block even carrying a flag', () => {
    const r = gate({ verdict: 'approved', qualityScore: 0.99, flags: ['style_nit'] });
    expect(r.blocked).toBe(false);
  });

  it('an approved review with no flags passes cleanly', () => {
    const r = gate({ verdict: 'approved', qualityScore: 0.99, flags: [] });
    expect(r.blocked).toBe(false);
  });
});

describe('a missing score is not a zero', () => {
  it('a review with no qualityScore does not block', () => {
    const r = gate({ verdict: 'approved', flags: [] });
    expect(r.blocked).toBe(false);
  });
});
