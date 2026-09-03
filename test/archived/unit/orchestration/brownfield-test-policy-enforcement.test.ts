/**
 * Brownfield testing policy enforcement — REAL execution of the actual bash
 * block extracted from claude.sh's build_implementation_prompt, driving the
 * real brownfield-coverage-gate.sh + real codegraph against a real fixture repo.
 *
 * This is the enforcement half of the brownfield "no wild tests" strategy:
 * the coverage gate decides which changed files lack tests, and this block
 * turns that into the prompt policy the implementation agent obeys:
 *   - uncovered file present → "add ONE focused test for THIS file only"
 *   - every file covered      → "do NOT write any new test file"
 *   - gate can't tell / greenfield → no policy (fall back to default behavior)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SCRIPT_DIR = join(__dirname, '../../../orchestrations/scripts');
const src = readFileSync(CLAUDE_SH, 'utf8');

function codegraphAvailable(): boolean {
  try { execSync('command -v codegraph', { stdio: 'ignore' }); return true; } catch { return false; }
}

function extractPolicyBlock(): string {
  const start = src.indexOf('    local brownfield_test_policy=""');
  const end = src.indexOf('    # "Do NOT investigate" is right for greenfield');
  if (start === -1 || end === -1) throw new Error('brownfield_test_policy block markers not found');
  return src.slice(start, end);
}
const policyBlock = extractPolicyBlock();

const cleanupDirs: string[] = [];
afterAll(() => { for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'bf-policy-'));
  cleanupDirs.push(repo);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'covered.ts'), `export function coveredFn(x: number) { return x + 1; }\n`);
  writeFileSync(join(repo, 'src', 'covered.test.ts'), `import { coveredFn } from './covered';\nimport { it, expect } from 'vitest';\nit('a', () => expect(coveredFn(1)).toBe(2));\n`);
  writeFileSync(join(repo, 'src', 'uncovered.ts'), `export function uncoveredFn(x: number) { return x * 2; }\n`);
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'seed']);
  execSync(`codegraph init "${repo}"`, { stdio: 'ignore' });
  return repo;
}

// Runs the extracted policy block with a given story file list + brownfield flag.
// fixSite non-empty simulates a DEFECT (fixSiteAnalysis present) — the coverage
// policy must then be SKIPPED so it can't contradict the mandatory repro test.
function runPolicy(repo: string, files: string[], brownfield: boolean, fixSite = ''): string {
  const storyJson = JSON.stringify({ technicalNotes: { files } });
  const script = `
run_it() {
  local PROJECT_ROOT='${repo}'
  local SCRIPT_DIR='${SCRIPT_DIR}'
  local NODE_BIN='node'
  local story_json='${storyJson}'
  local fix_site_analysis='${fixSite}'
${policyBlock}
  printf '%s' "$brownfield_test_policy"
}
${brownfield ? 'export EPAM_BROWNFIELD=1' : 'unset EPAM_BROWNFIELD'}
run_it
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

describe('brownfield testing policy enforcement (real gate, real codegraph)', () => {
  it('uncovered changed file → policy names it and asks for ONE focused test', () => {
    if (!codegraphAvailable()) return;
    const repo = makeRepo();
    const policy = runPolicy(repo, ['src/uncovered.ts'], true);
    expect(policy).toMatch(/Brownfield Testing Policy/);
    expect(policy).toContain('src/uncovered.ts');
    expect(policy).toMatch(/ONE focused test/);
  }, 30000);

  it('all changed files already covered → policy says write NO new test', () => {
    if (!codegraphAvailable()) return;
    const repo = makeRepo();
    const policy = runPolicy(repo, ['src/covered.ts'], true);
    expect(policy).toMatch(/Brownfield Testing Policy/);
    expect(policy).toMatch(/do NOT write any new test file/i);
    expect(policy).not.toContain('src/uncovered.ts');
  }, 30000);

  it('greenfield (EPAM_BROWNFIELD unset) → no policy injected at all', () => {
    if (!codegraphAvailable()) return;
    const repo = makeRepo();
    const policy = runPolicy(repo, ['src/uncovered.ts'], false);
    expect(policy.trim()).toBe('');
  }, 30000);

  it('DEFECT (fix site present) + already-covered file → coverage policy is SKIPPED (no "do NOT write tests")', () => {
    // The live bug (AMSD-1820, 2026-07-24): the fix file already had coverage, so
    // this policy told the agent "do NOT write any new test file", which directly
    // contradicted the repro-gate. For a defect the coverage policy must go silent
    // and defer to the mandatory repro-test block.
    if (!codegraphAvailable()) return;
    const repo = makeRepo();
    const policy = runPolicy(repo, ['src/covered.ts'], true, 'present-fix-site');
    expect(policy.trim()).toBe('');                     // skipped entirely
    expect(policy).not.toMatch(/do NOT write any new test file/i);
  }, 30000);
});
