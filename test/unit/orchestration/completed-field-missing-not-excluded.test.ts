/**
 * Story categorization queries (run-agent-orchestration.sh's main_stories /
 * primary_stories / independent_stories / review_stories / the mid-execution
 * "current" refresh, plus claude.sh's get_incomplete_stories /
 * get_prioritized_stories) all filtered on `.completed == false`.
 *
 * Real, severe bug (found live 2026-08-02, AMSD-2041 Writer Retest — the
 * SAME run both the Step 9 auto-commit fix and the RESET_STORIES "in-progress"
 * fix were meant to validate): a story whose `completed` field is entirely
 * ABSENT (not `false`, just missing — exactly what a hand-reset PRD, or any
 * brand-new hand-authored PRD story that never explicitly sets `completed`,
 * produces) is silently EXCLUDED by `.completed == false`, because jq
 * evaluates a missing field as `null`, and `null == false` is `false` — not a
 * match. Every category query returned empty for the ENTIRE run: Step 8
 * never ran `_run_one_main_story` for the story AT ALL (confirmed live: the
 * "Running: <story>" log line never appeared, on any pass, for any of 3
 * codelines), so nothing ever reached ensure_story_branch, the writer, or a
 * commit — yet OTHER code (apparently keying off looser logic) still
 * implemented and reviewed the story, producing real, uncommitted file
 * changes and a permanently-blocked brownfield repro-gate ("no test file
 * accompanies the change") every single retry, forever. The earlier Step 9
 * and RESET_STORIES fixes were real and correct, but neither was the actual
 * blocker for that run — THIS was.
 *
 * Fix: `.completed == false` -> `(.completed // false) == false` everywhere
 * a story's completion status gates categorization — missing is treated the
 * same as explicitly false (not yet completed), matching what every other
 * completion check in this codebase already assumes.
 *
 * Real jq, extracted directly from the real scripts — no reimplementation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function extractJqQuery(src: string, afterMarker: string, varName: string): string {
  const markerIdx = src.indexOf(afterMarker);
  expect(markerIdx, `marker not found: ${afterMarker}`).toBeGreaterThan(-1);
  const assignIdx = src.indexOf(`${varName}=$(jq`, markerIdx);
  expect(assignIdx, `${varName} assignment not found after marker`).toBeGreaterThan(-1);
  const closeIdx = src.indexOf('"$PRD_FILE")', assignIdx);
  expect(closeIdx).toBeGreaterThan(assignIdx);
  const quoteStart = src.indexOf("'", assignIdx);
  const quoteEnd = src.lastIndexOf("'", closeIdx);
  return src.slice(quoteStart + 1, quoteEnd);
}

function runJqQuery(query: string, prd: object, phase = 'core'): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'completed-missing-test-'));
  cleanupDirs.push(dir);
  const prdPath = join(dir, 'prd.json');
  writeFileSync(prdPath, JSON.stringify(prd));
  const result = spawnSync('jq', ['-r', '--arg', 'phase', phase, query, prdPath], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split('\n').filter(Boolean);
}

describe('run-agent-orchestration.sh categorization queries — missing .completed is NOT excluded', () => {
  const mainQuery = extractJqQuery(orchSrc, 'main_stories=$(jq', 'main_stories');
  const primaryQuery = extractJqQuery(orchSrc, 'primary_stories=$(jq', 'primary_stories');
  const independentQuery = extractJqQuery(orchSrc, 'independent_stories=$(jq', 'independent_stories');
  const reviewQuery = extractJqQuery(orchSrc, 'review_stories=$(jq', 'review_stories');

  it('main_stories selects a main-group story whose completed field is entirely absent', () => {
    const prd = {
      implementationOrder: { core: ['STORY-A'] },
      stories: [{ id: 'STORY-A', agentGroup: 'main', status: 'in-progress' }], // no `completed` key at all
    };
    expect(runJqQuery(mainQuery, prd)).toEqual(['STORY-A']);
  });

  it('main_stories still excludes an explicitly completed:true story (no regression)', () => {
    const prd = {
      implementationOrder: { core: ['STORY-A'] },
      stories: [{ id: 'STORY-A', agentGroup: 'main', completed: true }],
    };
    expect(runJqQuery(mainQuery, prd)).toEqual([]);
  });

  it('primary_stories selects a primary-group story with a missing completed field', () => {
    const prd = {
      implementationOrder: { core: ['STORY-B'] },
      stories: [{ id: 'STORY-B', agentGroup: 'primary' }],
    };
    expect(runJqQuery(primaryQuery, prd)).toEqual(['STORY-B']);
  });

  it('independent_stories selects an independent-group story with a missing completed field', () => {
    const prd = {
      implementationOrder: { core: ['STORY-C'] },
      stories: [{ id: 'STORY-C', agentGroup: 'independent' }],
    };
    expect(runJqQuery(independentQuery, prd)).toEqual(['STORY-C']);
  });

  it('review_stories selects a review-agent story with a missing completed field', () => {
    const prd = {
      implementationOrder: { core: ['STORY-D'] },
      stories: [{ id: 'STORY-D', agentRole: 'review-agent' }],
    };
    expect(runJqQuery(reviewQuery, prd)).toEqual(['STORY-D']);
  });

  it('the mid-execution "_main_stories_current" refresh also treats missing completed as pending', () => {
    const assignIdx = orchSrc.indexOf('_main_stories_current=$(jq');
    expect(assignIdx).toBeGreaterThan(-1);
    const quoteStart = orchSrc.indexOf("'", assignIdx);
    const quoteEnd = orchSrc.indexOf("'", quoteStart + 1);
    const query = orchSrc.slice(quoteStart + 1, quoteEnd);
    const prd = {
      implementationOrder: { core: ['STORY-E'] },
      stories: [{ id: 'STORY-E', agentGroup: 'main' }],
    };
    const dir = mkdtempSync(join(tmpdir(), 'completed-missing-test-'));
    cleanupDirs.push(dir);
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify(prd));
    const result = spawnSync('jq', ['-r', '--arg', 'phase', 'core', query, prdPath], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('STORY-E');
  });
});

describe('claude.sh get_incomplete_stories()/get_prioritized_stories() — missing .completed is NOT excluded', () => {
  function extractSimpleQuery(fnName: string): string {
    const fnStart = claudeSrc.indexOf(`${fnName}() {`);
    expect(fnStart, `${fnName} not found`).toBeGreaterThan(-1);
    const fnEnd = claudeSrc.indexOf('\n}', fnStart);
    const body = claudeSrc.slice(fnStart, fnEnd);
    const m = body.match(/jq -r '([^']+)'/);
    expect(m, `no jq query found in ${fnName}`).toBeTruthy();
    return m![1];
  }

  it('get_incomplete_stories selects a story with a missing completed field', () => {
    const query = extractSimpleQuery('get_incomplete_stories');
    const dir = mkdtempSync(join(tmpdir(), 'completed-missing-test-'));
    cleanupDirs.push(dir);
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify({ stories: [{ id: 'STORY-F' }] }));
    const out = execFileSync('jq', ['-r', query, prdPath], { encoding: 'utf8' }).trim();
    expect(out).toBe('STORY-F');
  });
});
