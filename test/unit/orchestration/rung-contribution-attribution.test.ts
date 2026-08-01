/**
 * Per-file rung/model attribution (backlog #113, built on #107/#112).
 * Snapshots a content-hash of every file with a real diff at the start of
 * each rung; when the rung finishes, any file whose hash changed gets logged
 * as that rung's contribution. At story completion, the final commit's real
 * file list is cross-referenced against the log to report which rungs/models
 * actually contributed surviving work — using the LATEST record per file, so
 * a file touched by rung 1 and left unchanged by rung 2 still credits rung 1.
 *
 * Real git repos throughout (bare "origin" + working clone), no mocking.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(claudeSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

const FN_BODIES = [
  extractFunctionBody('_rung_snapshot_path'),
  extractFunctionBody('_rung_snapshot_hashes'),
  extractFunctionBody('_rung_attribute_changes'),
  extractFunctionBody('_generate_rung_contribution_report'),
].join('\n');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeFixture(): { clone: string; logDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'rung-contribution-'));
  cleanupDirs.push(root);

  const bareOrigin = join(root, 'origin.git');
  mkdirSync(bareOrigin, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=develop', '--quiet'], { cwd: bareOrigin });

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });
  writeFileSync(join(seed, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(seed, 'src/b.ts'), 'export const b = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: seed });
  execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: seed });
  execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: seed });
  execFileSync('git', ['push', 'origin', 'develop', '--quiet'], { cwd: seed });

  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '--quiet', bareOrigin, clone]);
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: clone });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: clone });

  const logDir = join(root, 'logs');
  mkdirSync(logDir, { recursive: true });

  return { clone, logDir };
}

function runScript(projectRoot: string, logDir: string, commands: string[]): string {
  const scriptPath = join(projectRoot, '..', 'run.sh');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      `PROJECT_ROOT=${JSON.stringify(projectRoot)}`,
      `LOG_DIR=${JSON.stringify(logDir)}`,
      'EPAM_BROWNFIELD=1',
      'JIRA_BASELINE_BRANCH=develop',
      'log() { echo "LOG: $*" >&2; }',
      FN_BODIES,
      ...commands,
    ].join('\n'),
  );
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  return (result.stdout || '') + (result.stderr || '');
}

describe('_rung_snapshot_hashes', () => {
  it('records a hash for every file with a diff from baseline (tracked-modified + untracked-new)', () => {
    const { clone, logDir } = makeFixture();
    writeFileSync(join(clone, 'src/a.ts'), 'export const a = 2;\n');
    writeFileSync(join(clone, 'src/c.ts'), 'export const c = 1;\n');
    runScript(clone, logDir, ['_rung_snapshot_hashes "SKY-TEST"']);
    const snapFile = join(logDir, '.rung-snapshot-SKY-TEST');
    expect(existsSync(snapFile)).toBe(true);
    const content = readFileSync(snapFile, 'utf-8');
    expect(content).toMatch(/^src\/a\.ts [0-9a-f]{40}$/m);
    expect(content).toMatch(/^src\/c\.ts [0-9a-f]{40}$/m);
    expect(content).not.toMatch(/src\/b\.ts/); // unmodified, no diff
  });
});

describe('_rung_attribute_changes', () => {
  it('logs a contribution record for a file that changed since the snapshot', () => {
    const { clone, logDir } = makeFixture();
    writeFileSync(join(clone, 'src/a.ts'), 'export const a = 2;\n');
    const out = runScript(clone, logDir, [
      '_rung_snapshot_hashes "SKY-TEST"',
      // Simulate a rung's attempt modifying the file further.
      `printf 'export const a = 3;\\n' > "${join(clone, 'src/a.ts')}"`,
      '_rung_attribute_changes "SKY-TEST" "1" "z-ai/glm-5.2"',
    ]);
    const contribFile = join(logDir, 'rung-contribution.jsonl');
    expect(existsSync(contribFile)).toBe(true);
    const record = JSON.parse(readFileSync(contribFile, 'utf-8').trim());
    expect(record.file).toBe('src/a.ts');
    expect(record.rung).toBe('1');
    expect(record.model).toBe('z-ai/glm-5.2');
  });

  it('does NOT log a file whose content is unchanged since the snapshot', () => {
    const { clone, logDir } = makeFixture();
    writeFileSync(join(clone, 'src/a.ts'), 'export const a = 2;\n');
    runScript(clone, logDir, [
      '_rung_snapshot_hashes "SKY-TEST"',
      '_rung_attribute_changes "SKY-TEST" "1" "z-ai/glm-5.2"',
    ]);
    expect(existsSync(join(logDir, 'rung-contribution.jsonl'))).toBe(false);
  });

  it('is a no-op when no snapshot exists yet (nothing prior to compare against)', () => {
    const { clone, logDir } = makeFixture();
    writeFileSync(join(clone, 'src/a.ts'), 'export const a = 2;\n');
    runScript(clone, logDir, ['_rung_attribute_changes "SKY-TEST" "0" "MiniMax-M3"']);
    expect(existsSync(join(logDir, 'rung-contribution.jsonl'))).toBe(false);
  });
});

describe('_generate_rung_contribution_report — end to end across 3 rungs', () => {
  it('reports 3 rungs contributing to a final diff spanning 3 distinct files', () => {
    const { clone, logDir } = makeFixture();

    // Rung 1 (MiniMax-M3): touches src/a.ts.
    writeFileSync(join(clone, 'src/a.ts'), 'export const a = 1;\n');
    let out = runScript(clone, logDir, ['_rung_snapshot_hashes "SKY-TEST"']);

    writeFileSync(join(clone, 'src/a.ts'), 'export const a = 2;\n');
    out += runScript(clone, logDir, [
      '_rung_attribute_changes "SKY-TEST" "0" "MiniMax-M3"',
      '_rung_snapshot_hashes "SKY-TEST"',
    ]);

    // Rung 2 (glm-5.2): touches src/b.ts, leaves src/a.ts as rung 1 left it.
    mkdirSync(join(clone, 'src', 'new'), { recursive: true });
    writeFileSync(join(clone, 'src/b.ts'), 'export const b = 2;\n');
    out += runScript(clone, logDir, [
      '_rung_attribute_changes "SKY-TEST" "1" "z-ai/glm-5.2"',
      '_rung_snapshot_hashes "SKY-TEST"',
    ]);

    // Rung 3 (kimi-k3): touches a brand-new file.
    writeFileSync(join(clone, 'src/new/created.ts'), 'export const created = true;\n');
    out += runScript(clone, logDir, [
      '_rung_attribute_changes "SKY-TEST" "2" "moonshotai/kimi-k3"',
      '_generate_rung_contribution_report "SKY-TEST"',
    ]);

    const reportFile = join(logDir, 'rung-contribution-report-SKY-TEST.json');
    expect(existsSync(reportFile)).toBe(true);
    const report = JSON.parse(readFileSync(reportFile, 'utf-8'));
    expect(report).toHaveLength(3);

    const byRung: Record<string, any> = Object.fromEntries(report.map((r: any) => [r.rung, r]));
    expect(byRung['0'].model).toBe('MiniMax-M3');
    expect(byRung['0'].files).toEqual(['src/a.ts']);
    expect(byRung['1'].model).toBe('z-ai/glm-5.2');
    expect(byRung['1'].files).toEqual(['src/b.ts']);
    expect(byRung['2'].model).toBe('moonshotai/kimi-k3');
    expect(byRung['2'].files).toEqual(['src/new/created.ts']);

    expect(out).toMatch(/RungContribution\[SKY-TEST\]: 3 rung\(s\) contributed/);
  });

  it('excludes a file from the report if a later reset erased it before the final commit', () => {
    const { clone, logDir } = makeFixture();

    // Rung 1: touches src/a.ts, then gets reset (simulating a failed tsc rung).
    writeFileSync(join(clone, 'src/a.ts'), 'export const a = 1;\n');
    runScript(clone, logDir, ['_rung_snapshot_hashes "SKY-TEST"']);
    writeFileSync(join(clone, 'src/a.ts'), 'export const a = BROKEN(;\n');
    runScript(clone, logDir, ['_rung_attribute_changes "SKY-TEST" "0" "MiniMax-M3"']);
    // Reset back to baseline (what _selective_worktree_reset would do on tsc failure).
    execFileSync('git', ['checkout', 'origin/develop', '--', '.'], { cwd: clone });
    execFileSync('git', ['clean', '-fd'], { cwd: clone });
    runScript(clone, logDir, ['_rung_snapshot_hashes "SKY-TEST"']);

    // Rung 2: touches src/b.ts only. Final diff is just src/b.ts.
    writeFileSync(join(clone, 'src/b.ts'), 'export const b = 2;\n');
    const out = runScript(clone, logDir, [
      '_rung_attribute_changes "SKY-TEST" "1" "z-ai/glm-5.2"',
      '_generate_rung_contribution_report "SKY-TEST"',
    ]);

    const reportFile = join(logDir, 'rung-contribution-report-SKY-TEST.json');
    const report = JSON.parse(readFileSync(reportFile, 'utf-8'));
    expect(report).toHaveLength(1);
    expect(report[0].files).toEqual(['src/b.ts']);
    expect(out).toMatch(/1 rung\(s\) contributed/);
  });
});
