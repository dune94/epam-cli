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
// The example child the prompt shows, from where it is declared — never spelled here.
const EX = JSON.parse(readFileSync(join(__dirname, '../../../orchestrations/config/spec-split-example.json'), 'utf8')).child;

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
        { id: 'MOCK-HW-1-mockhelloworld', status: 'deprecated', completed: false, technicalNotes: { files: ['src/hello.ts'] }, specification: { splitIds: [EX.id] } },
        { ...EX, status: 'pending', completed: false, specification: { createdFrom: 'MOCK-HW-1-mockhelloworld' } },
        { id: 'MOCK-HW-2-mockhelloworld', status: 'pending', completed: false, technicalNotes: { files: ['src/bye.ts'] } },
      ],
    }, 'core');
    expect(exitCode, stderr).toBe(0);
    expect(stderr).not.toMatch(/FATAL/);
    expect(after.stories.map((s: any) => s.id)).not.toContain(EX.id);
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
  it('a parent whose content the placeholder split overwrote gets its content back from the canonical PRD', () => {
    // The split "redistributed" REGI-001's ACs to the placeholder child and left the parent with
    // title '...' and one AC of '...' (regintel run 20260915T101555Z). Placing it back is not enough;
    // the writer would build a story with no title and one '...' criterion. The canonical PRD
    // beside the working one (<name>.canonical.json) holds the authored content.
    const dir = mkdtempSync(join(tmpdir(), 'prd-orphan-repair-'));
    const p = join(dir, 'regintel-prd.json'); const canon = join(dir, 'regintel-prd.canonical.json');
    const authored = { id: 'REGI-001', title: 'Ingest the regulatory feed', description: 'Pull the feed on a schedule', acceptanceCriteria: ['a', 'b', 'c'], technicalNotes: { files: ['src/ingest.py'] }, effort: 'medium', estimatedHours: 6, status: 'pending', completed: false };
    writeFileSync(canon, JSON.stringify({ stories: [authored, { id: 'REGI-002', title: 't2', acceptanceCriteria: ['x'], technicalNotes: { files: ['b.py'] }, status: 'pending' }], implementationOrder: { scaffold: ['REGI-001'], core: ['REGI-002'] } }));
    writeFileSync(p, JSON.stringify({
      implementationOrder: { scaffold: [], core: ['REGI-002'] },
      stories: [
        { ...authored, title: EX.title, description: EX.description, acceptanceCriteria: EX.acceptanceCriteria, status: 'deprecated', specification: { splitIds: [EX.id], status: 'completed' } },
        { ...EX, status: 'pending', completed: false, specification: { createdFrom: 'REGI-001' } },
        { id: 'REGI-002', title: 't2', status: 'pending', completed: false, acceptanceCriteria: ['x'], technicalNotes: { files: ['b.py'] } },
      ],
    }));
    const r = spawnSync('python3', [IMPL_PY, p, 'scaffold'], { encoding: 'utf8' });
    const after = JSON.parse(readFileSync(p, 'utf8')); rmSync(dir, { recursive: true, force: true });
    expect(r.status, String(r.stderr)).toBe(0);
    const parent = after.stories.find((s: any) => s.id === 'REGI-001');
    expect(parent.status).toBe('pending');
    expect(parent.title).toBe(authored.title);
    expect(parent.description).toBe(authored.description);
    expect(parent.acceptanceCriteria).toEqual(authored.acceptanceCriteria);
    expect(parent.technicalNotes).toEqual(authored.technicalNotes);
    expect(after.implementationOrder.scaffold).toContain('REGI-001');
    expect(after.stories.map((s: any) => s.id)).not.toContain(EX.id);
  });
  it('a pending story whose own fields are the placeholders gets its authored fields back even when it is already placed (the regintel state after the child was dropped)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-orphan-repair-'));
    const p = join(dir, 'regintel-prd.json'); const canon = join(dir, 'regintel-prd.canonical.json');
    const authored = { id: 'REGI-001', title: 'Ingest the regulatory feed', description: 'Pull the feed on a schedule', acceptanceCriteria: ['a', 'b', 'c'], technicalNotes: { files: ['src/ingest.py'] }, status: 'pending', completed: false };
    writeFileSync(canon, JSON.stringify({ stories: [authored], implementationOrder: { scaffold: ['REGI-001'] } }));
    writeFileSync(p, JSON.stringify({ implementationOrder: { scaffold: ['REGI-001'] }, stories: [{ ...authored, title: EX.title, description: EX.description, acceptanceCriteria: EX.acceptanceCriteria, specification: { status: 'completed' } }] }));
    const r = spawnSync('python3', [IMPL_PY, p, 'scaffold'], { encoding: 'utf8' });
    const after = JSON.parse(readFileSync(p, 'utf8')); rmSync(dir, { recursive: true, force: true });
    expect(r.status, String(r.stderr)).toBe(0);
    const st = after.stories[0];
    expect(st.title).toBe(authored.title);
    expect(st.acceptanceCriteria).toEqual(authored.acceptanceCriteria);
    // Its elaboration described the content that was overwritten: cleared, so the resume's spec
    // pass takes the story again (operator, 2026-09-15: no writer stage on an un-specified story).
    expect(st.specification).toBeUndefined();
    expect(String(r.stderr)).toMatch(/REPAIRED/);
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
