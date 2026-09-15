/**
 * AN ORPHANED STORY IS PUT BACK, NOT ABORTED ON.
 *
 * The July 12 gate (_prd_remediate_impl.py step 7) found a pending story missing from every phase
 * and stopped the run with "fix the PRD manually" — an instruction to a human the pipeline does
 * not have. On the regintel greenfield run of 2026-09-15 that was how $9 ended: a placeholder
 * split child (`id:"optional"`) displaced REGI-001, and the gate aborted at the phase boundary.
 * The check is right; its remedy was always knowable: a placeholder story is dropped and its
 * deprecated parent restored to pending; a real orphan is put into the phase being remediated.
 * The run continues. Exit non-zero only when a story cannot be placed.
 *
 * Runs before every phase in BOTH modes; driven here with brownfield-shaped ids (codeline suffix)
 * and the greenfield shape the existing gate test carries.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IMPL_PY = join(__dirname, '../../../orchestrations/scripts/_prd_remediate_impl.py');

function run(prd: object, phase: string) {
  const dir = mkdtempSync(join(tmpdir(), 'prd-orphan-repair-')); const p = join(dir, 'prd.json');
  writeFileSync(p, JSON.stringify(prd));
  const r = spawnSync('python3', [IMPL_PY, p, phase], { encoding: 'utf8' });
  const exitCode = r.status ?? -1; const stderr = String(r.stderr || '');
  const after = JSON.parse(readFileSync(p, 'utf8')); rmSync(dir, { recursive: true, force: true });
  return { exitCode, stderr, after };
}

describe('an orphaned story is put back, not aborted on', () => {
  it('BROWNFIELD shape: a placeholder child that displaced a ticket is dropped, the ticket restored, and the run continues', () => {
    const { exitCode, stderr, after } = run({
      implementationOrder: { scaffold: [], core: ['MOCK-HW-2-mockhelloworld'] },
      stories: [
        { id: 'MOCK-HW-1-mockhelloworld', status: 'deprecated', completed: false, technicalNotes: { files: ['src/hello.ts'] }, specification: { splitIds: ['optional'] } },
        { id: 'optional', title: '...', description: '...', status: 'pending', completed: false, acceptanceCriteria: ['...'], technicalNotes: { files: [] }, specification: { createdFrom: 'MOCK-HW-1-mockhelloworld' } },
        { id: 'MOCK-HW-2-mockhelloworld', status: 'pending', completed: false, technicalNotes: { files: ['src/bye.ts'] } },
      ],
    }, 'core');
    expect(exitCode, stderr).toBe(0);
    expect(stderr).not.toMatch(/FATAL/);
    expect(after.stories.map((s: any) => s.id)).not.toContain('optional');
    const parent = after.stories.find((s: any) => s.id === 'MOCK-HW-1-mockhelloworld');
    expect(parent.status).toBe('pending');
    expect(after.implementationOrder.core).toContain('MOCK-HW-1-mockhelloworld');
  });
  it('GREENFIELD shape: real stories orphaned by a corrupting write are put into the phase being remediated (the July 8 travel-app defect), not aborted on', () => {
    const { exitCode, stderr, after } = run({
      implementationOrder: { scaffold: ['SKY-001-impl'], core: [] },
      stories: [
        { id: 'SKY-001-impl', status: 'completed', completed: true, technicalNotes: { files: ['src/index.ts'] } },
        { id: 'SKY-002', status: 'pending', completed: false, technicalNotes: { workingDir: '/tmp/x' } },
        { id: 'SKY-003', status: 'pending', completed: false, technicalNotes: { workingDir: '/tmp/x' } },
      ],
    }, 'core');
    expect(exitCode, stderr).toBe(0);
    expect(stderr).not.toMatch(/FATAL/);
    expect(after.implementationOrder.core).toEqual(expect.arrayContaining(['SKY-002', 'SKY-003']));
    expect(stderr).toMatch(/REPAIRED/);
  });
  it('with no phase argument (fresh-run full reset) the orphan is placed in the first declared phase', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-orphan-repair-')); const p = join(dir, 'prd.json');
    writeFileSync(p, JSON.stringify({ implementationOrder: { scaffold: [], core: [] }, stories: [{ id: 'SKY-002', status: 'pending', completed: false, technicalNotes: { files: ['a.ts'] } }] }));
    const r = spawnSync('python3', [IMPL_PY, p], { encoding: 'utf8' });
    const after = JSON.parse(readFileSync(p, 'utf8')); rmSync(dir, { recursive: true, force: true });
    expect(r.status, String(r.stderr)).toBe(0);
    expect(after.implementationOrder.scaffold).toContain('SKY-002');
  });
});
