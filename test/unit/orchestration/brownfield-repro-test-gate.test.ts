/**
 * brownfield-repro-test-gate.sh — the hard "test must reproduce the bug" gate
 * (step 5 of the AC/VC/TC design, 2026-07-24).
 *
 * A brownfield fix must ship a test that FAILS on the pre-fix baseline and PASSES
 * with the fix. Real git repos + a stub test runner (node_modules/.bin/vitest)
 * whose pass/fail depends on whether the fix is present in the working tree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GATE = join(__dirname, '../../../orchestrations/scripts/brownfield-repro-test-gate.sh');
let repo: string;
const git = (a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

// Stub runner: passes (exit 0) iff `src/` contains the marker written to .stubmode.
// 'FIXED' → passes only when the fix is present; 'always' → passes regardless.
function writeStub(mode: 'fix-dependent' | 'always-pass') {
  const bin = join(repo, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  // fix-dependent: pass iff the IMPL file (src/x.ts) carries the fix marker —
  // simulates a real test that passes only when the implementation is fixed.
  const script = mode === 'always-pass'
    ? '#!/usr/bin/env bash\nexit 0\n'
    : '#!/usr/bin/env bash\ngrep -q FIXED src/x.ts 2>/dev/null && exit 0 || exit 1\n';
  writeFileSync(join(bin, 'vitest'), script);
  chmodSync(join(bin, 'vitest'), 0o755);
}

function runGate(story = 'X'): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [GATE, story], {
      encoding: 'utf8',
      env: { ...process.env, PROJECT_ROOT: repo, JIRA_BASELINE_BRANCH: 'develop' },
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'repro-gate-'));
  git(['init', '-q', '-b', 'develop']);
  git(['config', 'user.email', 't@t.t']); git(['config', 'user.name', 't']);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n'); // matches a real repo — the stub runner is never committed
  // THE MANIFEST BELONGS TO THE BASELINE, as it does in any real repository. The gate used to
  // probe node_modules/.bin/vitest by name, so this fixture supplied only the binary — which meant
  // it also asserted the gate would run against a directory that is not a Node project at all.
  // The gate now asks lib/ecosystem-registry.js what THIS codeline's test command is, and step 4 reverts
  // the fix files before re-running: a manifest committed as part of the FIX would be reverted
  // away, and the pre-fix run would fail for want of a manifest rather than for want of the fix.
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'fixture', scripts: { test: './node_modules/.bin/vitest' },
  }) + '\n');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'x.ts'), 'export const v = "buggy code";\n'); // no FIXED
  git(['add', '-A']); git(['commit', '-q', '-m', 'baseline (bug)']);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('brownfield-repro-test-gate', () => {
  it('PASSES when the fix + a test that reproduces the bug are present', () => {
    writeStub('fix-dependent');
    git(['checkout', '-q', '-b', 'AI-X']);
    writeFileSync(join(repo, 'src', 'x.ts'), 'export const v = "FIXED";\n');       // the fix
    writeFileSync(join(repo, 'src', 'x.test.ts'), 'assert v === FIXED\n');         // the test
    git(['add', '-A']); git(['commit', '-q', '-m', 'X: story complete']);
    const r = runGate();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/reproduces the bug/);
  });

  it('BLOCKS when the change ships NO test', () => {
    writeStub('fix-dependent');
    git(['checkout', '-q', '-b', 'AI-X']);
    writeFileSync(join(repo, 'src', 'x.ts'), 'export const v = "FIXED";\n');       // fix only, no test
    git(['add', '-A']); git(['commit', '-q', '-m', 'X: story complete (no test)']);
    const r = runGate();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no test file accompanies the change/);
  });

  it('BLOCKS when the test PASSES even without the fix (does not reproduce)', () => {
    writeStub('always-pass'); // test passes regardless of the fix
    git(['checkout', '-q', '-b', 'AI-X']);
    writeFileSync(join(repo, 'src', 'x.ts'), 'export const v = "FIXED";\n');
    writeFileSync(join(repo, 'src', 'x.test.ts'), 'always passes\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'X: story complete (weak test)']);
    const r = runGate();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/do NOT reproduce the bug/);
  });

  it('restores the fix after the check (working tree left intact)', () => {
    writeStub('fix-dependent');
    git(['checkout', '-q', '-b', 'AI-X']);
    writeFileSync(join(repo, 'src', 'x.ts'), 'export const v = "FIXED";\n');
    writeFileSync(join(repo, 'src', 'x.test.ts'), 'assert v === FIXED\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'X: story complete']);
    runGate();
    expect(git(['status', '--porcelain'])).toBe(''); // fix restored, tree clean
    expect(execFileSync('grep', ['-q', 'FIXED', join(repo, 'src', 'x.ts')], { encoding: 'utf8' })).toBeDefined();
  });

  it('skips cleanly with EPAM_SKIP_REPRO_GATE=1', () => {
    const out = execFileSync('bash', [GATE, 'X'], {
      encoding: 'utf8',
      env: { ...process.env, PROJECT_ROOT: repo, JIRA_BASELINE_BRANCH: 'develop', EPAM_SKIP_REPRO_GATE: '1' },
    });
    expect(out).toMatch(/skipping reproduction gate/);
  });
});
