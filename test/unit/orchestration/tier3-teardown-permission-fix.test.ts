/**
 * tier3-travel-app-run.sh's teardown step must chmod the output directory
 * writable before rm -rf, so a leftover non-writable node_modules tree from
 * a prior run's npm install can never block a fresh teardown.
 *
 * Root cause this fixes (found live, 2026-07-11/12, tier3-travel-app
 * relaunches, recurred a second time on 2026-07-12): npm install leaves
 * some node_modules files/directories non-writable (0444/0555). Deleting a
 * file requires WRITE permission on its CONTAINING directory, not just file
 * ownership — so `rm -rf "$OUTPUT_DIR"` failed outright with a wall of
 * "Permission denied" errors, silently leaving the teardown incomplete
 * (no `set -e` gate on that line) instead of tearing down cleanly, on two
 * separate relaunch attempts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const TIER3_SH = join(REPO_ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh');
const tier3Src = readFileSync(TIER3_SH, 'utf8');

describe('tier3-travel-app-run.sh teardown — chmod before rm -rf (static)', () => {
  it('chmods the output directory writable before the teardown rm -rf', () => {
    const idx = tier3Src.indexOf('Tearing down output directory');
    expect(idx).toBeGreaterThan(-1);
    const before = tier3Src.slice(Math.max(0, idx - 400), idx);
    expect(before).toMatch(/chmod -R u\+w "\$OUTPUT_DIR"/);
  });

  it('also chmods leftover sibling worktree dirs before removing them', () => {
    const idx = tier3Src.indexOf('Removed leftover worktree');
    expect(idx).toBeGreaterThan(-1);
    const block = tier3Src.slice(Math.max(0, idx - 300), idx + 50);
    expect(block).toMatch(/chmod -R u\+w "\$_wt_dir"/);
  });
});

describe('tier3-travel-app-run.sh teardown — REAL execution: a non-writable leftover directory does not block teardown', () => {
  it('REPRODUCES the exact live defect and proves the fix: rm -rf succeeds even with a 0555 leftover subdirectory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tier3-teardown-perm-'));
    const outputDir = join(dir, 'output-app');
    try {
      // Simulate npm install leaving a non-writable package directory.
      const pkgDir = join(outputDir, 'node_modules', 'some-pkg');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};');
      chmodSync(pkgDir, 0o555); // read+execute only, no write — blocks unlink of files inside

      // Extract just the teardown block (chmod + rm -rf) and run it against
      // our simulated leftover directory, exactly as tier3's own script does.
      const idx = tier3Src.indexOf('# Tear down the entire output directory');
      const endIdx = tier3Src.indexOf('mkdir -p "$OUTPUT_DIR"', idx);
      const teardownBlock = tier3Src.slice(idx, endIdx);

      const script = `#!/usr/bin/env bash\nOUTPUT_DIR=${JSON.stringify(outputDir)}\ninfo() { echo "INFO: $*"; }\n${teardownBlock}\n`;
      const scriptPath = join(dir, 'teardown.sh');
      writeFileSync(scriptPath, script);

      execFileSync('bash', [scriptPath], { encoding: 'utf8' });

      // The whole tree (including the deliberately-locked-down subdirectory)
      // must be gone — proves chmod ran before rm -rf, not that rm silently
      // partially succeeded.
      expect(existsSync(pkgDir)).toBe(false);
      expect(existsSync(outputDir)).toBe(false);
    } finally {
      // Restore write perms in case the (unfixed) code path left the locked
      // directory behind, so cleanup itself doesn't fail.
      try {
        chmodSync(join(outputDir, 'node_modules', 'some-pkg'), 0o755);
      } catch {
        /* already gone or never created */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
