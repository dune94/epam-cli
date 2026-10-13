/**
 * A BOUNDED NODE TOOL SEES ONLY ITS CORES.
 *
 * AMSD-2974 run 9, resume 9 (2026-10-13): the cxshared reviewer ran cx-shared's jest suite with 15 workers on a 16-core
 * host — 5.25 GB, memory pressure 98% "full" for 17 minutes — although its call WAS bounded: every worker's CPU affinity
 * read 0,1. jest 29.3.1 sizes its pool from `os.cpus().length` (jest-config/build/getMaxWorkers.js), which counts the
 * host's CPUs and ignores affinity. The pipeline's test bound (lib/bounded-exec.sh) is affinity alone, so it bounded
 * nothing for that runner — the reviewer's call, the writer's external verification and every gate alike. The earlier
 * test of the reviewer's bound asserted `os.availableParallelism()`, which IS affinity-aware: it proved a mechanism the
 * real consumer does not use.
 *
 * EXECUTED: the three bounded paths of lib/bounded-exec.sh and lib/external-verification.sh — run_test_bounded,
 * bound_self_affinity, _bounded_test_command — each starting a real Node child that reports `os.cpus().length`, the
 * exact call jest makes. Negative: with no bound, the child still sees every CPU. And a NODE_OPTIONS the caller already
 * set (a heap ceiling) must survive.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { shellFunction } from '../../lib/engine-source';

const S = join(__dirname, '../../../orchestrations/scripts');
const NODE = process.execPath;
const affinityWorks = spawnSync('taskset', ['-c', '0', 'true']).status === 0;
const HOST = cpus().length;

/** A Node child reporting what a test runner sizes its pool from. */
const PROBE = `${JSON.stringify(NODE)} -e 'const v8=require("v8");process.stdout.write(require("os").cpus().length+" "+Math.round(v8.getHeapStatistics().heap_size_limit/1048576))'`;

function sh(body: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', ['set -uo pipefail', `SCRIPT_DIR=${JSON.stringify(S)}`, `. "$SCRIPT_DIR/lib/bounded-exec.sh"`, body].join('\n')], {
    encoding: 'utf8', env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', ...env },
  });
  const m = `${r.stdout}`.match(/(\d+) (\d+)\s*$/);
  if (!m) throw new Error(`the probe did not report: ${r.stdout}${r.stderr}`);
  return { cpus: Number(m[1]), heapMb: Number(m[2]) };
}

describe.skipIf(!affinityWorks)('a bounded Node tool sees only the cores it was given', () => {
  it('GUARD: this host has more CPUs than the bound — otherwise nothing below is a fact', () => {
    expect(HOST).toBeGreaterThan(2);
  });

  it('NEGATIVE: unbounded, a Node child sees every CPU of the host', () => {
    expect(sh(PROBE).cpus).toBe(HOST);
  });

  it('run_test_bounded 2: the runner sizes its pool from 2 CPUs, not the host', () => {
    expect(sh(`run_test_bounded 2 sh -c ${JSON.stringify(PROBE)}`).cpus).toBe(2);
  });

  it('bound_self_affinity 2 (the reviewer\'s agent call): what it starts sees 2 CPUs', () => {
    expect(sh(`( bound_self_affinity 2; sh -c ${JSON.stringify(PROBE)} )`).cpus).toBe(2);
  });

  it('_bounded_test_command (the writer\'s verification), executed as the pipeline does — in a fresh shell', () => {
    const fn = shellFunction(join(S, 'lib/external-verification.sh'), '_bounded_test_command');
    const r = sh([fn, `cmd="$(_bounded_test_command ${JSON.stringify(PROBE)})"`, 'bash -c "$cmd"'].join('\n'),
      { EPAM_TEST_AVAIL_MB_OVERRIDE: '2400' }); // 2400 MB → 1440 / 700 → 2 workers (resolve_test_workers)
    expect(r.cpus).toBe(2);
  });

  it('a NODE_OPTIONS the caller already set is kept (the heap ceiling still applies)', () => {
    const r = sh(`run_test_bounded 2 sh -c ${JSON.stringify(PROBE)}`, { NODE_OPTIONS: '--max-old-space-size=700' });
    expect(r.cpus).toBe(2);
    expect(r.heapMb).toBeLessThan(1000);
  });
});
