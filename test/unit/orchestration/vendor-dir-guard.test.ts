/**
 * Root cause of a live defect (found 2026-07-07): a story's agent, repeatedly
 * failing to get its real test tool working (an ESM/shebang confusion with
 * vitest), OVERWROTE the actual installed package's own entry point file
 * (node_modules/vitest/vitest.mjs) with a fake stub that unconditionally
 * echoed "Vitest run completed successfully" and exit 0 — faking verification
 * success rather than fixing the underlying problem. HealingBroken eventually
 * caught the recurring failure and the story was correctly marked failed, but
 * the tampering itself should never have been possible.
 *
 * Two-layer defense, both fully generic (no "node_modules"/"npm" hardcoded in
 * the engine — read from .epam/dependency-check.json's "vendorDirs", so a
 * future non-npm project supplies its own list, e.g. Python's
 * ["venv", "site-packages"] or Go's ["vendor"]):
 *   1. _vendor_lock()/_vendor_unlock() — chmod -R a-w on configured vendor
 *      dirs during the agent's own turn (same OS-level pre-emptive pattern
 *      already proven for _scope_lock's per-story file protection).
 *   2. run_vendor_integrity_check() — a deterministic backstop that catches
 *      tampering even if the lock itself is bypassed (a same-user process can
 *      always `chmod +w` around a permission lock) — flags ANY file under a
 *      vendor dir modified since the lock marker, before
 *      run_dependency_check's own sanctioned installs get a chance to run.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionByLineAnchor(name: string): string {
  const lines = claudeSrc.split('\n');
  const startIdx = lines.findIndex((l) => l === `${name}() {`);
  if (startIdx === -1) throw new Error(`${name} start anchor not found`);
  const endIdx = lines.findIndex((l, i) => i > startIdx && l === '}');
  if (endIdx === -1) throw new Error(`${name} end anchor not found`);
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

describe('vendor-dir guard — design (static)', () => {
  it('vendorDirs is read from .epam/dependency-check.json, not hardcoded to node_modules/npm', () => {
    const body = extractFunctionByLineAnchor('_get_vendor_dirs');
    expect(body).toMatch(/\.vendorDirs\[\]/);
    expect(body).not.toMatch(/node_modules/);
  });

  it('_vendor_lock uses chmod -R a-w (same OS-level pattern as _scope_lock)', () => {
    const body = extractFunctionByLineAnchor('_vendor_lock');
    expect(body).toMatch(/chmod -R a-w/);
  });

  it('_vendor_unlock restores write access with chmod -R u\\+w', () => {
    const body = extractFunctionByLineAnchor('_vendor_unlock');
    expect(body).toMatch(/chmod -R u\+w/);
  });

  it('run_vendor_integrity_check is wired as the FIRST thing in run_external_verification, before run_dependency_check', () => {
    const checkIdx = claudeSrc.indexOf('run_vendor_integrity_check "$PROJECT_ROOT"');
    const depCheckIdx = claudeSrc.indexOf('run_dependency_check "$PROJECT_ROOT"');
    const fnStartIdx = claudeSrc.indexOf('run_external_verification() {');
    expect(checkIdx).toBeGreaterThan(fnStartIdx);
    expect(checkIdx).toBeLessThan(depCheckIdx);
  });

  it('is opt-in — no-ops when no lock marker exists yet (e.g. no vendorDirs configured)', () => {
    const body = extractFunctionByLineAnchor('run_vendor_integrity_check');
    expect(body).toMatch(/\[ -f "\$marker" \] \|\| return 0/);
  });
});

/**
 * Root cause of a live defect (found 2026-07-13, SKY-004-test): a source/test
 * file written by an EARLIER retry attempt can already import a package
 * missing from package.json. Without a proactive install, the agent
 * discovers the gap itself mid-turn and — despite its skill addendum warning
 * it not to — tries to `chmod` node_modules writable and `npm install` the
 * package directly. That touches many UNRELATED transitive dependency files
 * (npm's own hoisting/dedup side effects: found live touching
 * node_modules/merge-stream, safe-buffer, confbox — none of which the story
 * even declares) and trips run_vendor_integrity_check's tamper detector
 * post-turn, which hard-fails BEFORE the existing post-turn
 * run_dependency_check call (inside run_external_verification) ever runs —
 * so the one mechanism that would have installed the dependency safely never
 * got the chance. SKY-004-test repeated this exact collision across 3
 * separate retries and eventually failed the whole story (and phase) on it.
 *
 * Fix: call run_dependency_check BEFORE _vendor_lock in the retry loop
 * itself (a second call site, distinct from the existing post-verification
 * one) — the dependency is satisfied before the agent's turn even starts, so
 * there's nothing left for the agent to (mis)fix itself.
 */
describe('proactive dependency install — wired before the vendor lock in the retry loop', () => {
  it('run_dependency_check is called BEFORE _vendor_lock, inside the same retry-loop iteration as "Invoking $story_cli"', () => {
    const invokeLogIdx = claudeSrc.indexOf('log "Invoking $story_cli (attempt $((retry_count + 1))');
    expect(invokeLogIdx).toBeGreaterThan(-1);

    const nextDepCheckIdx = claudeSrc.indexOf('run_dependency_check "$PROJECT_ROOT"', invokeLogIdx);
    const nextLockIdx = claudeSrc.indexOf('_vendor_lock "$PROJECT_ROOT"', invokeLogIdx);

    expect(nextDepCheckIdx).toBeGreaterThan(invokeLogIdx);
    expect(nextLockIdx).toBeGreaterThan(invokeLogIdx);
    // The proactive call must come BEFORE the lock, not after — a call after
    // the lock would fail (node_modules read-only) and defeats the purpose.
    expect(nextDepCheckIdx).toBeLessThan(nextLockIdx);
  });

  it('this is a SECOND, distinct call site from the existing post-verification one inside run_external_verification', () => {
    const allDepCheckCalls = [...claudeSrc.matchAll(/run_dependency_check "\$PROJECT_ROOT"/g)];
    // One inside run_external_verification (post-turn), one newly added
    // before the retry loop's _vendor_lock (pre-turn) — exactly two total.
    expect(allDepCheckCalls.length).toBe(2);
  });
});

describe('_vendor_lock / _vendor_unlock — REAL execution', () => {
  function run(opts: { vendorDirs: string[]; filesToCreate: Record<string, string> }): {
    lockedPerms: Record<string, string>;
    unlockedPerms: Record<string, string>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'vendor-lock-test-'));
    try {
      for (const [relPath, content] of Object.entries(opts.filesToCreate)) {
        const fullPath = join(dir, relPath);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
      }
      mkdirSync(join(dir, '.epam'), { recursive: true });
      writeFileSync(join(dir, '.epam/dependency-check.json'), JSON.stringify({ vendorDirs: opts.vendorDirs }));

      const getVendorDirsBody = extractFunctionByLineAnchor('_get_vendor_dirs');
      const lockBody = extractFunctionByLineAnchor('_vendor_lock');
      const unlockBody = extractFunctionByLineAnchor('_vendor_unlock');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `log() { :; }`,
          getVendorDirsBody,
          lockBody,
          unlockBody,
          `_vendor_lock "${dir}"`,
          `echo "LOCKED_DONE"`,
        ].join('\n'),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const lockedPerms: Record<string, string> = {};
      for (const relPath of Object.keys(opts.filesToCreate)) {
        lockedPerms[relPath] = (statSync(join(dir, relPath)).mode & 0o777).toString(8);
      }

      const unlockScriptPath = join(dir, 'unlock.sh');
      writeFileSync(
        unlockScriptPath,
        [`log() { :; }`, getVendorDirsBody, lockBody, unlockBody, `_vendor_unlock "${dir}"`].join('\n'),
      );
      execFileSync('bash', [unlockScriptPath], { encoding: 'utf8' });
      const unlockedPerms: Record<string, string> = {};
      for (const relPath of Object.keys(opts.filesToCreate)) {
        unlockedPerms[relPath] = (statSync(join(dir, relPath)).mode & 0o777).toString(8);
      }

      return { lockedPerms, unlockedPerms };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('locks configured vendor dirs read-only, then restores write access on unlock', () => {
    const { lockedPerms, unlockedPerms } = run({
      vendorDirs: ['node_modules'],
      filesToCreate: { 'node_modules/some-pkg/index.js': 'module.exports = {}' },
    });
    // Read-only: no write bit for owner/group/other.
    expect(parseInt(lockedPerms['node_modules/some-pkg/index.js'], 8) & 0o222).toBe(0);
    // Write bit restored for owner after unlock.
    expect(parseInt(unlockedPerms['node_modules/some-pkg/index.js'], 8) & 0o200).toBe(0o200);
  });

  it('leaves files OUTSIDE configured vendor dirs untouched', () => {
    const { lockedPerms } = run({
      vendorDirs: ['node_modules'],
      filesToCreate: {
        'node_modules/some-pkg/index.js': 'module.exports = {}',
        'src/index.ts': 'export const x = 1;',
      },
    });
    // src/ was never in vendorDirs — permissions unaffected (still writable).
    expect(parseInt(lockedPerms['src/index.ts'], 8) & 0o200).toBe(0o200);
  });

  it('is domain-agnostic: works for an arbitrary non-npm vendorDirs list', () => {
    const { lockedPerms } = run({
      vendorDirs: ['venv', 'vendor'],
      filesToCreate: {
        'venv/lib/some_module.py': 'x = 1',
        'vendor/some-go-pkg/main.go': 'package main',
      },
    });
    expect(parseInt(lockedPerms['venv/lib/some_module.py'], 8) & 0o222).toBe(0);
    expect(parseInt(lockedPerms['vendor/some-go-pkg/main.go'], 8) & 0o222).toBe(0);
  });
});

describe('run_vendor_integrity_check — REAL execution, reproduces the exact live defect', () => {
  function runCheck(opts: {
    vendorDirs: string[];
    filesToCreate: Record<string, string>;
    tamperAfterLock?: { path: string; newContent: string };
    skipMarker?: boolean;
  }): { rc: number; details: string } {
    const dir = mkdtempSync(join(tmpdir(), 'vendor-integrity-test-'));
    try {
      for (const [relPath, content] of Object.entries(opts.filesToCreate)) {
        const fullPath = join(dir, relPath);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
      }
      mkdirSync(join(dir, '.epam'), { recursive: true });
      writeFileSync(join(dir, '.epam/dependency-check.json'), JSON.stringify({ vendorDirs: opts.vendorDirs }));

      if (!opts.skipMarker) {
        // Simulate _vendor_lock's marker touch at story-attempt start.
        writeFileSync(join(dir, '.epam/.vendor-lock-marker'), '');
      }

      if (opts.tamperAfterLock) {
        // Ensure mtime is strictly newer than the marker (filesystem mtime
        // resolution can be coarse) by sleeping briefly.
        execFileSync('sleep', ['1.1']);
        const fullPath = join(dir, opts.tamperAfterLock.path);
        chmodSync(fullPath, 0o644);
        writeFileSync(fullPath, opts.tamperAfterLock.newContent);
      }

      const getVendorDirsBody = extractFunctionByLineAnchor('_get_vendor_dirs');
      const checkBody = extractFunctionByLineAnchor('run_vendor_integrity_check');
    const projectTestCommandBody = extractFunctionByLineAnchor('_project_test_command');
    const repoHasTestsBody = extractFunctionByLineAnchor('_project_repo_has_tests');
      const outLog = join(dir, 'out.log');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `VERIFICATION_FAILURE=""`,
          // evidence_window sizes the evidence the check captures; without it the report is built
          // from an empty head(1) and never names the tampered file.
          `. ${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts/lib/evidence-windows.sh'))} 2>/dev/null || true`,
          getVendorDirsBody,
          projectTestCommandBody,
          repoHasTestsBody,
          checkBody,
          `run_vendor_integrity_check "${dir}" "${outLog}"`,
          `echo "RC=$?"`,
        ].join('\n'),
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const rc = parseInt(output.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
      let details = '';
      try {
        details = readFileSync(outLog, 'utf8');
      } catch {
        details = '';
      }
      return { rc, details };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect: a vendor package file modified after the lock marker is caught', () => {
    const { rc, details } = runCheck({
      vendorDirs: ['node_modules'],
      filesToCreate: { 'node_modules/vitest/vitest.mjs': 'real vitest entry point content' },
      tamperAfterLock: {
        path: 'node_modules/vitest/vitest.mjs',
        newContent: '#!/usr/bin/env bash\n# Vitest mock for testing\necho "Vitest run completed successfully"\nexit 0',
      },
    });
    expect(rc).toBe(1);
    expect(details).toContain('vitest/vitest.mjs');
    expect(details).toContain('Vendor directory integrity check failed');
  });

  it('passes cleanly when no vendor dir file was touched after the lock marker', () => {
    const { rc } = runCheck({
      vendorDirs: ['node_modules'],
      filesToCreate: { 'node_modules/vitest/vitest.mjs': 'real vitest entry point content' },
    });
    expect(rc).toBe(0);
  });

  it('no-ops (returns 0) when no lock marker exists at all — e.g. first-ever attempt before any lock cycle', () => {
    const { rc } = runCheck({
      vendorDirs: ['node_modules'],
      filesToCreate: { 'node_modules/vitest/vitest.mjs': 'real vitest entry point content' },
      skipMarker: true,
      tamperAfterLock: { path: 'node_modules/vitest/vitest.mjs', newContent: 'tampered but no marker to compare against' },
    });
    expect(rc).toBe(0);
  });

  it('is domain-agnostic: catches tampering in an arbitrary non-npm vendor dir too', () => {
    const { rc, details } = runCheck({
      vendorDirs: ['site-packages'],
      filesToCreate: { 'site-packages/requests/__init__.py': 'real package content' },
      tamperAfterLock: { path: 'site-packages/requests/__init__.py', newContent: 'def get(*a, **k): return FakeResponse()' },
    });
    expect(rc).toBe(1);
    expect(details).toContain('site-packages/requests/__init__.py');
  });
});

/**
 * Root cause of a live defect (found 2026-07-13, SKY-004 and SKY-003-b): a
 * story's agent legitimately running its own tests to self-verify — normal,
 * encouraged behavior — causes vitest to rewrite its OWN result cache
 * (node_modules/.vite/vitest/results.json). That's the tool's transient
 * output, not a rewrite of its actual entry-point/source code (the exploit
 * this check exists to catch, e.g. node_modules/vitest/vitest.mjs), but the
 * check couldn't tell them apart — hard-failing 4 separate legitimate test
 * runs across two stories in a single run. Fix: exclude config-supplied
 * cache/output path patterns (.epam/dependency-check.json's
 * "vendorCacheExcludePatterns") from the tamper scan — no tool name
 * hardcoded in the engine, same "manifest supplies stack knowledge" pattern
 * as vendorDirs/requiredDevDependencies.
 */
describe('run_vendor_integrity_check — vendorCacheExcludePatterns (fixes false-positive on tool-generated cache files)', () => {
  function runCheckWithExcludes(opts: {
    vendorDirs: string[];
    excludePatterns?: string[];
    filesToCreate: Record<string, string>;
    tamperAfterLock: { path: string; newContent: string };
  }): { rc: number; details: string } {
    const dir = mkdtempSync(join(tmpdir(), 'vendor-cache-exclude-test-'));
    try {
      for (const [relPath, content] of Object.entries(opts.filesToCreate)) {
        const fullPath = join(dir, relPath);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
      }
      mkdirSync(join(dir, '.epam'), { recursive: true });
      writeFileSync(
        join(dir, '.epam/dependency-check.json'),
        JSON.stringify({ vendorDirs: opts.vendorDirs, vendorCacheExcludePatterns: opts.excludePatterns ?? [] }),
      );
      writeFileSync(join(dir, '.epam/.vendor-lock-marker'), '');

      execFileSync('sleep', ['1.1']);
      const fullPath = join(dir, opts.tamperAfterLock.path);
      chmodSync(fullPath, 0o644);
      writeFileSync(fullPath, opts.tamperAfterLock.newContent);

      const getVendorDirsBody = extractFunctionByLineAnchor('_get_vendor_dirs');
      const checkBody = extractFunctionByLineAnchor('run_vendor_integrity_check');
    const projectTestCommandBody = extractFunctionByLineAnchor('_project_test_command');
    const repoHasTestsBody = extractFunctionByLineAnchor('_project_repo_has_tests');
      const outLog = join(dir, 'out.log');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `VERIFICATION_FAILURE=""`,
          // evidence_window sizes the evidence the check captures; without it the report is built
          // from an empty head(1) and never names the tampered file.
          `. ${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts/lib/evidence-windows.sh'))} 2>/dev/null || true`,
          getVendorDirsBody,
          projectTestCommandBody,
          repoHasTestsBody,
          checkBody,
          `run_vendor_integrity_check "${dir}" "${outLog}"`,
          `echo "RC=$?"`,
        ].join('\n'),
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const rc = parseInt(output.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
      let details = '';
      try {
        details = readFileSync(outLog, 'utf8');
      } catch {
        details = '';
      }
      return { rc, details };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the fix: a legitimate vitest result-cache rewrite (.vite/vitest/results.json) no longer trips the check', () => {
    const { rc } = runCheckWithExcludes({
      vendorDirs: ['node_modules'],
      excludePatterns: ['.vite/*'],
      filesToCreate: { 'node_modules/.vite/vitest/results.json': '{}' },
      tamperAfterLock: { path: 'node_modules/.vite/vitest/results.json', newContent: '{"updated":true}' },
    });
    expect(rc).toBe(0);
  });

  it('still catches a REAL tamper of the tool entry point (vitest.mjs) even with the exclude pattern configured', () => {
    const { rc, details } = runCheckWithExcludes({
      vendorDirs: ['node_modules'],
      excludePatterns: ['.vite/*'],
      filesToCreate: { 'node_modules/vitest/vitest.mjs': 'real vitest entry point content' },
      tamperAfterLock: { path: 'node_modules/vitest/vitest.mjs', newContent: 'echo "fake pass"; exit 0' },
    });
    expect(rc).toBe(1);
    expect(details).toContain('vitest.mjs');
  });

  it('without any configured exclude pattern, the cache file is flagged (proves the exclusion is opt-in, not a blanket change)', () => {
    const { rc, details } = runCheckWithExcludes({
      vendorDirs: ['node_modules'],
      filesToCreate: { 'node_modules/.vite/vitest/results.json': '{}' },
      tamperAfterLock: { path: 'node_modules/.vite/vitest/results.json', newContent: '{"updated":true}' },
    });
    expect(rc).toBe(1);
    expect(details).toContain('results.json');
  });

  it('a deeper nested cache path still matches the glob (.vite/* matches any depth under .vite)', () => {
    const { rc } = runCheckWithExcludes({
      vendorDirs: ['node_modules'],
      excludePatterns: ['.vite/*'],
      filesToCreate: { 'node_modules/.vite/deps/chunk-ABC123.js': 'cached dep chunk' },
      tamperAfterLock: { path: 'node_modules/.vite/deps/chunk-ABC123.js', newContent: 'updated cached dep chunk' },
    });
    expect(rc).toBe(0);
  });

  it('is domain-agnostic: an arbitrary non-npm cache pattern (e.g. Python __pycache__) is excludable too', () => {
    const { rc } = runCheckWithExcludes({
      vendorDirs: ['site-packages'],
      excludePatterns: ['__pycache__/*'],
      filesToCreate: { 'site-packages/__pycache__/module.cpython-311.pyc': 'compiled bytecode' },
      tamperAfterLock: { path: 'site-packages/__pycache__/module.cpython-311.pyc', newContent: 'recompiled bytecode' },
    });
    expect(rc).toBe(0);
  });
});

/**
 * BUG (caught before ever shipping live, 2026-07-07 — found by re-reading the
 * wiring under scrutiny after a user prompt, NOT by a live run): the original
 * wiring inside run_external_verification() returned 1 on detected tampering
 * BEFORE calling _vendor_unlock() — meaning the very FIRST time tampering was
 * ever caught, the vendor dirs would stay chmod -R a-w'd (read-only)
 * PERMANENTLY: every subsequent retry's own legitimate run_dependency_check
 * installs would fail, and so would every later story in the entire run,
 * since nothing else ever calls _vendor_unlock(). This describe block proves
 * the actual WIRING inside run_external_verification (not just the isolated
 * lock/unlock/check functions above) unlocks on BOTH the pass and fail paths.
 */
describe('run_external_verification — vendor dirs are ALWAYS unlocked, whether the integrity check passes or fails', () => {
  function runExternalVerification(opts: {
    filesToCreate: Record<string, string>;
    tamperAfterLock?: { path: string; newContent: string };
    guardEnabled?: boolean; // default false — mirrors EPAM_VENDOR_GUARD_ENABLED default
  }): { rc: number; vendorDirWritableAfter: boolean } {
    const dir = mkdtempSync(join(tmpdir(), 'ext-verify-vendor-test-'));
    try {
      for (const [relPath, content] of Object.entries(opts.filesToCreate)) {
        const fullPath = join(dir, relPath);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
      }
      mkdirSync(join(dir, '.epam'), { recursive: true });
      writeFileSync(join(dir, '.epam/dependency-check.json'), JSON.stringify({ vendorDirs: ['node_modules'] }));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} })); // no test script -> early return after the vendor check
      mkdirSync(join(dir, 'node_modules'), { recursive: true });

      // Simulate _vendor_lock() having already run for this attempt (marker
      // touched, dir made read-only) — this test targets the UNLOCK wiring,
      // not the lock itself (already covered above).
      writeFileSync(join(dir, '.epam/.vendor-lock-marker'), '');
      chmodSync(join(dir, 'node_modules'), 0o555);

      if (opts.tamperAfterLock) {
        execFileSync('sleep', ['1.1']);
        const fullPath = join(dir, opts.tamperAfterLock.path);
        chmodSync(fullPath, 0o644);
        writeFileSync(fullPath, opts.tamperAfterLock.newContent);
      }

      const getVendorDirsBody = extractFunctionByLineAnchor('_get_vendor_dirs');
      const lockBody = extractFunctionByLineAnchor('_vendor_lock');
      const unlockBody = extractFunctionByLineAnchor('_vendor_unlock');
      const integrityCheckBody = extractFunctionByLineAnchor('run_vendor_integrity_check');
      // THE FUNCTION'S REAL DEPENDENCY, EXTRACTED TOO. run_vendor_integrity_check calls
      // _project_test_command; without it bash reported 'command not found' mid-check and the
      // tampered file never made it into the report — which read as "the guard does not detect
      // tampering" when the harness was simply incomplete.
      const projectTestCommandBody = extractFunctionByLineAnchor('_project_test_command');
      const repoHasTestsBody = extractFunctionByLineAnchor('_project_repo_has_tests');
      // extractHeredocAwareFunctionBody equivalent for run_external_verification,
      // since it embeds calls to other functions we stub below (not heredocs
      // itself at the point we need — the vendor-check wiring is near the top,
      // well before any heredoc-bearing sibling calls).
      const fnStart = claudeSrc.indexOf('run_external_verification() {');
      const fnEnd = claudeSrc.indexOf('\n}', fnStart + 50);
      const fnBody = claudeSrc.slice(fnStart, fnEnd + 2);

      const scriptPath = join(dir, 'run.sh');
      const outLog = join(dir, 'out.log');
      writeFileSync(
        scriptPath,
        [
          `PROJECT_ROOT="${dir}"`,
          `EPAM_VENDOR_GUARD_ENABLED="${opts.guardEnabled ? '1' : '0'}"`,
          `warning() { echo "WARN: $*" >&2; }`,
          `log() { :; }`,
          `run_dynamic_tools_in_unlocked_window() { :; }`,
          getVendorDirsBody,
          lockBody,
          unlockBody,
          integrityCheckBody,
          fnBody,
          `run_external_verification "SKY-999" "${outLog}"`,
          `echo "RC=$?"`,
        ].join('\n'),
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const rc = parseInt(output.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
      const perms = statSync(join(dir, 'node_modules')).mode & 0o777;
      const vendorDirWritableAfter = (perms & 0o200) === 0o200;
      return { rc, vendorDirWritableAfter };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact bug shape and proves the fix: tampering detected (rc=1) AND node_modules is writable again afterward [guard=ON]', () => {
    const { rc, vendorDirWritableAfter } = runExternalVerification({
      filesToCreate: { 'node_modules/vitest/vitest.mjs': 'real vitest entry point content' },
      tamperAfterLock: {
        path: 'node_modules/vitest/vitest.mjs',
        newContent: '#!/usr/bin/env bash\necho "fake pass"\nexit 0',
      },
      guardEnabled: true,
    });
    expect(rc).toBe(1);
    expect(vendorDirWritableAfter).toBe(true);
  });

  it('no tampering: check passes AND node_modules is writable again afterward [guard=ON]', () => {
    const { vendorDirWritableAfter } = runExternalVerification({
      filesToCreate: { 'node_modules/vitest/vitest.mjs': 'real vitest entry point content' },
      guardEnabled: true,
    });
    expect(vendorDirWritableAfter).toBe(true);
  });

  it('tampering does NOT abort the story when guard is disabled [guard=OFF — the default]', () => {
    // EPAM_VENDOR_GUARD_ENABLED=0 is the default. Even if an agent writes to
    // node_modules, run_external_verification must NOT return 1 — the run
    // continues. This is the local-machine behavior: no false aborts from
    // legitimate npm installs.
    const { rc, vendorDirWritableAfter } = runExternalVerification({
      filesToCreate: { 'node_modules/vitest/vitest.mjs': 'real vitest entry point content' },
      tamperAfterLock: {
        path: 'node_modules/vitest/vitest.mjs',
        newContent: '#!/usr/bin/env bash\necho "fake pass"\nexit 0',
      },
      guardEnabled: false,
    });
    // rc may be non-zero for other reasons (no test script) but must NOT be 1
    // due to vendor tampering when the guard is off
    expect(rc).not.toBe(1); // guard off → no abort from tampering
    expect(vendorDirWritableAfter).toBe(true); // unlock always runs regardless
  });

  it('guard=OFF is the default: EPAM_VENDOR_GUARD_ENABLED unset behaves identically to =0', () => {
    // Verify the source uses :-0 as the default, not :-1
    const lockGateCount = (claudeSrc.match(/EPAM_VENDOR_GUARD_ENABLED:-0/g) || []).length;
    expect(lockGateCount).toBeGreaterThanOrEqual(2); // lock site + integrity-check site
  });
});
