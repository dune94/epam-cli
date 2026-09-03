/**
 * THE LADDER OWNS REASONING EFFORT. A SEAM CANNOT RAISE IT.
 *
 * The ladder declares effort per rung so the cheap entry rung is actually cheap:
 *
 *     "high": { rungs: [ {rung:0, reasoningEffort:"medium"}, {rung:1, ..."high"}, ... ] }
 *
 * A seam ALSO declared a flat reasoningEffort, seam-invocation.js exported it, and
 * next_ladder_step then took `max_effort(seam, rung)`. The rung's value was documented as "a
 * FLOOR, never a downgrade", so the seam's declaration always won when it was higher — and 33 of
 * 41 seams declare "high". The ladder's rung-0 "medium" could never take effect anywhere.
 *
 * MEASURED 2026-09-01, metrolinx: prompt-builder enters on claude-haiku-4-5, the cheap rung, and
 * each call took ~68s to emit ~2000 tokens of what its own registry entry calls "largely
 * RESTATEMENT". Not haiku being slow — haiku reasoning hard about a text rewrite, because the
 * seam's flat "high" overrode the rung's "medium". Across 39 generated prompts at 2-3 calls each,
 * that is the stage's ~1.5 hours.
 *
 * OPERATOR DECISION 2026-09-01: the ladder is the single source of effort. A seam is ASSIGNED to
 * a ladder; it does not get to renegotiate what that ladder costs — the same rule already settled
 * for iterations (a seam never carries its own maxIterations literal).
 *
 * WHAT THIS DOES NOT CHANGE. next_ladder_step still raises effort when the MODEL cannot move: at
 * the top of the chain effort is the only lever left, and that escalation belongs to the ladder
 * itself, not to a seam overriding it. That path is asserted below so removing the seam override
 * cannot quietly remove the escalation with it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO = process.cwd();
const claudeSrc = readFileSync(join(REPO, 'orchestrations/scripts/claude.sh'), 'utf8');

function extractFunctionBody(name: string): string {
  const start = claudeSrc.indexOf(`${name}()`);
  if (start < 0) throw new Error(`function ${name} not found in claude.sh`);
  const braceStart = claudeSrc.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < claudeSrc.length; i++) {
    if (claudeSrc[i] === '{') depth++;
    else if (claudeSrc[i] === '}') { depth--; if (depth === 0) return claudeSrc.slice(start, i + 1); }
  }
  throw new Error(`Could not find end of function ${name}`);
}

/** Run next_ladder_step for real, with the ladder config supplied as the run supplies it. */
function ladderStep(
  rung: number, model: string, effort: string, tier: string, env: Record<string, string> = {},
): { model: string; effort: string; temp: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ladder-effort-'));
  const script = join(dir, 'run.sh');
  const fns = ['effort_rank', 'max_effort', 'next_effort', 'get_model_ladder_step', 'next_ladder_step']
    .map(extractFunctionBody).join('\n\n');
  writeFileSync(script, `#!/usr/bin/env bash\nset -uo pipefail\n${fns}\n`
    + `next_ladder_step "${rung}" "${model}" "${effort}" "${tier}"\n`);
  const r = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const [m, e, t] = String(r.stdout || '').trim().split('|');
  return { model: m, effort: e, temp: t };
}

describe('the ladder owns reasoning effort', () => {
  it('the harness executes the real function — otherwise nothing below is a fact', () => {
    const out = ladderStep(0, 'claude-haiku-4-5-20251001', 'medium', 'high', {
      EPAM_RUNG0_REASONING_EFFORT: 'medium',
    });
    expect(out.effort, `next_ladder_step produced nothing usable: ${JSON.stringify(out)}`)
      .toBeTruthy();
  });

  it('THE RUNG DECIDES: a seam asking for "high" does not raise rung 0 above "medium"', () => {
    // `effort` arriving as "high" IS the seam's declaration — seam-invocation.js exports it as
    // EPAM_REASONING_EFFORT and it is carried in as the current effort.
    const out = ladderStep(0, 'claude-haiku-4-5-20251001', 'high', 'high', {
      EPAM_RUNG0_REASONING_EFFORT: 'medium',
    });
    expect(out.effort,
      'the seam\'s flat "high" overrode the ladder\'s rung-0 "medium" — the cheap entry rung is '
      + 'not cheap, which is the ~68s-per-haiku-call finding')
      .toBe('medium');
  });

  it('AND at rung 1 the rung still decides — the seam cannot pin it either way', () => {
    const out = ladderStep(1, 'claude-haiku-4-5-20251001', 'low', 'high', {
      EPAM_RUNG1_REASONING_EFFORT: 'high',
    });
    expect(out.effort, 'the rung-1 declared effort did not take effect').toBe('high');
  });

  it('PRESERVED: at the top of the chain effort still rises — that is the ladder, not a seam', () => {
    // When the model cannot step, effort is the only lever the LADDER has left. Removing the seam
    // override must not remove this.
    const top = ladderStep(2, 'claude-opus-5', 'medium', 'high', {
      EPAM_RUNG2_REASONING_EFFORT: 'medium',
    });
    expect(['high', 'max'],
      `at the top of the chain effort must escalate, got '${top.effort}'`)
      .toContain(top.effort);
  });

  it('THE OVERRIDE CHANNEL IS CLOSED: seam-invocation no longer exports a seam effort', () => {
    // The floor rule is only half of it. While seam-invocation.js exports the seam's declared
    // effort, that value is what arrives as the current effort on every call.
    const si = readFileSync(join(REPO, 'orchestrations/scripts/lib/seam-invocation.js'), 'utf8');
    expect(si,
      'seam-invocation.js still exports profile.reasoningEffort — the seam can still set the '
      + 'effort the ladder is supposed to own')
      .not.toMatch(/env\.EPAM_REASONING_EFFORT\s*=\s*String\(profile\.reasoningEffort\)/);
  });

  it('AND NO SEAM STILL DECLARES ONE: a dead field reads as live', () => {
    const P = JSON.parse(
      readFileSync(join(REPO, 'orchestrations/agents/invocation-profiles.json'), 'utf8'),
    ).profiles || {};
    const declaring = Object.entries<any>(P)
      .filter(([n, v]) => !n.startsWith('_') && v && v.reasoningEffort)
      .map(([n]) => n);
    expect(declaring,
      `${declaring.length} seam(s) still declare reasoningEffort, which nothing now reads: `
      + declaring.slice(0, 6).join(', ')).toEqual([]);
  });
});
