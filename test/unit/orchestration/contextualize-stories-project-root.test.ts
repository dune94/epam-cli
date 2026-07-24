/**
 * contextualize-stories.sh's PROJECT_ROOT resolution — REAL execution of the
 * actual, unmodified line, extracted verbatim (not re-implemented) so this
 * can never silently diverge from the real script.
 *
 * Built 2026-07-23 after the real Metrolinx AMSD-1820 run: CPA's file-
 * existence check (compute_signals) reported 3 real, verified-to-exist files
 * as "don't exist" because PROJECT_ROOT was unconditionally reassigned to
 * epam-cli's own repo root, discarding the correct codeline path
 * (/home/.../metrolinx/azure.commerce.cdts) that _run_codeline_loop had
 * exported — same bug class as team-lead-review.sh's PROJECT_ROOT fix
 * earlier this session, just not applied here too.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPT_PATH = join(REPO_ROOT, 'orchestrations/scripts/contextualize-stories.sh');
const src = readFileSync(SCRIPT_PATH, 'utf8');

function extractProjectRootLines(): string {
  const start = src.indexOf('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"');
  const end = src.indexOf('LIB_DIR=', start);
  if (start === -1 || end === -1) throw new Error('PROJECT_ROOT resolution block not found — has it moved/changed shape?');
  return src.slice(start, end);
}

const projectRootBlock = extractProjectRootLines();

// Mirrors the real script's own directory depth (orchestrations/scripts/<this file>)
// so dirname(dirname(SCRIPT_DIR)) resolves exactly like the real repo does —
// executed as a real file (not `bash -c`), since ${BASH_SOURCE[0]} only
// resolves meaningfully for an actual script file, matching how the real
// pipeline always invokes it.
const testRoot = mkdtempSync(join(tmpdir(), 'contextualize-project-root-'));
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));
const scriptsDir = join(testRoot, 'orchestrations', 'scripts');
mkdirSync(scriptsDir, { recursive: true });
const fixtureScriptPath = join(scriptsDir, 'extracted-project-root.sh');
writeFileSync(fixtureScriptPath, `#!/usr/bin/env bash\n${projectRootBlock}\necho "$PROJECT_ROOT"\n`);

function runBlock(env: NodeJS.ProcessEnv): string {
  return execFileSync('bash', [fixtureScriptPath], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

describe('contextualize-stories.sh PROJECT_ROOT resolution (real extracted code)', () => {
  it('respects a caller-supplied PROJECT_ROOT (e.g. the real Metrolinx codeline path) instead of overwriting it', () => {
    const result = runBlock({ PROJECT_ROOT: '/home/bradleyjerome/projects/metrolinx/azure.commerce.cdts' });
    expect(result).toBe('/home/bradleyjerome/projects/metrolinx/azure.commerce.cdts');
  });

  it('falls back to dirname(AUTOMATION_DIR) only when PROJECT_ROOT is unset', () => {
    const env = { ...process.env };
    delete env.PROJECT_ROOT;
    const result = runBlock(env);
    expect(result).toBe(testRoot);
  });

  it('is deterministic across repeated calls with a real codeline path', () => {
    for (let i = 0; i < 5; i++) {
      const result = runBlock({ PROJECT_ROOT: '/some/real/codeline/path' });
      expect(result).toBe('/some/real/codeline/path');
    }
  });
});
