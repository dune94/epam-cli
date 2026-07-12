/**
 * team-lead-review.sh / code-review-cycle.sh — diff & file-list truncation,
 * REAL execution against an actual git repo.
 *
 * Root cause this fixes (2026-07-09, full pipeline audit): STORY_FILES was
 * capped at `head -20` (silently dropping files from a multi-file story's
 * OWN declared scope), and STORY_DIFF was capped at `head -400`/`head -300`
 * (silently truncating the diff fed to the LLM reviewer) — with no
 * indication to the reviewer that anything was cut. A real defect sitting
 * past line 400 of a multi-file story's diff was structurally invisible to
 * the verdict; the reviewer had no way to know its input was incomplete.
 *
 * Fix: STORY_FILES is no longer capped (a story's own file list is bounded
 * by design). STORY_DIFF's cap is raised substantially (2000 lines) AND any
 * actual truncation now appends an explicit "[TRUNCATED — N total lines...]"
 * marker to the diff text itself, so the reviewer's own input tells it the
 * data is incomplete rather than silently omitting the tail.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');

function extractDiffCollectionBlock(scriptPath: string, filesVarName: string, diffVarName: string): string {
  const src = readFileSync(scriptPath, 'utf8');
  const startMarker = `${filesVarName}=$(jq -r --arg id`;
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Could not find ${filesVarName} assignment in ${scriptPath}`);
  const endMarker = `[ -z "$${diffVarName}" ] &&`;
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) throw new Error(`Could not find end marker for ${diffVarName} in ${scriptPath}`);
  const endOfLine = src.indexOf('\n', endIdx);
  return src.slice(startIdx, endOfLine);
}

function makeGitRepoWithLargeDiff(totalLines: number): { dir: string; relFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'review-diff-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

  mkdirSync(join(dir, 'src'), { recursive: true });
  const relFile = 'src/big.ts';
  const filePath = join(dir, relFile);

  writeFileSync(filePath, 'export const x = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });

  // HEAD~5 must resolve — the diff logic tries `git diff HEAD~5 HEAD` first,
  // falling back to HEAD~3. Pad with filler commits so HEAD~5 exists and
  // resolves all the way back to the initial commit (making the "big
  // change" commit below the FULL diff against HEAD~5, not just HEAD~1).
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(dir, `filler-${i}.txt`), `filler ${i}\n`);
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', `filler ${i}`], { cwd: dir });
  }

  const bigContent = Array.from({ length: totalLines }, (_, i) => `export const line${i} = ${i};`).join('\n') + '\n';
  writeFileSync(filePath, bigContent);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'big change'], { cwd: dir });

  return { dir, relFile };
}

for (const [label, scriptRel, filesVar, diffVar] of [
  ['team-lead-review.sh', 'orchestrations/scripts/team-lead-review.sh', 'STORY_FILES', 'STORY_DIFF'],
  ['code-review-cycle.sh', 'orchestrations/scripts/code-review-cycle.sh', '_STORY_FILES', '_STORY_DIFF'],
] as const) {
  const scriptPath = join(REPO_ROOT, scriptRel);

  describe(`${label} — diff/file-list truncation (static)`, () => {
    const src = readFileSync(scriptPath, 'utf8');

    it(`${filesVar} is no longer capped with head -N`, () => {
      const idx = src.indexOf(`${filesVar}=$(jq -r --arg id`);
      const endIdx = src.indexOf("tr '\\n' ' ')", idx) + "tr '\\n' ' ')".length;
      const block = src.slice(idx, endIdx);
      expect(block).not.toMatch(/head -\d+/);
    });

    it(`${diffVar} truncation (if it happens) appends an explicit marker, not silent`, () => {
      expect(src).toMatch(/\[TRUNCATED — \$\{?_diff_total_lines\}? total lines/);
    });

    it('the diff cap is raised to 2000 lines (from 400/300)', () => {
      expect(src).toMatch(/-gt 2000/);
      expect(src).toMatch(/head -2000/);
    });
  });

  describe(`${label} — REAL execution against an actual git repo`, () => {
    it('a small diff (under the cap) passes through with no truncation marker', () => {
      const { dir, relFile } = makeGitRepoWithLargeDiff(50);
      try {
        const block = extractDiffCollectionBlock(scriptPath, filesVar, diffVar);
        const scriptOut = join(dir, 'run.sh');
        writeFileSync(
          scriptOut,
          [
            `PROJECT_ROOT="${dir}"`,
            `PRD_FILE="${join(dir, 'prd.json')}"`,
            block,
            `echo "$${diffVar}"`,
          ].join('\n')
        );
        writeFileSync(
          join(dir, 'prd.json'),
          JSON.stringify({ stories: [{ id: 'X', technicalNotes: { files: [relFile] } }] })
        );
        const out = execFileSync('bash', [scriptOut], { encoding: 'utf8', cwd: dir });
        expect(out).not.toMatch(/TRUNCATED/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('REPRODUCES the exact live defect scenario and proves the fix: a diff over 2000 lines gets an explicit TRUNCATED marker, not silent loss', () => {
      const { dir, relFile } = makeGitRepoWithLargeDiff(3000);
      try {
        const block = extractDiffCollectionBlock(scriptPath, filesVar, diffVar);
        const scriptOut = join(dir, 'run.sh');
        writeFileSync(
          scriptOut,
          [
            `PROJECT_ROOT="${dir}"`,
            `PRD_FILE="${join(dir, 'prd.json')}"`,
            block,
            `echo "$${diffVar}"`,
          ].join('\n')
        );
        writeFileSync(
          join(dir, 'prd.json'),
          JSON.stringify({ stories: [{ id: 'X', technicalNotes: { files: [relFile] } }] })
        );
        const out = execFileSync('bash', [scriptOut], { encoding: 'utf8', cwd: dir });
        expect(out).toMatch(/TRUNCATED — \d+ total lines, only the first 2000 shown/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
