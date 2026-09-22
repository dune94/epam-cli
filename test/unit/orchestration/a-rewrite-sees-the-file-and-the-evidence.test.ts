/**
 * A WRITER ASKED TO REWRITE A FILE SEES THAT FILE, AND WHY IT WAS REJECTED.
 *
 * regintel 140717Z (2026-09-22), REGI-003b — the last incomplete story of a 15-story phase:
 *
 *   1. Its deliverable, tests/test_dedup.py, ALREADY EXISTED (369 lines, red). The prompt said
 *      "WRITE <abs path> first, before any other action" and showed none of it: writer-prompt.sh
 *      injects existing content only when EPAM_BROWNFIELD=1. A greenfield re-implementation is the
 *      same situation — a file on disk that must be reconciled, not invented — and the writer had
 *      to rediscover it with tools inside the wall. Six attempts, no landing.
 *   2. The review that rejected it said "13 failed / 6 passed" and named both causes. That file,
 *      review-feedback-REGI-003b.json, was DELETED by pre-run-reset on the resume that re-ran the
 *      story: `find -name 'review-*.json' -delete`, unconditionally. The writer was re-invoked
 *      blind, with the rejection nowhere in its prompt.
 *
 * Both are the same rule the ledgers already follow: a resume keeps the run's own record, and a
 * writer is told what it is actually facing.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const RESET = join(SCRIPTS, 'pre-run-reset.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("a resume keeps the findings that rejected the run's own stories", () => {
  function reset(env: Record<string, string>) {
    const d = mkdtempSync(join(tmpdir(), 'keep-findings-')); dirs.push(d);
    const logs = join(d, 'logs'); mkdirSync(logs);
    const prd = join(d, 'prd.json'); writeFileSync(prd, JSON.stringify({ stories: [] }));
    const dash = join(d, 'dash'); mkdirSync(dash);
    writeFileSync(join(logs, 'review-feedback-REGI-003b.json'), JSON.stringify({
      verdict: 'changes_requested',
      issues: [{ severity: 'blocker', file: 'tests/test_dedup.py', description: '13 failed / 6 passed: rule (b) reason string and the DuplicateMatch return shape' }],
    }));
    const r = spawnSync('bash', [RESET, '--prd', prd, '--log-dir', logs], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, COMPOSE_OVERRIDE: join(d, 'o.yml'), DASHBOARD_STATE_DIR: dash, ORCH_RUN_ID: '20260921T140717Z', ...env },
    });
    return { kept: existsSync(join(logs, 'review-feedback-REGI-003b.json')), out: `${r.stdout}${r.stderr}` };
  }

  it("a resume keeps them — the story it re-runs is the one they describe", () => {
    const t = reset({ EPAM_RESUME_RUN: '20260921T140717Z' });
    expect(t.kept, `the rejection evidence was deleted; the re-invoked writer gets no reason:\n${t.out.slice(-600)}`).toBe(true);
  });

  it('a fresh launch still clears them — another run\'s findings are not this run\'s', () => {
    const t = reset({});
    expect(t.kept).toBe(false);
  });
});

describe('the writer sees the file it has been told to write, when that file exists', () => {
  function prompt(opts: { brownfield: boolean; existing?: string }) {
    const d = mkdtempSync(join(tmpdir(), 'rewrite-sees-')); dirs.push(d);
    const proj = join(d, 'codeline'); mkdirSync(join(proj, 'tests'), { recursive: true });
    if (opts.existing !== undefined) writeFileSync(join(proj, 'tests/test_dedup.py'), opts.existing);
    const story = {
      id: 'S-1', title: 'Offline test suite', description: 'd', agentRole: 'engineer',
      technicalNotes: { files: ['tests/test_dedup.py'] }, acceptanceCriteria: ['ac'],
    };
    const r = spawnSync('bash', ['-c', `
      set -uo pipefail
      SCRIPT_DIR="${SCRIPTS}"; PROJECT_ROOT="${proj}"; LOG_DIR="${join(d, 'logs')}"; mkdir -p "$LOG_DIR"
      EPAM_BROWNFIELD=${opts.brownfield ? 1 : 0}
      log(){ :; }; warning(){ :; }; error(){ :; }; info(){ :; }
      . "$SCRIPT_DIR/lib/prompt-budget.sh"   # the declared caps the block honours
      . "$SCRIPT_DIR/lib/writer-prompt.sh"
      story_json=${JSON.stringify(JSON.stringify(story))}
      story_declared_file_blocks "$story_json"
      printf '%s' "$existing_file_contents"
    `], { encoding: 'utf8', timeout: 60_000 });
    return { out: (r.stdout || '') + (r.stderr || ''), status: r.status };
  }

  it('a greenfield story whose declared file exists is shown its contents', () => {
    const r = prompt({ brownfield: false, existing: 'MARKER_EXISTING_TESTS = 1\n' });
    expect(r.out, `the writer was told to write a file it cannot see:\n${r.out.slice(-600)}`).toContain('MARKER_EXISTING_TESTS');
  });

  it('a file that does not exist yet contributes nothing — there is nothing to show', () => {
    const r = prompt({ brownfield: false });
    expect(r.out.trim()).toBe('');
  });

  it('brownfield is unchanged — it always showed the file', () => {
    const r = prompt({ brownfield: true, existing: 'MARKER_EXISTING_TESTS = 1\n' });
    expect(r.out).toContain('MARKER_EXISTING_TESTS');
  });
});
