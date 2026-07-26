/**
 * A stale dist/ means source changes silently do not execute.
 *
 * The pipeline runs `epam`, which is a two-line shim: `exec node
 * .../dist/epam.js`. It never runs src/. On 2026-07-26 dist/epam.js was two
 * days old, so the AgentRunner tool-budget change committed that morning would
 * have been a complete no-op in a live run — and worse, it would have LOOKED
 * like it ran: the detective still would have been given
 * EPAM_MAX_TOOL_CALLS=7, and the binary would simply have ignored it. The only
 * reason it was caught was a manual check before launching.
 *
 * That is the silent-failure class exactly: a mechanism that reports success
 * while doing nothing. Nothing in the pipeline verifies that the binary it runs
 * was built from the source in the tree.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/dist-freshness.sh');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repo whose src/ and dist/ have explicitly-set mtimes. */
function makeRepo(opts: { srcAt?: number; distAt?: number | null }): string {
  const root = mkdtempSync(join(tmpdir(), 'dist-fresh-'));
  cleanupDirs.push(root);
  const write = (rel: string, at: number) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x\n');
    utimesSync(abs, at, at);
  };
  const base = 1_700_000_000;
  write('src/agent/AgentRunner.ts', base + (opts.srcAt ?? 0));
  if (opts.distAt !== null) write('dist/epam.js', base + (opts.distAt ?? 0));
  return root;
}

function check(repo: string, env: Record<string, string> = {}) {
  const r = spawnSync(
    'bash',
    ['-c',
      'warning(){ echo "WARNING: $*"; }; error(){ echo "ERROR: $*"; }; info(){ echo "INFO: $*"; }\n' +
      `. ${JSON.stringify(LIB)}\n` +
      `assert_dist_fresh ${JSON.stringify(repo)}\n` +
      'echo "RC=$?"'],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, ...env } },
  );
  const out = (r.stdout || '') + (r.stderr || '');
  return { rc: parseInt((out.match(/RC=(\d+)/) || [, '-1'])[1], 10), out };
}

describe('the binary must be built from the source in the tree', () => {
  it('fails when src is newer than dist — the live 2026-07-26 state', () => {
    const { rc, out } = check(makeRepo({ srcAt: 5000, distAt: 0 }));
    expect(rc, 'a stale dist was accepted, so src changes silently would not execute').toBe(1);
    expect(out, 'the failure does not say how to fix it').toMatch(/tsup|rebuild|build/i);
  });

  it('passes when dist is newer than src', () => {
    expect(check(makeRepo({ srcAt: 0, distAt: 5000 })).rc).toBe(0);
  });

  it('names the offending file, so the report is actionable', () => {
    const { out } = check(makeRepo({ srcAt: 5000, distAt: 0 }));
    expect(out).toMatch(/AgentRunner\.ts/);
  });

  it('skips when there is no dist at all — nothing to be stale', () => {
    // A source-only checkout (tsx/dev) is not the failure this guards.
    expect(check(makeRepo({ srcAt: 0, distAt: null })).rc).toBe(0);
  });

  it('is overridable for an operator who knows better', () => {
    expect(check(makeRepo({ srcAt: 5000, distAt: 0 }), { EPAM_SKIP_DIST_CHECK: '1' }).rc).toBe(0);
  });

  it('fails open on a path that is not a repo — never blocks a run on its own error', () => {
    expect(check('/nonexistent/repo').rc).toBe(0);
  });

  it('ignores test files — only shipped source affects the binary', () => {
    const repo = makeRepo({ srcAt: 0, distAt: 1000 });
    const t = join(repo, 'src/agent/thing.test.ts');
    writeFileSync(t, 'x\n');
    utimesSync(t, 1_700_009_999, 1_700_009_999);
    expect(check(repo).rc,
      'a newer test file was treated as un-built source, which would block every run ' +
      'immediately after writing a test')
      .toBe(0);
  });
});

describe('the guard runs before a run starts', () => {
  const orchSrc = require('node:fs').readFileSync(
    join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

  it('the orchestration entrypoint consults it', () => {
    expect(orchSrc, 'nothing verifies the running binary matches the source tree')
      .toMatch(/dist-freshness\.sh|assert_dist_fresh/);
  });
});
