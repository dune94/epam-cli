/**
 * A RESUMED RUN'S OWN SPECIFICATION BLOCKS ARE NOT CONTAMINATION.
 *
 * prd-remediate.sh refuses a "canonical" PRD whose pending stories carry a specification block —
 * on a fresh run that is a previous run's leftovers, and the spec coordinator would skip
 * re-elaboration because of it (2026-07-06). On a RESUME the same block is this run's own spec
 * pass, and the story is pending only because the run paused before the writer: the regintel
 * run 20260915T101555Z could not resume — REGI-001 refused as "pre-baked" (2026-09-15). The
 * --mid-phase-retry path already states the rule ("spec-pass already ran this invocation"); a
 * resume is the same case. Executed through the real script, both ways.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/prd-remediate.sh');
const elaboratedPending = {
  project: { name: 'p' },
  implementationOrder: { scaffold: ['S-1'], core: ['S-2'] },
  stories: [
    { id: 'S-1', status: 'pending', completed: false, title: 't', description: 'd', acceptanceCriteria: ['a'], technicalNotes: { files: ['src/a.ts'] },
      specification: { runId: 'R1', status: 'completed', assignedAgents: ['openspec', 'speckit'], agentContributions: [{ agent: 'openspec', applied: true }] } },
    { id: 'S-2', status: 'pending', completed: false, title: 't2', description: 'd2', acceptanceCriteria: ['b'], technicalNotes: { files: ['src/b.ts'] } },
  ],
};
function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'resume-spec-')); const p = join(dir, 'prd.json'); writeFileSync(p, JSON.stringify(elaboratedPending));
  const r = spawnSync('bash', [SCRIPT, '--prd', p, '--phase', 'scaffold'], { encoding: 'utf8', env: { ...process.env, ...env } });
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
describe("a resumed run's own specification blocks are not contamination", () => {
  it('on a fresh run the guard still refuses a pending story with a pre-baked specification block', () => {
    const r = run({ EPAM_RESUME_RUN: '' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/pre-baked 'specification' blocks/);
  });
  it('on a resume (EPAM_RESUME_RUN set) the same PRD passes — the block is this run\'s own spec pass', () => {
    const r = run({ EPAM_RESUME_RUN: 'R1' });
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/pre-baked/);
  });
});
