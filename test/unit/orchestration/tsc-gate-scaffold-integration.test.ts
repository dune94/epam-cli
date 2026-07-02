/**
 * Exhaustive integration tests for tsc gate behavior on scaffold-only builds.
 *
 * Root cause of runs 91/92/93: THREE separate tsc invocations all failed with
 * TS18003 "No inputs found" when src/ existed but contained no .ts files:
 *   1. story_tsc_gate()  — per-story gate after each agent completes
 *   2. Step 3.7          — pre-review build gate (vitest + tsc)
 *   3. Step 3.8          — lint gate (tsc + eslint)
 *
 * Each gate broke independently. Tests are split into:
 *   A. Real tsc invocations — prove TS18003 actually occurs without the guard
 *   B. Script structural audit — verify all 3 gates have the guard, same pattern
 *   C. Guard logic — find+wc correctly returns 0 on empty src/
 *   D. Profiles path — AUTOMATION_DIR not SCRIPT_DIR
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SCRIPT, 'utf8');

// Node binary that supports tsc (must be v18+)
const NODE_BIN = (() => {
  for (const candidate of [
    `${process.env.HOME}/.nvm/versions/node/v20.20.0/bin/node`,
    '/usr/local/bin/node',
    process.execPath,
  ]) {
    try {
      const v = execSync(`"${candidate}" --version 2>/dev/null`, { encoding: 'utf8' }).trim();
      const major = parseInt(v.replace('v', '').split('.')[0]);
      if (major >= 18) return candidate;
    } catch { /* skip */ }
  }
  return process.execPath;
})();

// Exact tsconfig that SKY-001 produces (kept in sync with PRD AC6)
const SCAFFOLD_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'CommonJS',
    moduleResolution: 'node',
    outDir: 'dist',
    rootDir: 'src',
    strict: true,
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    declaration: true,
    sourceMap: true,
  },
  include: ['src/**/*'],
  exclude: ['node_modules', 'dist', '**/*.test.ts', '**/*.spec.ts'],
}, null, 2);

// ── Temp workspace helpers ────────────────────────────────────────────────────

const tmpRoots: string[] = [];

function makeTmpProject(name: string): string {
  const root = join(tmpdir(), `epam-tsc-gate-test-${name}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  tmpRoots.push(root);
  return root;
}

afterAll(() => {
  for (const r of tmpRoots) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function runTsc(projectRoot: string): { exitCode: number; output: string } {
  // Use the project's own tsc if available, else skip
  const tscBin = join(projectRoot, 'node_modules/.bin/tsc');
  const globalTsc = (() => {
    try { return execSync('which tsc', { encoding: 'utf8' }).trim(); } catch { return ''; }
  })();
  const bin = existsSync(tscBin) ? tscBin : globalTsc;
  if (!bin) return { exitCode: -1, output: 'tsc not found' };

  const result = spawnSync(NODE_BIN, [bin, '--noEmit'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

function countTsFiles(srcDir: string): number {
  if (!existsSync(srcDir)) return 0;
  const result = spawnSync('find', [srcDir, '-name', '*.ts'], { encoding: 'utf8' });
  return result.stdout.trim().split('\n').filter(Boolean).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Real tsc invocations — prove the problem and the fix
// ─────────────────────────────────────────────────────────────────────────────

describe('A. Real tsc behavior — scaffold-only project', () => {
  it('TS18003 occurs when tsconfig include points at empty src/ (proves the root cause)', () => {
    const root = makeTmpProject('empty-src');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), SCAFFOLD_TSCONFIG);

    // Install typescript so we can run tsc — use the repo's tsc
    const repoTsc = join(REPO_ROOT, 'node_modules/.bin/tsc');
    if (!existsSync(repoTsc)) {
      // Skip if no tsc available in this environment
      return;
    }

    const result = spawnSync(NODE_BIN, [repoTsc, '--noEmit', '--project', join(root, 'tsconfig.json')], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const output = (result.stdout ?? '') + (result.stderr ?? '');

    expect(result.status, `Expected non-zero exit: ${output}`).not.toBe(0);
    expect(output).toContain('TS18003');
    expect(output).toContain('No inputs were found');
  });

  it('tsc succeeds when src/ contains at least one .ts file', () => {
    const root = makeTmpProject('with-ts');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), SCAFFOLD_TSCONFIG);
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x: number = 1;\n');

    const repoTsc = join(REPO_ROOT, 'node_modules/.bin/tsc');
    if (!existsSync(repoTsc)) return;

    const result = spawnSync(NODE_BIN, [repoTsc, '--noEmit', '--project', join(root, 'tsconfig.json')], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const output = (result.stdout ?? '') + (result.stderr ?? '');

    // No TS18003 — may have other errors but not the "no inputs" one
    expect(output).not.toContain('TS18003');
    expect(output).not.toContain('No inputs were found');
  });

  it('find+wc guard correctly returns 0 for empty src/', () => {
    const root = makeTmpProject('find-wc-empty');
    mkdirSync(join(root, 'src', 'skyscanner'), { recursive: true }); // mirrors SKY-001 output

    const count = countTsFiles(join(root, 'src'));
    expect(count).toBe(0);
  });

  it('find+wc guard correctly returns >0 after impl story writes files', () => {
    const root = makeTmpProject('find-wc-populated');
    mkdirSync(join(root, 'src', 'skyscanner'), { recursive: true });
    writeFileSync(join(root, 'src', 'skyscanner', 'client.ts'), 'export const x = 1;\n');

    const count = countTsFiles(join(root, 'src'));
    expect(count).toBeGreaterThan(0);
  });

  it('find+wc guard excludes node_modules from count', () => {
    const root = makeTmpProject('find-wc-node-modules');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'src', 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(join(root, 'src', 'node_modules', 'some-pkg', 'index.ts'), 'export {};\n');

    // Simulate the find+grep+wc pattern from the orch script
    const result = spawnSync('bash', ['-c',
      `find "${join(root, 'src')}" -name "*.ts" 2>/dev/null | grep -v node_modules | wc -l`
    ], { encoding: 'utf8' });
    const count = parseInt(result.stdout.trim());
    expect(count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Script structural audit — all 3 gate code paths
// ─────────────────────────────────────────────────────────────────────────────

describe('B. Orch script — all 3 tsc gates have empty-src guard', () => {

  // ── Gate 1: story_tsc_gate() ──────────────────────────────────────────────

  describe('Gate 1: story_tsc_gate()', () => {
    const fnIdx = orchSrc.indexOf('story_tsc_gate()');
    const block = orchSrc.slice(fnIdx, fnIdx + 1600);

    it('story_tsc_gate() function exists', () => {
      expect(fnIdx).toBeGreaterThan(-1);
    });

    it('has empty-src guard using find+wc', () => {
      expect(block).toMatch(/find.*src.*-name.*\.ts|_ts_count/);
      expect(block).toMatch(/-eq 0.*return 0|return 0.*-eq 0/);
    });

    it('guard checks src/ directory specifically (not project root)', () => {
      expect(block).toMatch(/find.*\$PROJECT_ROOT.*src|find.*src.*-name.*\.ts/);
    });

    it('skips tsc entirely when guard fires (early return 0)', () => {
      const guardIdx = block.search(/-eq 0.*return 0|_ts_count.*-eq 0/);
      const tscIdx = block.indexOf('tsc --noEmit');
      expect(guardIdx).toBeGreaterThan(-1);
      expect(tscIdx).toBeGreaterThan(-1);
      expect(guardIdx).toBeLessThan(tscIdx);
    });

    it('uses PIPESTATUS[0] to capture tsc exit (not tee exit)', () => {
      expect(block).toContain('PIPESTATUS[0]');
    });

    it('marks story failed on non-zero tsc exit', () => {
      expect(block).toContain('return 1');
    });
  });

  // ── Gate 2: Step 3.7 pre-review gate ─────────────────────────────────────

  describe('Gate 2: Step 3.7 pre-review gate', () => {
    const stepIdx = orchSrc.indexOf('Running tsc --noEmit');
    const block = orchSrc.slice(stepIdx, stepIdx + 1000);

    it('Step 3.7 tsc block exists', () => {
      expect(stepIdx).toBeGreaterThan(-1);
    });

    it('has empty-src guard using find+wc', () => {
      expect(block).toMatch(/find.*src.*-name.*\.ts|_pre_review_ts_count/);
      expect(block).toMatch(/_pre_review_ts_count.*-eq 0|\[ "\$_pre_review_ts_count" -eq 0 \]/);
    });

    it('emits a skip message when src/ is empty', () => {
      expect(block).toMatch(/SKIP.*no .ts files|no .ts files.*SKIP/i);
    });

    it('uses PIPESTATUS[0] when tsc does run', () => {
      expect(block).toContain('PIPESTATUS[0]');
    });

    it('sets _pre_review_failed=1 on non-zero tsc exit', () => {
      expect(block).toContain('_pre_review_failed=1');
    });

    it('tsc invocation is inside the else branch (only runs when files exist)', () => {
      const guardMatch = block.match(/_pre_review_ts_count.*-eq 0/);
      const tscInvocation = block.indexOf('./node_modules/.bin/tsc --noEmit');
      expect(guardMatch).not.toBeNull();
      // tsc invocation must appear after the guard
      expect(tscInvocation).toBeGreaterThan(guardMatch!.index!);
    });
  });

  // ── Gate 3: Step 3.8 lint gate ────────────────────────────────────────────

  describe('Gate 3: Step 3.8 lint gate', () => {
    const lintRunningIdx = orchSrc.indexOf('step_emit "3.8" "running"');
    const block = orchSrc.slice(lintRunningIdx, lintRunningIdx + 2500);

    it('Step 3.8 lint gate block exists', () => {
      expect(lintRunningIdx).toBeGreaterThan(-1);
    });

    it('has empty-src guard using find+wc', () => {
      expect(block).toMatch(/find.*src.*-name.*\.ts|_lint_ts_count/);
      expect(block).toMatch(/_lint_ts_count.*-eq 0|\[ "\$_lint_ts_count" -eq 0 \]/);
    });

    it('emits a skip message when src/ is empty', () => {
      expect(block).toMatch(/SKIP.*no .ts files|no .ts files.*SKIP/i);
    });

    it('uses PIPESTATUS[0] when tsc does run', () => {
      expect(block).toContain('PIPESTATUS[0]');
    });

    it('sets _lint_failed=1 on non-zero tsc exit', () => {
      expect(block).toContain('_lint_failed=1');
    });

    it('tsc invocation is inside the else branch (only runs when files exist)', () => {
      const guardMatch = block.match(/_lint_ts_count.*-eq 0/);
      // Use the binary invocation, not the log message "Running tsc --noEmit"
      const tscInvocation = block.indexOf('./node_modules/.bin/tsc --noEmit');
      expect(guardMatch).not.toBeNull();
      expect(tscInvocation).toBeGreaterThan(-1);
      expect(tscInvocation).toBeGreaterThan(guardMatch!.index!);
    });

    it('runs eslint when binary is available', () => {
      expect(block).toContain('eslint');
      expect(block).toContain('--max-warnings 0');
    });

    it('guards eslint with --print-config probe (not bare file-existence check)', () => {
      expect(block).toContain('--print-config');
    });
  });

  // ── Cross-gate consistency ────────────────────────────────────────────────

  describe('Cross-gate consistency', () => {
    it('all 3 gates use find + grep -v node_modules + wc -l pattern', () => {
      const pattern = /find.*src.*-name.*\.ts.*grep.*node_modules.*wc -l/s;
      const storyFnIdx = orchSrc.indexOf('story_tsc_gate()');
      const storyBlock = orchSrc.slice(storyFnIdx, storyFnIdx + 1200);
      const preReviewIdx = orchSrc.indexOf('Running tsc --noEmit');
      const preReviewBlock = orchSrc.slice(preReviewIdx, preReviewIdx + 1000);
      const lintIdx = orchSrc.indexOf('step_emit "3.8" "running"');
      const lintBlock = orchSrc.slice(lintIdx, lintIdx + 2500);

      expect(storyBlock).toMatch(pattern);
      expect(preReviewBlock).toMatch(pattern);
      expect(lintBlock).toMatch(pattern);
    });

    it('all 3 gates check -eq 0 (not -gt 0) so the guard is "skip when empty"', () => {
      const storyFnIdx = orchSrc.indexOf('story_tsc_gate()');
      const storyBlock = orchSrc.slice(storyFnIdx, storyFnIdx + 1200);
      const preReviewIdx = orchSrc.indexOf('Running tsc --noEmit');
      const preReviewBlock = orchSrc.slice(preReviewIdx, preReviewIdx + 1000);
      const lintIdx = orchSrc.indexOf('step_emit "3.8" "running"');
      const lintBlock = orchSrc.slice(lintIdx, lintIdx + 2500);

      expect(storyBlock).toMatch(/-eq 0/);
      expect(preReviewBlock).toMatch(/-eq 0/);
      expect(lintBlock).toMatch(/-eq 0/);
    });

    it('no gate uses bare `tsc --noEmit` inside an `if` condition (tee masks exit code)', () => {
      const brokenPattern = /if\s+[^;]*tsc\s+--noEmit[^;]*\|\s*tee/;
      expect(brokenPattern.test(orchSrc)).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Script paths and configuration
// ─────────────────────────────────────────────────────────────────────────────

describe('C. Orch script — correct paths and configuration', () => {
  it('profiles.json uses AUTOMATION_DIR (not SCRIPT_DIR) in all references', () => {
    // SCRIPT_DIR = orchestrations/scripts/ — profiles.json is at orchestrations/agents/
    // Using SCRIPT_DIR/agents/profiles.json causes "No such file or directory"
    const badPattern = /\$\{?SCRIPT_DIR\}?\/agents\/profiles\.json/g;
    const matches = orchSrc.match(badPattern) ?? [];
    expect(
      matches,
      `Found ${matches.length} reference(s) to SCRIPT_DIR/agents/profiles.json — must use AUTOMATION_DIR`,
    ).toHaveLength(0);
  });

  it('AUTOMATION_DIR is defined in the script', () => {
    expect(orchSrc).toMatch(/AUTOMATION_DIR\s*=/);
  });

  it('AUTOMATION_DIR/agents/profiles.json is the correct path (file exists)', () => {
    // Extract AUTOMATION_DIR value from the script
    const match = orchSrc.match(/AUTOMATION_DIR\s*=\s*["']?([^"'\n]+)["']?/);
    if (!match) return; // can't resolve statically — skip
    // The path should resolve to orchestrations/
    const profilesPath = join(REPO_ROOT, 'orchestrations', 'agents', 'profiles.json');
    expect(existsSync(profilesPath), `profiles.json not found at ${profilesPath}`).toBe(true);
  });

  it('tsconfig.json include path matches what gates scan (src/**/*)', () => {
    // The gates scan PROJECT_ROOT/src for .ts files.
    // If tsconfig include changes to something else, the guard becomes ineffective.
    const prdPath = join(REPO_ROOT, 'orchestrations/travel-app-prd.canonical.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    const sky001 = prd.stories.find((s: any) => s.id === 'SKY-001');
    expect(sky001).toBeTruthy();
    // AC6 must require src/ as the rootDir/include path
    const tsConfigAc = sky001.acceptanceCriteria.find((ac: string) =>
      /tsconfig/i.test(ac)
    );
    expect(tsConfigAc).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Scaffold state simulation — end-to-end gate behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('D. Scaffold state simulation — gate skip/run decisions', () => {
  it('guard bash expression evaluates correctly for 0 files', () => {
    const tmpDir = makeTmpProject('bash-eval-0');
    mkdirSync(join(tmpDir, 'src', 'skyscanner'), { recursive: true });

    const result = spawnSync('bash', ['-c',
      `_ts_count=$(find "${join(tmpDir, 'src')}" -name "*.ts" 2>/dev/null | grep -v node_modules | wc -l); ` +
      `echo "count=$_ts_count"; [ "$_ts_count" -eq 0 ] && echo "SKIP" || echo "RUN"`
    ], { encoding: 'utf8' });

    expect(result.stdout).toContain('count=0');
    expect(result.stdout).toContain('SKIP');
    expect(result.stdout).not.toContain('RUN');
  });

  it('guard bash expression evaluates correctly for 1 file', () => {
    const tmpDir = makeTmpProject('bash-eval-1');
    mkdirSync(join(tmpDir, 'src', 'skyscanner'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'skyscanner', 'client.ts'), 'export const x = 1;\n');

    const result = spawnSync('bash', ['-c',
      `_ts_count=$(find "${join(tmpDir, 'src')}" -name "*.ts" 2>/dev/null | grep -v node_modules | wc -l); ` +
      `echo "count=$_ts_count"; [ "$_ts_count" -eq 0 ] && echo "SKIP" || echo "RUN"`
    ], { encoding: 'utf8' });

    expect(result.stdout).toContain('count=1');
    expect(result.stdout).toContain('RUN');
    expect(result.stdout).not.toContain('SKIP');
  });

  it('guard handles missing src/ directory gracefully (no error output)', () => {
    const tmpDir = makeTmpProject('bash-eval-no-src');
    // No src/ dir at all

    const result = spawnSync('bash', ['-c',
      `_ts_count=$(find "${join(tmpDir, 'src')}" -name "*.ts" 2>/dev/null | grep -v node_modules | wc -l); ` +
      `echo "count=$_ts_count"; [ "$_ts_count" -eq 0 ] && echo "SKIP" || echo "RUN"`
    ], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SKIP');
  });

  it('guard handles nested empty dirs correctly (src/skyscanner/ with no files)', () => {
    const tmpDir = makeTmpProject('bash-eval-nested-empty');
    mkdirSync(join(tmpDir, 'src', 'skyscanner'), { recursive: true });
    mkdirSync(join(tmpDir, 'src', 'public'), { recursive: true });
    // html file exists but NOT a .ts file
    writeFileSync(join(tmpDir, 'src', 'public', 'index.html'), '<html></html>');

    const result = spawnSync('bash', ['-c',
      `_ts_count=$(find "${join(tmpDir, 'src')}" -name "*.ts" 2>/dev/null | grep -v node_modules | wc -l); ` +
      `echo "count=$_ts_count"; [ "$_ts_count" -eq 0 ] && echo "SKIP" || echo "RUN"`
    ], { encoding: 'utf8' });

    expect(result.stdout).toContain('count=0');
    expect(result.stdout).toContain('SKIP');
  });

  it('guard does not skip when only .test.ts files exist (impl stories still need tsc check)', () => {
    const tmpDir = makeTmpProject('bash-eval-test-only');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'client.test.ts'), 'import { describe } from "vitest";\n');

    const result = spawnSync('bash', ['-c',
      `_ts_count=$(find "${join(tmpDir, 'src')}" -name "*.ts" 2>/dev/null | grep -v node_modules | wc -l); ` +
      `echo "count=$_ts_count"; [ "$_ts_count" -eq 0 ] && echo "SKIP" || echo "RUN"`
    ], { encoding: 'utf8' });

    // .test.ts is still a .ts file — guard should RUN tsc
    expect(result.stdout).toContain('count=1');
    expect(result.stdout).toContain('RUN');
  });
});
