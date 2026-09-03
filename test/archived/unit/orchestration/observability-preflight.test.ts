/**
 * A run nobody can see is a run whose cost is unrecoverable.
 *
 * Live 2026-07-28. The host crashed overnight and took the observability stack
 * with it:
 *
 *   epam-cli-grafana-1      Exited (255) 16 hours ago
 *   epam-cli-postgres-1     Exited (255) 16 hours ago
 *   epam-cli-redis-1        Exited (255) 16 hours ago
 *   epam-cli-clickhouse-1   Exited (255) 16 hours ago
 *   epam-cli-langfuse-server-1  Restarting (1)   <- crash-looping on the above
 *
 * The AMSD-2041 metrolinx run launched into that and produced ZERO traces before
 * anyone noticed, on a run whose whole point was measuring a first-ever
 * multi-codeline execution. Real cost tracking is the stated #1 priority and
 * observability #2 — and both were absent while the run spent money.
 *
 * The launcher already gates on CodeGraph indexing for exactly this reason:
 * fail loud BEFORE any spend rather than discover the gap afterwards. This adds
 * the same gate for tracing.
 *
 * Checked at the ENDPOINT, not with `docker ps`. A container reports Up while
 * still returning 5xx, and "the process exists" is not "the service works" —
 * the same distinction behind the Live Execution panel that silently never
 * worked. Grafana answers 302 (redirect to login) when healthy, so the check
 * accepts any 2xx/3xx and only treats 4xx/5xx/000 as down.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LAUNCHER = join(__dirname, '../../../orchestrations/scripts/tier3-metrolinx-run.sh');
const src = readFileSync(LAUNCHER, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The observability preflight block. */
function block(): string {
  const i = src.indexOf('Observability preflight');
  expect(i, 'no observability preflight exists in the launcher').toBeGreaterThan(-1);
  return src.slice(i, i + 2600);
}

describe('the launcher refuses to spend money it cannot trace', () => {
  it('checks Langfuse', () => {
    expect(block(), 'Langfuse is never verified — the run can produce zero traces')
      .toMatch(/Langfuse/);
  });

  it('checks Grafana', () => {
    expect(block(), 'Grafana is never verified').toMatch(/Grafana/);
  });

  it('verifies the ENDPOINT, not just that a container exists', () => {
    // `docker ps` reporting Up is not the same as the service answering.
    expect(block(), 'the check reads container state rather than making a request')
      .toMatch(/curl/);
  });

  it('accepts a redirect as healthy', () => {
    // Grafana returns 302 to /login when it is working. Treating that as down
    // would make the gate fail on a healthy stack — a gate that cries wolf gets
    // bypassed, which is worse than no gate.
    expect(block(), 'a healthy Grafana (302) would be reported as down')
      .toMatch(/3\?\?|30[0-9]/);
  });

  it('aborts the launch rather than warning and continuing', () => {
    expect(block(), 'the preflight logs a failure but the run proceeds untraced')
      .toMatch(/exit 1/);
  });

  it('runs BEFORE the Jira/spec work that costs money', () => {
    // Ordering is the whole point: discovering this mid-run is what happened.
    const obs = src.indexOf('Observability preflight');
    const codegraph = src.indexOf('CodeGraph preflight: verifying');
    expect(obs, 'observability preflight is missing').toBeGreaterThan(-1);
    expect(obs, 'observability preflight runs after CodeGraph indexing, which is slow and costly')
      .toBeLessThan(codegraph);
  });

  it('tells the operator how to bring the stack back', () => {
    // The failure is almost always "the host restarted", and langfuse-server
    // crash-loops until its dependencies are healthy — so the order matters and
    // must be in the message, not in someone's memory.
    expect(block(), 'the failure message does not say how to recover')
      .toMatch(/docker compose/);
    expect(block(), 'the message does not name the dependencies that must start first')
      .toMatch(/postgres/);
  });

  it('can be bypassed deliberately, and says what that costs', () => {
    expect(block(), 'no escape hatch — a tracing outage would block all work')
      .toMatch(/OBSERVABILITY_PREFLIGHT/);
  });
});

describe('the observability preflight block, executed for real (not just source-pattern checks)', () => {
  // Live bug, 2026-07-31: this exact block calls `error "..."` on a down
  // stack — but this script only defines info()/success()/fail(), never
  // error(). Under `set -e`, calling an undefined command exits 127 and
  // `set -e` kills the WHOLE launcher mid-message ("error: command not
  // found") instead of printing the intended diagnostic and a clean exit 1.
  // Every test above is a static regex-on-source check and passed anyway —
  // none of them ever ran the block, so none could catch a crash that only
  // happens at execution time. This is the concrete case for
  // feedback_test_fixture_fidelity_not_just_real_execution: real execution,
  // not just realistic fixtures, matters just as much.
  function extractBlockWithPrelude(): string {
    const start = src.indexOf("RED='");
    const blockStart = src.indexOf('if [ "${OBSERVABILITY_PREFLIGHT:-1}" = "1" ]');
    const blockEnd = src.indexOf('\nfi', blockStart) + 3;
    expect(start, 'color var definitions not found').toBeGreaterThan(-1);
    expect(blockStart, 'observability preflight if-block not found').toBeGreaterThan(-1);
    expect(blockEnd, 'observability preflight if-block end not found').toBeGreaterThan(2);
    // Prelude: color vars + whatever log functions (info/success/error/...)
    // the real script actually defines before the "Run artefacts" section —
    // tracks the real source exactly, so this test reflects error()'s
    // absence before the fix and its presence after, rather than assuming.
    const preludeEnd = src.indexOf('# ── Run artefacts', start);
    expect(preludeEnd, 'prelude end marker not found').toBeGreaterThan(start);
    return src.slice(start, preludeEnd) + '\n' + src.slice(blockStart, blockEnd);
  }

  function runBlock(curlExitCode: string, env: Record<string, string> = {}) {
    const harness = mkdtempSync(join(tmpdir(), 'obs-preflight-'));
    dirs.push(harness);
    const bin = join(harness, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\necho "${curlExitCode}"\n`);
    chmodSync(join(bin, 'curl'), 0o755);

    const script = join(harness, 'run.sh');
    writeFileSync(script, ['#!/usr/bin/env bash', 'set -euo pipefail', extractBlockWithPrelude(), 'echo DONE'].join('\n'));

    const r = spawnSync('bash', [script], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });
    return { out: (r.stdout || '') + (r.stderr || ''), code: r.status ?? -1 };
  }

  it('a down stack produces a clean exit 1 with the intended message — not "command not found"', () => {
    const r = runBlock('000'); // curl reports unreachable, matching a down stack
    expect(r.out, `must not crash on an undefined command:\n${r.out}`).not.toMatch(/command not found/);
    expect(r.out, `expected the real diagnostic message:\n${r.out}`).toMatch(/Observability preflight FAILED/);
    expect(r.out).toMatch(/docker compose/);
    expect(r.code).toBe(1);
  });

  it('a healthy stack (2xx) proceeds past the block without error', () => {
    const r = runBlock('200');
    expect(r.out, `must not crash:\n${r.out}`).not.toMatch(/command not found/);
    expect(r.out).toMatch(/DONE/);
    expect(r.code).toBe(0);
  });

  it('OBSERVABILITY_PREFLIGHT=0 skips the check entirely, even on a down stack', () => {
    const r = runBlock('000', { OBSERVABILITY_PREFLIGHT: '0' });
    expect(r.out).toMatch(/DONE/);
    expect(r.code).toBe(0);
  });
});
