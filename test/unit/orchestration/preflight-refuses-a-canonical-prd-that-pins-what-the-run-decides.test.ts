/**
 * PRE-FLIGHT REFUSES A CANONICAL PRD THAT PINS WHAT THE RUN DECIDES — BEFORE ANY MODEL IS CALLED.
 *
 * A story's agent is the assigner's decision, its model the ladder's, its provider the set's. An
 * authored PRD that carries agentRole / model / aiProvider bypasses all three, and the mint then
 * refuses mid-run: "REGI-001 was assigned python-engineer, which is not in the roster" — after the
 * roster was minted, the prompts generated, the spend made (the other project's Run 3,
 * 2026-09-13). The same defect had been found on this repository's own greenfield PRD that
 * morning and fixed in the data; the engine still let a PRD from anywhere else reach the mint.
 *
 * The pre-flight's canonical branch used to say "Story field checks deferred — canonical PRD has
 * no implementation stories yet" and pass. It now reads the canonical stories and refuses the
 * launch, naming each story and field, so the correction costs nothing. An elaborated PRD (a
 * resume, a brownfield run after ingest) legitimately carries all three and is judged by the
 * existing assignment check instead. The block is lifted from the real script and executed.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const SRC = readFileSync(join(SCRIPTS, 'preflight-check.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function prdFileBlock(prd: object, canonical: boolean, resumeRun = '', pendingIngest = false) {
  const start = SRC.indexOf('# ── 4. PRD file valid JSON');
  const end = SRC.indexOf('# ── 4. Required API keys', start);
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
  const d = mkdtempSync(join(tmpdir(), 'pf-pins-')); dirs.push(d);
  const f = join(d, 'prd.json'); writeFileSync(f, JSON.stringify(prd));
  const script = `set -uo pipefail
SCRIPT_DIR=${JSON.stringify(SCRIPTS)}
. "$SCRIPT_DIR/lib/resume-semantics.sh"   # the block asks resume_preserves, as the real pre-flight does since 2026-09-20
PRD_FILE=${JSON.stringify(f)}; OUTPUT_DIR=/x; _prd_pending_ingest=${pendingIngest ? 1 : 0}; _codeline_root=""; _prd_is_canonical=${canonical ? 'true' : 'false'}
PASS=0; FAIL=0
ok(){ echo "OK: $*"; PASS=$((PASS+1)); }; fail(){ echo "FAIL: $*"; FAIL=$((FAIL+1)); }
${SRC.slice(start, end)}
echo "FAILS=$FAIL"`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...(resumeRun ? { EPAM_RESUME_RUN: resumeRun } : {}) } });
  const out = (r.stdout || '') + (r.stderr || '');
  return { out, fails: Number((out.match(/FAILS=(\d+)/) || [])[1]) };
}
const base = { project: { name: 'p', outputDir: '/x' }, stories: [
  { id: 'S-1', title: 'one', acceptanceCriteria: ['a'] },
  { id: 'S-2', title: 'two', acceptanceCriteria: ['b'] },
] };

describe('pre-flight refuses a canonical PRD that pins what the run decides', () => {
  it('THE DEFECT: a canonical story carrying agentRole is refused by name, before any spend', () => {
    const prd = structuredClone(base); (prd.stories[0] as any).agentRole = 'python-engineer';
    const r = prdFileBlock(prd, true);
    expect(r.fails, r.out).toBeGreaterThan(0);
    expect(r.out).toMatch(/S-1.*agentRole/);
    expect(r.out).not.toMatch(/Story field checks deferred/);
  });
  it('model and aiProvider pins are refused the same way, every story named', () => {
    const prd = structuredClone(base); (prd.stories[0] as any).model = 'some-model'; (prd.stories[1] as any).aiProvider = 'some-vendor';
    const r = prdFileBlock(prd, true);
    expect(r.fails, r.out).toBeGreaterThan(0);
    expect(r.out).toMatch(/S-1.*model/); expect(r.out).toMatch(/S-2.*aiProvider/);
  });
  it("a PRD the run's own Jira ingest OVERWRITES is not refused for the previous run's assignments — deferred, and said", () => {
    // £0 replay of a Sept 9 brownfield cassette, 2026-09-17: the previous run's synthesised PRD sat
    // at the path ingest writes to, carrying its own agentRole, and the second launch was refused.
    const pinned = { ...base, stories: [{ ...base.stories[0], agentRole: 'checkout-validation-engineer' }, base.stories[1]] };
    const r = prdFileBlock(pinned, true, '', true);
    expect(r.fails).toBe(0);
    expect(r.out).toMatch(/Jira ingest overwrites this exact file .* deferred/);
    // And with NO ingest pending the same PRD is still refused — the deferral is the ingest's, not a loophole.
    expect(prdFileBlock(pinned, true, '', false).fails).toBeGreaterThan(0);
  });

  it('a canonical PRD that pins nothing passes', () => {
    const r = prdFileBlock(base, true);
    expect(r.fails, r.out).toBe(0);
    expect(r.out).toMatch(/pins no agent, model or provider/);
  });
  it('an elaborated PRD is not judged by this check — a resume legitimately carries all three', () => {
    const prd = structuredClone(base); Object.assign(prd.stories[0] as any, { agentRole: 'x', model: 'm', aiProvider: 'v' });
    const r = prdFileBlock(prd, false);
    expect(r.out).not.toMatch(/pins/);
  });
  it('A RESUME IS NOT JUDGED BY THIS CHECK, whatever the canonical test says of its PRD — the assignments are the run\'s own', () => {
    // The brownfield rehearsal's synthesised PRD has no split story, so prd-is-canonical calls it
    // canonical on resume; the pin refusal then aborted every resume on the run\'s own assignments
    // (£0 brownfield harness run 5, 2026-09-14).
    const prd = structuredClone(base); Object.assign(prd.stories[0] as any, { agentRole: 'x', model: 'm', aiProvider: 'v' });
    const r = prdFileBlock(prd, true, '20260914T000000Z');
    expect(r.out).not.toMatch(/pins/);
    expect(r.fails).toBe(0);
  });
});
