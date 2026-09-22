/**
 * A STORY THE RESUME RE-QUEUES STARTS ITS LADDER AFRESH.
 *
 * regintel 140717Z resume 3 (2026-09-21 17:24): the resume re-queued REGI-004-A and REGI-010-A —
 * both marked failed by the phantom fix loop — and each failed again in seconds with ZERO attempts:
 * "[InferenceLadder] resuming at retry_count=8 … Failed to implement after 8 attempts". Their
 * ladder counts were the wreckage of the earlier loop, and the same morning's fix (8df4f72a) had
 * made the resume keep story-retry-state/ — rightly, for a story continuing mid-ladder. A story the
 * remediation turns from failed back to pending is not continuing; it is starting over, and its
 * ladder starts over with it. The rung record of the failed attempt goes the same way — a
 * completed story will write a fresh one.
 *
 * Driven through the REAL prd-remediate.sh over the run's own shape.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/prd-remediate.sh');

function story(id: string, status: string, completed: boolean, extra: Record<string, unknown> = {}) {
  return {
    id, status, completed, title: id, description: `d ${id}`, acceptanceCriteria: [`ac ${id}`],
    aiProvider: 'openrouter', model: 'z-ai/glm-5.3', effort: 'medium',
    technicalNotes: { files: [`regintel/${id.toLowerCase()}.py`] },
    testCriteria: { facts: ['f'], sourceFiles: [`regintel/${id.toLowerCase()}.py`] },
    specification: { runId: 'R1', status: 'completed', assignedAgents: ['openspec'], agentContributions: [{ agent: 'openspec', applied: true }] },
    ...extra,
  };
}
const PRD = {
  project: { name: 'regintel', outputDir: '/tmp/regintel-requeue-fixture' },
  configuration: { protectedPaths: [] },
  implementationOrder: { scaffold: ['REGI-001'], core: ['REGI-002', 'REGI-003b', 'REGI-004-A', 'REGI-010-A'] },
  stories: [
    story('REGI-001', 'completed', true, { completedAt: '2026-09-21T14:40:00Z' }),
    story('REGI-002', 'completed', true, { completedAt: '2026-09-21T15:43:00Z' }),
    story('REGI-004-A', 'failed', false, { error: 'Failed to implement after 8 attempts' }),
    story('REGI-010-A', 'failed', false, { error: 'Failed to implement after 8 attempts' }),
    // Escalated: completed, then rejected by review with its ladder exhausted. Left as it is, every
    // resume re-reviews it on the same exhausted ladder and escalates again — a dead end. A resume
    // is the operator's answer to "human review required": the story goes round again, afresh.
    story('REGI-003b', 'completed', true, { completedAt: '2026-09-21T16:02:00Z', reviewStatus: 'escalated' }),
  ],
};

function remediate() {
  const dir = mkdtempSync(join(tmpdir(), 'requeue-ladder-'));
  const logDir = join(dir, 'logs'); mkdirSync(join(logDir, 'story-retry-state'), { recursive: true }); mkdirSync(join(logDir, 'story-rung'));
  for (const id of ['REGI-002', 'REGI-003b', 'REGI-004-A', 'REGI-010-A']) {
    writeFileSync(join(logDir, `story-retry-state/${id}.count`), id === 'REGI-002' ? '2' : '8');
    writeFileSync(join(logDir, `story-retry-state/${id}.model`), 'z-ai/glm-5.3');
    writeFileSync(join(logDir, `story-rung/${id}.json`), JSON.stringify({ model: 'z-ai/glm-5.3', provider: 'openrouter' }));
  }
  const p = join(dir, 'prd.json'); writeFileSync(p, JSON.stringify(PRD));
  const r = spawnSync('bash', [SCRIPT, '--prd', p, '--phase', 'core'], {
    encoding: 'utf8', env: { ...process.env, EPAM_RESUME_RUN: '20260921T140717Z', LOG_DIR: logDir },
  });
  const after = JSON.parse(readFileSync(p, 'utf8'));
  const by: Record<string, any> = {}; for (const s of after.stories) by[s.id] = s;
  const has = (rel: string) => existsSync(join(logDir, rel));
  const state = {
    a_count: has('story-retry-state/REGI-004-A.count'), a_model: has('story-retry-state/REGI-004-A.model'), a_rung: has('story-rung/REGI-004-A.json'),
    b_count: has('story-retry-state/REGI-010-A.count'),
    kept_count: has('story-retry-state/REGI-002.count'), kept_rung: has('story-rung/REGI-002.json'),
    esc_count: has('story-retry-state/REGI-003b.count'),
  };
  rmSync(dir, { recursive: true, force: true });
  return { out: `${r.stdout}\n${r.stderr}`, by, state };
}

describe('a story the resume re-queues starts its ladder afresh', () => {
  const r = remediate();

  it('the failed stories were re-queued (pending) — otherwise nothing below is tested', () => {
    expect(r.by['REGI-004-A'].status, r.out.slice(-800)).toBe('pending');
    expect(r.by['REGI-010-A'].status).toBe('pending');
  });

  it('their ladder state and failed-attempt rung are gone, so the first attempt is attempt 1', () => {
    expect(r.state.a_count, 'REGI-004-A still carries retry_count=8 — it will fail with zero attempts').toBe(false);
    expect(r.state.a_model).toBe(false);
    expect(r.state.a_rung).toBe(false);
    expect(r.state.b_count).toBe(false);
  });

  it("a completed story's ladder state and rung are untouched — the reviewer still needs them", () => {
    expect(r.by['REGI-002'].status).toBe('completed');
    expect(r.state.kept_count).toBe(true);
    expect(r.state.kept_rung).toBe(true);
  });

  it('an escalated story is re-queued too, afresh — a resume is the operator\'s answer to "human review required"', () => {
    expect(r.by['REGI-003b'].status).toBe('pending');
    expect(r.by['REGI-003b'].completed).toBe(false);
    expect(r.by['REGI-003b'].reviewStatus ?? null).toBeNull();
    expect(r.state.esc_count).toBe(false);
  });

  it('says what it did', () => {
    expect(r.out).toMatch(/ladder/i);
  });
});
