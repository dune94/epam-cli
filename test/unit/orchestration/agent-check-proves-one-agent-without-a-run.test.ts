/**
 * PROVE ONE AGENT WORKS, WITHOUT A PIPELINE RUN — the tool that should precede every launch.
 *
 * Its own header: every agent defect found on 2026-08-23 was found by launching a run, watching it,
 * and reading what it left behind — the roster reviewer with no tools, the ladder that never reached
 * a seam, the brief block that rendered blank. Each cost a paid run to see, and killing the run
 * destroyed the evidence. An agent is a unit and should be provable as one.
 *
 * --dry renders and validates the INPUT and calls nothing, so everything below costs nothing. That
 * is also the mode an operator uses before spending, which makes its correctness the point: a --dry
 * that passes on a seam whose prompt does not render tells you the run is safe when it is not.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/agent-check.js');
const NODE = process.execPath;

// A codeline is required before anything else happens — the tool refuses without one rather than
// guessing which project it is checking. mock3 is the repo's own fixture project.
// A codeline AND a story: the tool refuses without either rather than guessing what it is checking,
// which is the right refusal — a check run against a different project than the one about to launch
// answers a question nobody asked.
const CODELINE = ['--codeline', 'mock3', '--story', 'MOCK-1'];

function check(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(NODE, [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 300_000,
    cwd: join(__dirname, '../../..'),
    env: { ...process.env, EPAM_COVERAGE_GATED: '0', ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('agent-check proves an agent without spending a run', () => {
  it('--dry CALLS NOTHING — it is the mode used before deciding to spend', () => {
    // If --dry reached a provider it would cost money to answer "is it safe to spend money".
    const r = check([...CODELINE, '--seam', 'team-lead-review', '--dry'],
      { ORCH_GATE_PROVIDER: 'definitely-not-a-provider', AI_PROVIDER: 'definitely-not-a-provider' });
    expect(r.out, '--dry reached a provider').not.toMatch(/provider .*not.*(accept|exist)|ECONNREFUSED/i);
  }, 400_000);

  it('--dry reports per-seam, naming the seam it checked', () => {
    const r = check([...CODELINE, '--seam', 'team-lead-review', '--dry']);
    expect(r.out, 'the seam it checked is not named in its own report')
      .toMatch(/team-lead-review/);
  }, 400_000);

  it('an UNKNOWN seam is refused, not reported as passing', () => {
    // A check that passes on a seam it could not find tells the operator every agent is fine.
    const r = check([...CODELINE, '--seam', 'definitely-not-a-seam', '--dry']);
    expect(r.code, 'an unknown seam was reported as checked').not.toBe(0);
    expect(r.out, 'the refusal does not name what was not found')
      .toMatch(/definitely-not-a-seam|no seam|unknown/i);
  }, 400_000);

  it('--all --dry covers MANY seams, not one', () => {
    // The operator's standing instruction is that this is free and covers every seam. A --all that
    // silently checked one would answer a different question.
    const r = check([...CODELINE, '--all', '--dry']);
    const named = new Set((r.out.match(/\b[a-z][a-z0-9-]{4,}\b/g) || []));
    expect(named.size, '--all reported on almost nothing').toBeGreaterThan(10);
  }, 400_000);

  it('with NO codeline it REFUSES and lists the ones it knows', () => {
    // It will not guess which project it is checking. Guessing would report on a different project
    // than the operator is about to launch.
    const r = check([]);
    expect(r.code, 'it ran without knowing which project it was checking').not.toBe(0);
    expect(r.out, 'the refusal does not say how to supply a codeline').toMatch(/--codeline/);
    expect(r.out, 'it does not list the codelines it could use').toMatch(/mock3|metrolinx/);
  }, 400_000);

  it('exit status is 0 only when every checked agent met its contract', () => {
    // The status is what a launcher would gate on, so it must not be decorative.
    const bad = check([...CODELINE, '--seam', 'definitely-not-a-seam', '--dry']);
    expect(bad.code, 'a failed check exited 0').not.toBe(0);
  }, 400_000);

  it('an unknown flag is refused rather than silently ignored', () => {
    // Silently ignoring --dry would turn a free check into a paid one.
    const r = check([...CODELINE, '--seam', 'team-lead-review', '--not-a-flag']);
    expect(r.code !== 0 || /unknown|unrecognis|usage/i.test(r.out),
      'an unknown flag was accepted, so a mis-typed --dry would spend money').toBe(true);
  }, 400_000);
});
