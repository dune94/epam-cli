/**
 * A RESUME RUNS THE SPEC PASS FOR THE STORIES THAT LACK IT — AND ONLY THOSE.
 *
 * The resume's run mode turns the spec pass off (EPAM_SPEC_MODE=0) unconditionally, and the spec
 * pass takes every pending story of a phase with no per-story skip. So a story whose elaboration
 * was lost — REGI-001's went to a placeholder child; the remediation restored its content from
 * canonical — reached the writer with no spec, paid for, on 2026-09-15. The rule: on a resume the
 * spec pass runs when a pending story carries no spec output, for those stories alone; the
 * remediation clears the spec block of a story whose content it restores, so it is one of them.
 * Executed: the handler, the remediation, the resume's decision, the spec pass's selection.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const HANDLER = join(ROOT, 'orchestrations/scripts/lib/handlers/stories-lacking-spec.js');
const IMPL_PY = join(ROOT, 'orchestrations/scripts/_prd_remediate_impl.py');
const RESUME_LIB = join(ROOT, 'orchestrations/scripts/lib/orchestration-resume.sh');
const specified = { specification: { runId: 'R1', status: 'completed', appliedAgents: ['openspec', 'speckit'] } };
const prd = {
  implementationOrder: { scaffold: ['S-1'], core: ['S-2', 'S-3'] },
  stories: [
    { id: 'S-1', status: 'pending', completed: false, title: 'restored', technicalNotes: { files: ['a.py'] } },
    { id: 'S-2', status: 'pending', completed: false, title: 't2', technicalNotes: { files: ['b.py'] }, ...specified },
    { id: 'S-3', status: 'completed', completed: true, title: 't3', technicalNotes: { files: ['c.py'] } },
  ],
};
function tmpPrd(p: object) { const d = mkdtempSync(join(tmpdir(), 'lack-spec-')); const f = join(d, 'x-prd.json'); writeFileSync(f, JSON.stringify(p)); return { d, f }; }

describe('a resume runs the spec pass for the stories that lack it', () => {
  it('the handler names the pending stories with no applied spec agents, per phase and overall', () => {
    const { d, f } = tmpPrd(prd);
    expect(spawnSync('node', [HANDLER, f, 'scaffold'], { encoding: 'utf8' }).stdout.trim()).toBe('S-1');
    expect(spawnSync('node', [HANDLER, f, 'core'], { encoding: 'utf8' }).stdout.trim()).toBe('');
    expect(spawnSync('node', [HANDLER, f], { encoding: 'utf8' }).stdout.trim()).toBe('S-1');
    rmSync(d, { recursive: true, force: true });
  });
  it('the remediation clears the spec block of a story whose content it restores, so the pass will take it', () => {
    const d = mkdtempSync(join(tmpdir(), 'lack-spec-')); const p = join(d, 'regintel-prd.json'); const canon = join(d, 'regintel-prd.canonical.json');
    const authored = { id: 'REGI-001', title: 'Scaffold', description: 'd', acceptanceCriteria: ['a', 'b'], technicalNotes: { files: ['x.py'] }, status: 'pending', completed: false };
    writeFileSync(canon, JSON.stringify({ stories: [authored], implementationOrder: { scaffold: ['REGI-001'] } }));
    writeFileSync(p, JSON.stringify({ implementationOrder: { scaffold: ['REGI-001'] }, stories: [{ ...authored, title: '...', acceptanceCriteria: ['...'], ...specified }] }));
    const r = spawnSync('python3', [IMPL_PY, p, 'scaffold'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const after = JSON.parse(readFileSync(p, 'utf8')).stories[0];
    expect(after.title).toBe('Scaffold');
    expect(after.specification, 'the stale spec block survived the content restore').toBeUndefined();
    expect(spawnSync('node', [HANDLER, p, 'scaffold'], { encoding: 'utf8' }).stdout.trim()).toBe('REGI-001');
    rmSync(d, { recursive: true, force: true });
  });
  it("the resume's decision: EPAM_SPEC_MODE=0 from the mode becomes 1 when a pending story lacks spec, and stays 0 when none does", () => {
    const { d, f } = tmpPrd(prd);
    const run = (prdFile: string) => spawnSync('bash', ['-c', `
      info(){ echo "INFO $*"; }; error(){ echo "ERR $*" >&2; }; success(){ :; }; warning(){ :; }
      SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}
      resume_spec_output_present(){ "\${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/resume-spec-output-present.js" "$1"; }
      . ${JSON.stringify(RESUME_LIB)}
      EPAM_SPEC_MODE=0; PRD_FILE=${JSON.stringify(prdFile)}; EPAM_RESUME_RUN=R1; PHASE=scaffold
      resume_spec_mode_for_pending_stories
      echo "EPAM_SPEC_MODE=$EPAM_SPEC_MODE"`], { encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath } });
    const r = run(f);
    expect(r.stdout, r.stderr).toMatch(/EPAM_SPEC_MODE=1/);
    expect(r.stdout).toMatch(/S-1/);
    const all = tmpPrd({ ...prd, stories: prd.stories.map((s) => ({ ...s, ...specified })) });
    expect(run(all.f).stdout).toMatch(/EPAM_SPEC_MODE=0/);
    rmSync(d, { recursive: true, force: true }); rmSync(all.d, { recursive: true, force: true });
  });
  it('the spec pass, on a resume, selects only the stories lacking spec', () => {
    process.env.SPEC_MODE_NO_MAIN = '1';
    const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
    expect(typeof spec.storiesForSpecPass).toBe('function');
    const idsResume = spec.storiesForSpecPass(prd, 'core', { resume: true }).map((s: any) => s.id);
    expect(idsResume).toEqual([]);
    const idsFresh = spec.storiesForSpecPass(prd, 'core', { resume: false }).map((s: any) => s.id);
    expect(idsFresh).toEqual(['S-2']);
    expect(spec.storiesForSpecPass(prd, 'scaffold', { resume: true }).map((s: any) => s.id)).toEqual(['S-1']);
  });
});
