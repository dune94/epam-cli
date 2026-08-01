/**
 * verify_story_deliverables() — work-carryover signal (added 2026-08-01).
 *
 * Before a ladder escalation, the next attempt's prompt had no explicit
 * signal distinguishing "this declared file already has real work — build
 * on it" from "this declared file still needs it" — that distinction had to
 * be re-derived from "## Existing File Contents" prose, the same class of
 * thing this project's WriteFile.ts reuse-guard was built to stop relying
 * on. verify_story_deliverables() now persists LAST_VERIFIED_TOUCHED_FILES /
 * LAST_VERIFIED_UNCHANGED_FILES (globals, read by the retry loop after this
 * function returns) so that split can be injected into the next attempt's
 * prompt explicitly instead of left implicit.
 *
 * Real git repos throughout (bare "origin" + working clone), no mocking —
 * same fixture pattern as verify-story-deliverables-brownfield-unchanged.test.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A bare "origin" + a working clone, with several pre-existing tracked files. */
function makeBrownfieldFixture(files: string[]): { clone: string } {
  const root = mkdtempSync(join(tmpdir(), 'verify-deliverables-carryover-'));
  cleanupDirs.push(root);

  const bareOrigin = join(root, 'origin.git');
  mkdirSync(bareOrigin, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=develop', '--quiet'], { cwd: bareOrigin });

  const seed = join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });
  for (const f of files) {
    mkdirSync(join(seed, f, '..'), { recursive: true });
    writeFileSync(join(seed, f), `export const original = "${f}";\n`);
  }
  execFileSync('git', ['add', '-A'], { cwd: seed });
  execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: seed });
  execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: seed });
  execFileSync('git', ['push', 'origin', 'develop', '--quiet'], { cwd: seed });

  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '--quiet', bareOrigin, clone]);
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: clone });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: clone });

  return { clone };
}

function run(projectRoot: string, declaredFiles: string[]): { touched: string[]; unchanged: string[]; output: string } {
  const prdPath = join(projectRoot, '..', 'prd.json');
  writeFileSync(prdPath, JSON.stringify({ stories: [{ id: 'SKY-TEST', technicalNotes: { files: declaredFiles } }] }));
  const fnBody = [extractFunctionBody('_resolve_deliverable_path'), extractFunctionBody('verify_story_deliverables')].join('\n');
  const scriptPath = join(projectRoot, '..', 'run.sh');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      `PROJECT_ROOT=${JSON.stringify(projectRoot)}`,
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
      'EPAM_BROWNFIELD=1',
      'JIRA_BASELINE_BRANCH=develop',
      'error() { echo "ERROR: $*" >&2; }',
      'success() { echo "SUCCESS: $*" >&2; }',
      'warning() { echo "WARNING: $*" >&2; }',
      '_get_vendor_dirs() { :; }',
      'verify_prescribed_helper_used() { return 0; }',
      'record_story_outputs() { return 0; }',
      fnBody,
      'verify_story_deliverables "SKY-TEST" || true',
      'echo "===TOUCHED-START==="',
      'echo "$LAST_VERIFIED_TOUCHED_FILES"',
      'echo "===TOUCHED-END==="',
      'echo "===UNCHANGED-START==="',
      'echo "$LAST_VERIFIED_UNCHANGED_FILES"',
      'echo "===UNCHANGED-END==="',
    ].join('\n'),
  );
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  const output = (result.stdout || '') + (result.stderr || '');
  const extract = (start: string, end: string) => {
    const m = new RegExp(`${start}\\n([\\s\\S]*?)\\n${end}`).exec(output);
    return m ? m[1].split('\n').filter(Boolean) : [];
  };
  return {
    touched: extract('===TOUCHED-START===', '===TOUCHED-END==='),
    unchanged: extract('===UNCHANGED-START===', '===UNCHANGED-END==='),
    output,
  };
}

describe('verify_story_deliverables — LAST_VERIFIED_TOUCHED_FILES / LAST_VERIFIED_UNCHANGED_FILES', () => {
  it('reports a genuinely modified file as touched, not unchanged', () => {
    const { clone } = makeBrownfieldFixture(['src/a.ts']);
    writeFileSync(join(clone, 'src/a.ts'), 'export const original = "src/a.ts";\nexport const fixed = true;\n');
    const { touched, unchanged } = run(clone, ['src/a.ts']);
    expect(touched).toEqual(['src/a.ts']);
    expect(unchanged).toEqual([]);
  });

  it('reports an untouched pre-existing file as unchanged, not touched', () => {
    const { clone } = makeBrownfieldFixture(['src/a.ts']);
    const { touched, unchanged } = run(clone, ['src/a.ts']);
    expect(touched).toEqual([]);
    expect(unchanged).toEqual(['src/a.ts']);
  });

  it('correctly splits a mix: some declared files touched, others still unchanged', () => {
    const { clone } = makeBrownfieldFixture(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    writeFileSync(join(clone, 'src/a.ts'), 'export const original = "src/a.ts";\nexport const fixed = true;\n');
    // src/b.ts and src/c.ts left untouched.
    const { touched, unchanged } = run(clone, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(touched).toEqual(['src/a.ts']);
    expect(unchanged.sort()).toEqual(['src/b.ts', 'src/c.ts']);
  });

  it('a brand-new file (did not exist at baseline) counts as touched', () => {
    const { clone } = makeBrownfieldFixture(['src/a.ts']);
    mkdirSync(join(clone, 'src/new'), { recursive: true });
    writeFileSync(join(clone, 'src/new/created.ts'), 'export const brandNew = true;\n');
    const { touched, unchanged } = run(clone, ['src/a.ts', 'src/new/created.ts']);
    expect(touched).toContain('src/new/created.ts');
    expect(unchanged).toEqual(['src/a.ts']);
  });

  it('both lists are empty when no files are declared at all', () => {
    const { clone } = makeBrownfieldFixture(['src/a.ts']);
    const { touched, unchanged } = run(clone, []);
    expect(touched).toEqual([]);
    expect(unchanged).toEqual([]);
  });
});
