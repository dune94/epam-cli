/**
 * RESET_STORIES block (run-agent-orchestration.sh, ~line 3605) — resets a
 * story's completed/status flags back to pending on a fresh `--reset` pass.
 *
 * Live bug (found 2026-08-02, alongside the Step 9 auto-commit fix): the
 * reset's select clause only matched `.completed == true or .status ==
 * "failed"`. A story left `status: "in-progress"` (completed: false) —
 * exactly what happens when a later gate (e.g. the brownfield repro-gate)
 * blocks a phase before the story's own commit lands — was NEVER matched,
 * so it silently survived every subsequent `--reset` retry still tagged
 * "in-progress", a transient state that must never persist across a reset
 * boundary. Fixed by adding `or .status == "in-progress"` to both the
 * phase-scoped and global reset queries.
 *
 * Pure jq/bash block — extracted and run standalone against a real PRD
 * fixture, no mocking.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SCRIPT, 'utf8');

function extractResetBlock(): string {
  const start = orchSrc.indexOf('# Reset story completed flags if requested');
  const end = orchSrc.indexOf('# Verify prerequisites', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return orchSrc.slice(start, end);
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runReset(prd: object, phase?: string): { stories: any[] } {
  const dir = mkdtempSync(join(tmpdir(), 'reset-stories-test-'));
  cleanupDirs.push(dir);
  const prdPath = join(dir, 'prd.json');
  writeFileSync(prdPath, JSON.stringify(prd));

  const scriptPath = join(dir, 'run.sh');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      'log() { :; }',
      'info() { :; }',
      'success() { :; }',
      'checkpoint_clear() { :; }',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `RESET_STORIES=true`,
      phase !== undefined ? `PHASE=${JSON.stringify(phase)}` : '',
      extractResetBlock(),
    ].join('\n'),
  );
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) {
    throw new Error(`reset block failed: ${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(readFileSync(prdPath, 'utf8'));
}

describe('RESET_STORIES block — status:"in-progress" is reset alongside completed/failed', () => {
  it('REPRODUCES the live bug and confirms the fix: an "in-progress" story is reset to pending (phase-scoped)', () => {
    const result = runReset(
      {
        implementationOrder: { core: ['STORY-A'] },
        stories: [{ id: 'STORY-A', status: 'in-progress', completed: false }],
      },
      'core',
    );
    const story = result.stories.find((s) => s.id === 'STORY-A');
    expect(story.status).toBe('pending');
    expect(story.completed).toBe(false);
  });

  it('still resets a "completed" story to pending (existing behavior unchanged)', () => {
    const result = runReset(
      {
        implementationOrder: { core: ['STORY-B'] },
        stories: [{ id: 'STORY-B', status: 'completed', completed: true }],
      },
      'core',
    );
    const story = result.stories.find((s) => s.id === 'STORY-B');
    expect(story.status).toBe('pending');
    expect(story.completed).toBe(false);
  });

  it('still resets a "failed" story to pending (existing behavior unchanged)', () => {
    const result = runReset(
      {
        implementationOrder: { core: ['STORY-C'] },
        stories: [{ id: 'STORY-C', status: 'failed', completed: false }],
      },
      'core',
    );
    const story = result.stories.find((s) => s.id === 'STORY-C');
    expect(story.status).toBe('pending');
  });

  it('leaves an already-"pending" story untouched', () => {
    const result = runReset(
      {
        implementationOrder: { core: ['STORY-D'] },
        stories: [{ id: 'STORY-D', status: 'pending', completed: false }],
      },
      'core',
    );
    const story = result.stories.find((s) => s.id === 'STORY-D');
    expect(story.status).toBe('pending');
  });

  it('only resets "in-progress" stories within the scoped phase, not other phases', () => {
    const result = runReset(
      {
        implementationOrder: { core: ['STORY-E'], other: ['STORY-F'] },
        stories: [
          { id: 'STORY-E', status: 'in-progress', completed: false },
          { id: 'STORY-F', status: 'in-progress', completed: false },
        ],
      },
      'core',
    );
    expect(result.stories.find((s) => s.id === 'STORY-E').status).toBe('pending');
    expect(result.stories.find((s) => s.id === 'STORY-F').status).toBe('in-progress'); // untouched — different phase
  });

  it('resets an "in-progress" story with no phase scoping (global reset)', () => {
    const result = runReset({
      stories: [{ id: 'STORY-G', status: 'in-progress', completed: false }],
    });
    const story = result.stories.find((s) => s.id === 'STORY-G');
    expect(story.status).toBe('pending');
  });
});
