/**
 * A READ-ONLY AGENT CAN READ EVERY CODELINE OF THE RUN — not only the one it happens to start in.
 *
 * Live AMSD-2974 runs 3 and 4 (2026-10-09): on the copilot set an agent reads only its working directory and the
 * folders passed as --add-dir, and the runner passes EPAM_READ_ROOTS — which only the spec pass and the writer set.
 * Every estate-wide agent before the lanes exist (estate survey, mint, roster review, prompt builder) was scoped to
 * PROJECT_ROOT alone: three of the four codelines answered "Permission denied because no interactive user response
 * was available". Blind, the agents filled the gap from the project folder — a previous run's working PRDs, an old
 * prompt cache — and the prompt reviewer, which could see the repositories, rejected every attempt until the mint
 * refused. Both runs died in the Agents Phase.
 *
 * A seam's codeline scope is the run's: the codelines discovery found (its persisted artefact), or the lane's own set
 * once lanes run; before discovery has answered, the estate it searches. A read grant reads that scope.
 *
 * EXECUTED: the real seamInvocationEnv (lib/seam-invocation.js) against the real registry, with the run's state as
 * the pipeline leaves it on disk.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { seamInvocationEnv } = require(join(__dirname, '../../../orchestrations/scripts/lib/seam-invocation.js'));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function estate() {
  const root = mkdtempSync(join(tmpdir(), 'estate-')); dirs.push(root);
  const cl = (n: string) => { const p = join(root, n); mkdirSync(join(p, '.git'), { recursive: true }); writeFileSync(join(p, 'package.json'), '{}'); return p; };
  const lib = cl('cx-shared'); const go = cl('next.gotransit.com'); const up = cl('next.upexpress.com'); const mx = cl('next.metrolinx.com');
  cl('unrelated-repo');
  const logs = join(root, '_logs'); mkdirSync(logs);
  return { root, lib, go, up, mx, logs };
}
const discovered = (e: ReturnType<typeof estate>) => writeFileSync(join(e.logs, 'codeline-discovery.json'), JSON.stringify({
  codelines: [{ name: 'cxshared', path: e.lib }, { name: 'gotransit', path: e.go }, { name: 'upexpress', path: e.up }, { name: 'metrolinx', path: e.mx }],
}));
const roots = (env: Record<string, string>) => String(env.EPAM_READ_ROOTS || '').split('\n').filter(Boolean).sort();

describe('a read-only agent can read every codeline of the run', () => {
  for (const seam of ['estate-survey', 'prompt-builder', 'prompt-review', 'agent-mint', 'roster-review']) {
    it(`${seam}: before the lanes, every codeline discovery found is readable — not only PROJECT_ROOT`, () => {
      const e = estate(); discovered(e);
      const env = seamInvocationEnv(seam, undefined, { env: { LOG_DIR: e.logs, PROJECT_ROOT: e.lib } });
      expect(roots(env)).toEqual([e.lib, e.go, e.up, e.mx].sort());
    });
  }

  it('nothing outside the run\'s codelines is granted — not the estate\'s other repositories', () => {
    const e = estate(); discovered(e);
    const r = roots(seamInvocationEnv('estate-survey', undefined, { env: { LOG_DIR: e.logs, PROJECT_ROOT: e.lib } }));
    expect(r.length, 'nothing granted at all').toBeGreaterThan(0);
    expect(r).not.toContain(join(e.root, 'unrelated-repo'));
    expect(r).not.toContain(e.root);
  });

  it('in a lane, the lane\'s own codelines are the scope (EPAM_CODELINE_PATHS)', () => {
    const e = estate(); discovered(e);
    const env = seamInvocationEnv('prompt-review', undefined, { env: { LOG_DIR: e.logs, PROJECT_ROOT: e.go, EPAM_CODELINE_PATHS: `${e.go},${e.lib}` } });
    expect(roots(env)).toEqual([e.go, e.lib].sort());
  });

  it('before discovery has answered, discovery itself can read the estate it searches', () => {
    const e = estate();
    const env = seamInvocationEnv('codeline-discovery', undefined, { env: { LOG_DIR: e.logs, PROJECT_ROOT: e.lib, JIRA_CODELINE_ROOT: e.root } });
    expect(roots(env)).toEqual([e.root]);
  });

  it('a write grant is not widened — its caller decides what it may touch', () => {
    const e = estate(); discovered(e);
    // the registry's write-file seams
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const reg = require(join(__dirname, '../../../orchestrations/agents/invocation-profiles.json'));
    const writeSeam = Object.keys(reg.profiles).find((k) => /^write/.test(String(reg.profiles[k].toolGrant || '')));
    expect(writeSeam, 'the registry has no write seam to check').toBeTruthy();
    const env = seamInvocationEnv(writeSeam, undefined, { env: { LOG_DIR: e.logs, PROJECT_ROOT: e.lib } });
    expect(env.EPAM_READ_ROOTS).toBeUndefined();
  });
});
