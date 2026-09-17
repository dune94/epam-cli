/**
 * A RESUME RE-QUEUES WHAT FAILED, AND ONLY THAT.
 *
 * regintel run 20260916T200108Z, 2026-09-17: resume 1 failed REGI-001a and REGI-001b (8 attempts
 * each) and the orchestrator's last words were "recovery was NOT exhausted ... ladder still below
 * its top rung". Resume 2 was refused at pre-flight on exactly those two stories: a resume runs
 * without --reset (a reset tears down completed phases), so nothing had put them back to pending.
 *
 * Two halves, both executed here: the pre-flight integrity audit accepts a failed, uncompleted
 * story on EPAM_RESUME_RUN (preflight-integrity.test.ts), and the orchestrator's resume re-queue —
 * the block below, taken from run-agent-orchestration.sh by its own marker and run with bash
 * against a PRD file — flips failed+uncompleted to pending and touches nothing else.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function requeueBlock(): string {
  const src = engineSource(ORCH);
  const start = src.indexOf('# A RESUME RE-QUEUES WHAT FAILED, AND ONLY THAT.');
  expect(start, 'the resume re-queue block is not in the orchestrator').toBeGreaterThan(-1);
  const end = src.indexOf('# (end of the resume re-queue)', start);
  expect(end, 'the block\'s end marker is missing').toBeGreaterThan(start);
  return src.slice(start, end);
}

function run(prd: object, env: Record<string, string>, checkpoint: object[] = []) {
  const d = mkdtempSync(join(tmpdir(), 'requeue-')); dirs.push(d);
  const prdFile = join(d, 'prd.json');
  writeFileSync(prdFile, JSON.stringify(prd, null, 2));
  const ckFile = join(d, 'checkpoint-scaffold-x.jsonl');
  if (checkpoint.length) writeFileSync(ckFile, checkpoint.map((c) => JSON.stringify(c)).join('\n') + '\n');
  const script = `set -uo pipefail\nsuccess(){ echo "SUCCESS: $*"; }\nlog(){ :; }\n${requeueBlock()}`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PRD_FILE: prdFile, CHECKPOINT_FILE: ckFile, RESET_STORIES: 'false', EPAM_RESUME_RUN: '', ...env } });
  const ck = existsSync(ckFile) ? readFileSync(ckFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r, prd: JSON.parse(readFileSync(prdFile, 'utf8')), ck };
}

const fixture = () => ({
  stories: [
    { id: 'REGI-001a', status: 'failed', completed: false },
    { id: 'REGI-001b', status: 'failed', completed: false },
    { id: 'REGI-000', status: 'completed', completed: true },
    { id: 'REGI-002', status: 'pending', completed: false },
    { id: 'REGI-001', status: 'deprecated', completed: true },
    { id: 'REGI-003', status: 'blocked', completed: false },
  ],
});

describe('a resume re-queues what failed, and only that', () => {
  it("run 200108Z's shape: on a resume the two failed stories go back to pending; completed, pending and deprecated are untouched", () => {
    const { r, prd } = run(fixture(), { EPAM_RESUME_RUN: '20260916T200108Z' });
    expect(r.status, r.stderr).toBe(0);
    const by = Object.fromEntries(prd.stories.map((s: any) => [s.id, s]));
    expect(by['REGI-001a'].status).toBe('pending');
    expect(by['REGI-001b'].status).toBe('pending');
    expect(by['REGI-000']).toEqual({ id: 'REGI-000', status: 'completed', completed: true });
    expect(by['REGI-002'].status).toBe('pending');
    expect(by['REGI-001']).toEqual({ id: 'REGI-001', status: 'deprecated', completed: true });
    // 'blocked' by the inline TC gate (a test story whose impl sibling had not been written) is retried too.
    expect(by['REGI-003'].status).toBe('pending');
    expect(r.stdout).toMatch(/re-queued failed\/blocked story\/ies for retry — REGI-001a, REGI-001b, REGI-003/);
  });

  it("stale checkpoint records go — for re-queued stories AND for a story an earlier resume already set pending; a completed story keeps its record", () => {
    // Resume on 2.0.48 skipped 001a/b as 'already completed in checkpoint'; the 2.0.49 resume
    // found 001a already pending (re-queued earlier) with its stale record still there.
    const rec = (id: string) => ({ idempotencyKey: `x:scaffold:${id}`, storyId: id, phase: 'scaffold', runId: 'x', status: 'completed' });
    const { ck, r } = run(fixture(), { EPAM_RESUME_RUN: 'x' }, [rec('REGI-001a'), rec('REGI-001b'), rec('REGI-000'), rec('REGI-002')]);
    expect(ck.map((c) => c.storyId)).toEqual(['REGI-000']);
    expect(r.stdout).toMatch(/dropped stale checkpoint record\(s\).*REGI-001a REGI-001b REGI-002/);
  });

  it('a resume with only sound checkpoint records drops nothing and says nothing about them', () => {
    const rec = (id: string) => ({ idempotencyKey: `x:scaffold:${id}`, storyId: id, phase: 'scaffold', runId: 'x', status: 'completed' });
    const { ck, r } = run(fixture(), { EPAM_RESUME_RUN: 'x' }, [rec('REGI-000')]);
    expect(ck.map((c) => c.storyId)).toEqual(['REGI-000']);
    expect(r.stdout).not.toMatch(/dropped stale/);
  });

  it('a FRESH launch (no EPAM_RESUME_RUN) changes nothing here — that is --reset\'s job', () => {
    const { prd, r } = run(fixture(), {});
    expect(prd).toEqual(fixture());
    expect(r.stdout).not.toMatch(/re-queued/);
  });

  it('a --reset launch does not run this block twice over the same stories', () => {
    const { prd, r } = run(fixture(), { EPAM_RESUME_RUN: 'x', RESET_STORIES: 'true' });
    expect(prd).toEqual(fixture());
    expect(r.stdout).not.toMatch(/re-queued/);
  });

  it('a resume with nothing failed says nothing and leaves the PRD byte-identical', () => {
    const clean = { stories: [{ id: 'A', status: 'pending', completed: false }] };
    const { prd, r } = run(clean, { EPAM_RESUME_RUN: 'x' });
    expect(prd).toEqual(clean);
    expect(r.stdout).toBe('');
  });
});
