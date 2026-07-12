/**
 * Fix for a recurring live failure (2026-07-08, tier3 scaffold phase — 3rd
 * occurrence in one night): spec-pass sometimes splits the scaffold story
 * (SKY-001) into pieces where NO child story ever creates a real source
 * file, leaving `tsconfig.json`'s own `include` glob matching zero files.
 * `tsc --noEmit` then fails with TS18003 ("No inputs were found"), SAST
 * correctly reports it as a blocker, and the pipeline hard-aborted — even
 * after the earlier gate-remediation-eligibility fix made the 3-agent
 * self-heal pipeline actually reachable, `gate-finding-analyst` still
 * couldn't ground the finding to a story (it points at `tsconfig.json`,
 * which no story's `technicalNotes.files` lists).
 *
 * This is not a judgment call an LLM needs to make — TS18003 is a precise,
 * mechanically diagnosable condition, and the fix (create one minimal
 * placeholder file matching the config's own include glob) is mechanically
 * derivable from `tsconfig.json` already on disk. So it's handled as a
 * deterministic self-heal directly in the SAST gate's tsc-oracle step,
 * before the LLM ever sees it — consistent with this project's "code-level
 * checks over LLM persuasion" pattern.
 *
 * This test extracts the REAL self-heal block from run-agent-orchestration.sh
 * (not a hand-copied duplicate) and runs it against real fixture projects
 * with a real tsc binary (borrowed from this repo's own node_modules).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');
const NODE_BIN = process.execPath;

function extractSelfHealBlock(): string {
  const start = orchSrc.indexOf('if [ $_tsc_rc -ne 0 ] && echo "$_tsc_out" | grep -q "error TS18003"; then');
  if (start === -1) throw new Error('self-heal block start anchor not found');
  const marker = 'warning "  [scaffold-self-heal] placeholder created but tsc still fails';
  const markerIdx = orchSrc.indexOf(marker, start);
  if (markerIdx === -1) throw new Error('self-heal block marker not found');
  // Walk forward to the two closing `fi` lines that end this block.
  const afterMarker = orchSrc.indexOf('\n', markerIdx);
  const closeIdx = orchSrc.indexOf('\n            fi\n', afterMarker);
  if (closeIdx === -1) throw new Error('self-heal block end anchor not found');
  const endIdx = orchSrc.indexOf('\n            fi\n', closeIdx + 1);
  if (endIdx === -1) throw new Error('self-heal block second end anchor not found');
  return orchSrc.slice(start, endIdx + '\n            fi'.length);
}

function makeFixtureProject(opts: { include: string[]; withExistingSourceFile?: boolean; malformedTsconfig?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-self-heal-fixture-'));
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
  const tsconfigContent = opts.malformedTsconfig
    ? '{ this is not valid json'
    : JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: false, noEmit: true }, include: opts.include }, null, 2);
  writeFileSync(join(dir, 'tsconfig.json'), tsconfigContent);
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  if (opts.withExistingSourceFile) {
    const firstDir = opts.include[0].split('/')[0];
    mkdirSync(join(dir, firstDir), { recursive: true });
    writeFileSync(join(dir, firstDir, 'existing.ts'), 'export const x = 1;\n');
  }
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir });
  return dir;
}

function runSelfHeal(projectRoot: string): { stdout: string; placeholderExists: (relPath: string) => boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-self-heal-run-'));
  try {
    const selfHealBlock = extractSelfHealBlock();
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
set -uo pipefail
warning() { echo "WARNING: $*"; }
success() { echo "SUCCESS: $*"; }
run_self_heal() {
  local PROJECT_ROOT="${projectRoot}"
  local _tsc_node_bin="${NODE_BIN}"
  local _tsc_out
  _tsc_out=$(cd "$PROJECT_ROOT" && "$_tsc_node_bin" ./node_modules/.bin/tsc --noEmit 2>&1)
  local _tsc_rc=$?
${selfHealBlock}
  echo "FINAL_TSC_RC=$_tsc_rc"
}
run_self_heal
`,
    );
    const output = execFileSync('bash', [scriptPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return {
      stdout: output,
      placeholderExists: (relPath: string) => existsSync(join(projectRoot, relPath)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('scaffold tsconfig self-heal (TS18003) — REAL execution', () => {
  it('creates a placeholder and tsc passes when include glob matches zero files', () => {
    const project = makeFixtureProject({ include: ['src/**/*'] });
    try {
      const { stdout, placeholderExists } = runSelfHeal(project);
      expect(stdout).toContain('created minimal placeholder');
      expect(stdout).toContain('tsc now passes after placeholder creation');
      expect(stdout).toMatch(/FINAL_TSC_RC=0/);
      expect(placeholderExists('src/index.ts')).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('commits the placeholder to git so downstream phases see a clean state', () => {
    const project = makeFixtureProject({ include: ['src/**/*'] });
    try {
      runSelfHeal(project);
      const log = execFileSync('git', ['log', '--oneline'], { cwd: project, encoding: 'utf8' });
      expect(log).toContain('scaffold-self-heal');
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' });
      expect(status.trim()).toBe(''); // placeholder committed, working tree clean
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('does NOT create a placeholder when a real source file already exists (nothing to heal)', () => {
    const project = makeFixtureProject({ include: ['src/**/*'], withExistingSourceFile: true });
    try {
      const { stdout, placeholderExists } = runSelfHeal(project);
      expect(stdout).not.toContain('created minimal placeholder');
      expect(placeholderExists('src/index.ts')).toBe(false);
      expect(stdout).toMatch(/FINAL_TSC_RC=0/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('derives the placeholder location generically from a non-"src" include pattern', () => {
    const project = makeFixtureProject({ include: ['lib/**/*'] });
    try {
      const { stdout, placeholderExists } = runSelfHeal(project);
      expect(stdout).toContain('created minimal placeholder: lib/index.ts');
      expect(placeholderExists('lib/index.ts')).toBe(true);
      expect(placeholderExists('src/index.ts')).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not crash on a malformed tsconfig.json — treated as nothing to heal', () => {
    const project = makeFixtureProject({ include: ['src/**/*'], malformedTsconfig: true });
    try {
      const { stdout } = runSelfHeal(project);
      expect(stdout).not.toContain('created minimal placeholder');
      expect(stdout).not.toMatch(/Traceback/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('is a no-op when tsc already passes for unrelated reasons (no TS18003 in output)', () => {
    const project = makeFixtureProject({ include: ['src/**/*'], withExistingSourceFile: true });
    try {
      const { stdout } = runSelfHeal(project);
      // Should reach the pre-existing "tsc: PASS" summary path untouched —
      // this test only asserts the self-heal branch itself did nothing,
      // covered by the "does NOT create a placeholder" test above; this one
      // additionally confirms no spurious warning/success self-heal lines fire.
      expect(stdout).not.toContain('[scaffold-self-heal]');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
