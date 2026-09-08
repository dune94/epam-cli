/**
 * THE /logs PROBE WAITS FOR THE NGINX THAT WAS JUST RESTARTED.
 *
 * pre-run-reset.sh restarts agent-monitor with `--force-recreate` so it serves THIS run's log
 * dir. preflight-check.sh then curls /logs/healing-events.jsonl -- ONCE, with no wait. A
 * container recreated seconds earlier is not yet accepting connections, so the probe read a
 * healthy stack as a broken mount and refused to launch:
 *
 *   ✓ agent-monitor restarted → /logs-dir = .../pipeline-tests-40/orchestrations/logs
 *   ✗ nginx /logs/healing-events.jsonl not reachable — docker /logs-dir mount may be wrong
 *   ━━━ ✗ 1 check(s) FAILED — DO NOT run pipeline ━━━
 *
 * Live 2026-09-08, pipeline-tests-40. The same URL returned HTTP 200 moments later, and the file
 * was present and empty exactly as intended -- the mount was fine, the probe was early. This is
 * the second reading of that message to cost hours: the first blamed the container runtime, the
 * second blamed a missing file. It is neither; it is a race the probe creates itself by sampling
 * a service one step after forcing it to restart.
 *
 * A single sample of a just-restarted service is not evidence. The probe must wait, bounded, and
 * only then call it unreachable.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const PREFLIGHT = join(__dirname, '../../../orchestrations/scripts/preflight-check.sh');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * Drives the real probe with a fake curl that fails the first N attempts, exactly as a container
 * recreated a second earlier does, then succeeds.
 */
function probe(failFirst: number) {
  const src = readFileSync(PREFLIGHT, 'utf8');
  const start = src.indexOf('# 6c. Dashboard /logs/healing-events.jsonl is served by nginx');
  expect(start, 'the /logs probe moved — this test no longer covers it').toBeGreaterThan(-1);
  const end = src.indexOf('\nfi\n', start) + 4;
  const block = src.slice(start, end);

  const dir = mkdtempSync(join(tmpdir(), 'logsprobe-')); dirs.push(dir);
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true });
  const counter = join(dir, 'n');
  writeFileSync(counter, '0');
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
n=$(cat ${JSON.stringify(counter)}); n=$((n+1)); printf '%s' "$n" > ${JSON.stringify(counter)}
[ "$n" -le ${failFirst} ] && exit 7
exit 0
`);
  chmodSync(join(bin, 'curl'), 0o755);

  const script = join(dir, 'drive.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    'ok()   { printf "OK %s\\n" "$*"; }',
    'fail() { printf "FAIL %s\\n" "$*"; }',
    '_DASH=http://localhost:8092',
    block,
  ].join('\n'));

  const r = spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { out: `${r.stdout}${r.stderr}`, attempts: Number(readFileSync(counter, 'utf8')) };
}

describe('the /logs probe waits for a restarted nginx', () => {
  it('GUARD: a service up on the first try passes, and is not made slow', () => {
    const r = probe(0);
    expect(r.out).toMatch(/^OK /m);
    expect(r.attempts, 'the probe should stop as soon as it succeeds').toBe(1);
  });

  it('A SERVICE THAT NEEDS A MOMENT IS NOT CALLED BROKEN — the live failure', () => {
    const r = probe(3);
    expect(r.out, 'the probe still refuses a launch because nginx was one second behind the '
      + 'restart the pipeline itself had just forced').not.toMatch(/^FAIL /m);
    expect(r.out).toMatch(/^OK /m);
    expect(r.attempts, 'it did not retry').toBeGreaterThan(1);
  });

  it('A GENUINELY UNREACHABLE MOUNT STILL FAILS — the check keeps its teeth', () => {
    const r = probe(9999);
    expect(r.out, 'a mount that never comes up must still refuse the launch').toMatch(/^FAIL /m);
    expect(r.attempts, 'it must actually have tried more than once before condemning it')
      .toBeGreaterThan(1);
  });
});
