/**
 * STEP 10 DECIDES WHETHER THE TEST-CRITERIA WRITER RUNS AT ALL, AND IT KNEW ONE CONVENTION.
 *
 * The orchestrator's gate matched `endswith(".test.ts")` inline. post-impl-tc-writer.sh — the
 * script this gate exists to invoke — already asks lib/handlers/_testfile.py, which recognises
 * .spec., .test., _spec., _test., test_* and __tests__/.
 *
 * So on a project using any other convention the gate counted 0 stories, never invoked the writer,
 * and reported "all TCs present". The second copy of the same match then reported nothing still
 * missing, so the gate PASSED. A gate that silently answers "nothing to do" on every project but
 * one is not a gate — and test criteria are what "done" means for greenfield and for novel
 * brownfield work, where the bug-reproduction gate has no prior bug to reproduce.
 *
 * These run the real handler and the gate's real shell against a PRD fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const HANDLER = join(SCRIPTS, 'lib/handlers/tc-stories-needing-criteria.py');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const TCW = join(SCRIPTS, 'post-impl-tc-writer.sh');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'tc-gate-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

/** A phase whose test stories use conventions other than .test.ts. */
function prd(): string {
  const p = join(work, 'prd.json');
  writeFileSync(p, JSON.stringify({
    implementationOrder: { P1: ['S1', 'S2', 'S3', 'S4'] },
    stories: [
      { id: 'S1', technicalNotes: { files: ['src/a.spec.ts'] }, testCriteria: { facts: [] } },
      { id: 'S2', technicalNotes: { files: ['tests/test_calc.py'] }, testCriteria: { facts: [] } },
      { id: 'S3', technicalNotes: { files: ['src/b.test.ts'] }, testCriteria: { facts: ['already here'] } },
      { id: 'S4', technicalNotes: { files: ['src/impl.ts'] }, testCriteria: { facts: [] } },
    ],
  }));
  return p;
}

/** Run the gate's own count expression, lifted from the script. */
function gateCount(prdPath: string): string {
  const src = readFileSync(ORCH, 'utf8');
  const i = src.indexOf('_tc_writer_needed=$(python3');
  expect(i, 'the gate no longer counts via the handler — this test is measuring nothing')
    .toBeGreaterThan(-1);
  const expr = src.slice(i, src.indexOf('\nfi', i));
  const r = spawnSync('bash', ['-c',
    `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; PHASE=P1; PRD_FILE=${JSON.stringify(prdPath)}
     ${expr}
     echo "$_tc_writer_needed"`,
  ], { encoding: 'utf8' });
  return r.stdout.trim();
}

describe('the TC gate fires on every test convention', () => {
  it('counts the stories a non-.test.ts project actually needs criteria for', () => {
    // S1 (.spec.ts) and S2 (test_*.py) need them. S3 already has them; S4 is not a test story.
    expect(gateCount(prd()), 'the gate skipped a project whose tests are not named *.test.ts')
      .toBe('2');
  });

  it('the handler and the gate agree — they are the same question', () => {
    const p = prd();
    const h = spawnSync('python3', [HANDLER, p, 'P1', ''], { encoding: 'utf8' });
    const ids = h.stdout.split('\n').filter(Boolean);
    expect(ids.sort()).toEqual(['S1', 'S2']);
    expect(gateCount(p)).toBe(String(ids.length));
  });

  it('the old inline match is what would have returned zero', () => {
    // Pins the defect: not a theory, the exact expression that shipped.
    const r = spawnSync('jq', ['-r', '--arg', 'phase', 'P1',
      '(.implementationOrder[$phase] // []) as $ids | [.stories[] | select(.id as $id | $ids | index($id)) '
      + '| select((.technicalNotes.files // [] | map(endswith(".test.ts")) | any) '
      + 'and ((.testCriteria.facts // []) | length == 0))] | length', prd()],
      { encoding: 'utf8' });
    expect(r.stdout.trim(), 'the old expression no longer reproduces the silent skip').toBe('0');
  });

  it('neither the gate nor its retry check names a file extension any more', () => {
    const body = readFileSync(ORCH, 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');   // comments record the removal
    expect(body, 'a test-file convention is still hardcoded in the gate')
      .not.toContain('endswith(".test.ts")');
  });

  it('still reports nothing to do when every test story already has criteria', () => {
    // The other direction: an over-eager gate invokes a paid writer on every phase forever.
    const p = join(work, 'done.json');
    writeFileSync(p, JSON.stringify({
      implementationOrder: { P1: ['S1'] },
      stories: [{ id: 'S1', technicalNotes: { files: ['src/a.spec.ts'] }, testCriteria: { facts: ['x'] } }],
    }));
    expect(gateCount(p)).toBe('0');
  });

  it('the writer refuses rather than inventing a prompt when its profile is missing', () => {
    // It substituted a one-sentence description of the job for the agent's minted profile,
    // silently — and those criteria go on to gate the phase.
    const body = readFileSync(TCW, 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(body, 'a placeholder prompt is still hardcoded in the writer')
      .not.toContain('You are the TC writer agent');
    expect(body, 'a missing profile no longer stops the writer').toMatch(/refusing to write test criteria/);
  });
});
