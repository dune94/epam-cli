/**
 * A LANE WHOSE SPEC INPUTS CHANGED IS SPECIFIED AGAIN ON RESUME — AND A COMPLETED LANE IS KEPT.
 *
 * AMSD-2974, 2026-10-04: the gotransit lane resumed a spec approved before today's dependency facts.
 * It told the writer to bump a version its SI now forbids, and twelve opus attempts each concluded
 * "nothing to change". The checkpoint recorded nothing of what the spec was built from.
 *
 * Operator-approved: each pre-writer checkpoint records a digest of the lane's spec inputs (declared in
 * config/spec-inputs.json — the templates and base SIs of the seams producing the spec, and the SI
 * contract's sections). On resume: a lane whose working story is completed is kept; a lane whose
 * recorded digest matches is kept; otherwise it is specified again (and stops at pause 2).
 * EXECUTED: the real handler, the real decision, the real save_run_checkpoint.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations');
const HANDLER = join(ORCH, 'scripts/lib/handlers/spec-inputs-digest.js');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A copy of the engine's inputs, to change one of them without touching the real ones. */
function engineCopy() {
  const d = mkdtempSync(join(tmpdir(), 'spec-inputs-')); dirs.push(d);
  for (const sub of ['agents', 'prompts/templates', 'config']) cpSync(join(ORCH, sub), join(d, sub), { recursive: true });
  return d;
}
const digest = (o: string) => spawnSync(process.execPath, [HANDLER, o], { encoding: 'utf8' }).stdout.trim();

describe('the spec-inputs digest', () => {
  it('is stable while nothing changed', () => {
    const o = engineCopy();
    expect(digest(o)).toMatch(/^[0-9a-f]{64}$/);
    expect(digest(o)).toBe(digest(o));
    expect(digest(o), 'the copy and the engine disagree with nothing changed').toBe(digest(ORCH));
  });
  it('moves when a spec seam\'s template changes', () => {
    const o = engineCopy(); const before = digest(o);
    const f = join(o, 'prompts/templates/code-graph-detective.json');
    const j = JSON.parse(readFileSync(f, 'utf8')); j.version = (j.version || 0) + 1; writeFileSync(f, JSON.stringify(j));
    expect(digest(o)).not.toBe(before);
  });
  it('moves when the SI contract\'s dependency section changes', () => {
    const o = engineCopy(); const before = digest(o);
    const f = join(o, 'config/agent-contract.json');
    const j = JSON.parse(readFileSync(f, 'utf8')); j.brownfieldSiblingPackages = `${j.brownfieldSiblingPackages} (changed)`; writeFileSync(f, JSON.stringify(j));
    expect(digest(o)).not.toBe(before);
  });
  it('does not move for a template no spec seam runs', () => {
    const o = engineCopy(); const before = digest(o);
    const f = join(o, 'prompts/templates/update-invalidated-tests.json');
    const j = JSON.parse(readFileSync(f, 'utf8')); j.version = (j.version || 0) + 1; writeFileSync(f, JSON.stringify(j));
    expect(digest(o)).toBe(before);
  });
});

function lane(opts: { completed: boolean; recorded?: string }) {
  const d = mkdtempSync(join(tmpdir(), 'lane-resume-')); dirs.push(d);
  mkdirSync(join(d, 'ckpt'));
  writeFileSync(join(d, 'ckpt', 'checkpoint.json'), JSON.stringify({ stage: 'pre-writer', ...(opts.recorded !== undefined ? { specInputsDigest: opts.recorded } : {}) }));
  writeFileSync(join(d, 'work.json'), JSON.stringify({ stories: [{ id: 'S-1', completed: opts.completed }] }));
  return d;
}
const decide = (d: string) => spawnSync('bash', ['-c', `log(){ echo "LOG $*"; }; warning(){ echo "WARN $*"; }
source ${JSON.stringify(join(ORCH, 'scripts/lib/run-checkpoint.sh'))}
lane_spec_is_current ${JSON.stringify(join(d, 'ckpt'))} ${JSON.stringify(join(d, 'work.json'))}; echo "RC=$?"`],
  { encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath, AUTOMATION_DIR: ORCH } }).stdout;

describe('the resume decision', () => {
  it('a lane whose story is completed is kept, whatever its checkpoint recorded', () => {
    expect(decide(lane({ completed: true }))).toMatch(/RC=0/);
  });
  it('a lane whose recorded digest matches today\'s is kept', () => {
    expect(decide(lane({ completed: false, recorded: digest(ORCH) }))).toMatch(/RC=0/);
  });
  it('a lane whose checkpoint recorded no digest is specified again, and says why', () => {
    const out = decide(lane({ completed: false }));
    expect(out).toMatch(/RC=1/);
    expect(out).toMatch(/spec/i);
  });
  it('a lane whose recorded digest differs is specified again', () => {
    expect(decide(lane({ completed: false, recorded: 'f'.repeat(64) }))).toMatch(/RC=1/);
  });
});

describe('the checkpoint records it', () => {
  it('save_run_checkpoint writes today\'s spec-inputs digest', () => {
    const d = mkdtempSync(join(tmpdir(), 'ckpt-save-')); dirs.push(d);
    writeFileSync(join(d, 'prd.json'), JSON.stringify({ stories: [] }));
    const r = spawnSync('bash', ['-c', `log(){ :; }; warning(){ :; }; info(){ :; }
source ${JSON.stringify(join(ORCH, 'scripts/lib/run-checkpoint.sh'))}
checkpoint_dir(){ echo ${JSON.stringify(join(d, 'out'))}; }
operator_reviewable_inputs(){ :; }; run_owned_roster_files(){ :; }; run_owned_prompts_dir(){ :; }
save_run_checkpoint core pre-writer`], { encoding: 'utf8', env: { ...process.env, PRD_FILE: join(d, 'prd.json'), NODE_BIN: process.execPath, AUTOMATION_DIR: ORCH } });
    const ck = JSON.parse(readFileSync(join(d, 'out', 'checkpoint.json'), 'utf8'));
    expect(ck.specInputsDigest, r.stderr).toBe(digest(ORCH));
  });
});
