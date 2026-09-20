/**
 * A RESUME NEVER RESETS A COMPLETED STORY.
 *
 * regintel 20260919T224649Z, resume 6 (2026-09-20): the resume was launched to retry ONE failed
 * core story (REGI-005b). The lifecycle correctly ran the orchestrator without --reset, and the
 * orchestrator correctly re-queued only the failed story — but the pre-phase remediation that
 * runs before it, prd-remediate.sh step 6, "reset 15 active stories to pending": every completed
 * core story was re-implemented, re-reviewed and re-gated ($20+ of the run's $43). The reset is
 * right for a launch from nothing; on a resume the completed flags ARE the run's progress.
 *
 * On a resume: completed stories keep status and completed=true; a story left in-progress or
 * failed is what the resume exists to retry and becomes pending. On a fresh launch (no
 * EPAM_RESUME_RUN) the full phase reset stays as it was. Executed through the real script.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/prd-remediate.sh');

// The live shape after the core phase aborted: scaffold GO and completed; core mostly completed,
// one failed, one still pending. Elaborated (specification present), so remediation runs the
// phase-scoped reset and the strict checks — the reset is the object under test.
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
  project: { name: 'regintel', outputDir: '/tmp/regintel-resume-reset-fixture' },
  configuration: { protectedPaths: [] },
  implementationOrder: { scaffold: ['REGI-001'], core: ['REGI-002', 'REGI-003', 'REGI-005b', 'REGI-006'] },
  stories: [
    story('REGI-001', 'completed', true, { completedAt: '2026-09-19T23:00:00Z' }),
    story('REGI-002', 'completed', true, { completedAt: '2026-09-20T00:10:00Z' }),
    story('REGI-003', 'completed', true, { completedAt: '2026-09-20T00:20:00Z' }),
    story('REGI-005b', 'failed', false, { error: 'tests failed' }),
    story('REGI-006', 'in-progress', false, { startedAt: '2026-09-20T02:00:00Z' }),
  ],
};

function remediate(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'resume-reset-'));
  const p = join(dir, 'prd.json'); writeFileSync(p, JSON.stringify(PRD));
  const r = spawnSync('bash', [SCRIPT, '--prd', p, '--phase', 'core'], { encoding: 'utf8', env: { ...process.env, ...env } });
  const after = JSON.parse(readFileSync(p, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  const by: Record<string, any> = {}; for (const s of after.stories) by[s.id] = s;
  return { out: `${r.stdout}\n${r.stderr}`, by };
}

describe('on a resume, prd-remediate keeps what the run has done', () => {
  const r = remediate({ EPAM_RESUME_RUN: 'R1' });

  it('a completed story in the phase stays completed', () => {
    expect(r.by['REGI-002'].completed, r.out).toBe(true);
    expect(r.by['REGI-002'].status).toBe('completed');
    expect(r.by['REGI-003'].completed).toBe(true);
  });

  it('its completion record is not stripped', () => {
    expect(r.by['REGI-002'].completedAt).toBe('2026-09-20T00:10:00Z');
  });

  it('a failed story is re-queued — that is what the resume is for', () => {
    expect(r.by['REGI-005b'].status).toBe('pending');
    expect(r.by['REGI-005b'].completed).toBe(false);
  });

  it('a story left in-progress by the kill is re-queued too', () => {
    expect(r.by['REGI-006'].status).toBe('pending');
  });

  it('never reports resetting the completed ones', () => {
    expect(r.out).not.toMatch(/reset [3-9]|reset \d\d+ active stories/);
  });
});

describe('on a fresh launch the phase reset is unchanged', () => {
  const r = remediate({ EPAM_RESUME_RUN: '' });

  it('every story in the phase goes back to pending, completed or not', () => {
    for (const id of ['REGI-002', 'REGI-003', 'REGI-005b', 'REGI-006']) {
      expect(r.by[id].status, id).toBe('pending');
      expect(r.by[id].completed, id).toBe(false);
    }
    expect(r.by['REGI-002'].completedAt).toBeUndefined();
  });

  it('a prior phase is still untouched either way', () => {
    expect(r.by['REGI-001'].completed).toBe(true);
    expect(remediate({ EPAM_RESUME_RUN: 'R1' }).by['REGI-001'].completed).toBe(true);
  });
});
