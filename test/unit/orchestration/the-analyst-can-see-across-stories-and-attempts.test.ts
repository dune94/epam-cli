/**
 * THE ANALYST CAN SEE ACROSS STORIES AND ACROSS ATTEMPTS — AND SAY WHERE THE FIX BELONGS.
 *
 * regintel 20260919T224649Z: 30 healing events, 21 prescriptions, 0 patches applied, 4 of 5
 * stories unhealed. Every diagnosis was correct for the one story it read and wrong for the run:
 * 005b was told "never async", 005a "always async", 007a "accept both". Each analyst saw only its
 * story's tests, prescribed a rewrite of a file the writer was forbidden to touch (six times),
 * and re-derived attempt 1's diagnosis on attempt 4 from the same evidence — it received a
 * boolean "repeated", not the record. Self-heal was stateless, story-local and writer-directed;
 * the failures were cross-story, cross-attempt and out-of-scope.
 *
 * Inputs: the writer's scope (what it may touch, who owns the rest); other stories' criteria on
 * this story's files; the healing history (what was prescribed, what the writer did, what came
 * back). Outputs: targets `escalate` (the fix is in another story's file → filed as an
 * escalation, the same record the tool writes), `spec` (another story's criterion is the
 * defect → patched through the change reviewer), `environment` (not the writer's fault → no
 * ladder spent); `evidence` and `expected_outcome` on every answer. A per-story summary of
 * diagnosed → prescribed → outcome is written when the story ends. Both modes, every provider.
 * Executed with real fixtures; only the model is absent.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/failure-healing.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PRD = { stories: [
  { id: 'REGI-004a', status: 'completed', technicalNotes: { files: ['regintel/classifier.py'] } },
  { id: 'REGI-004b', status: 'completed', technicalNotes: { files: ['tests/test_classifier.py'] }, testCriteria: { sourceFiles: ['regintel/classifier.py'], facts: ['classify_event is an async function with signature classify_event(event, client=None, sink=None)'] } },
  { id: 'AMSD-9', status: 'completed', technicalNotes: { files: ['src/cart.ts'] }, verificationCriteria: ['the cart total includes the promo discount'] },
  { id: 'REGI-005b', status: 'in-progress', technicalNotes: { files: ['tests/test_escalation.py'] }, testCriteria: { sourceFiles: ['regintel/classifier.py'], facts: ['classify_event(conn, event_row) is synchronous'] } },
] };

function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'analyst-sees-')); dirs.push(d);
  const logs = join(d, 'logs'); mkdirSync(logs);
  writeFileSync(join(d, 'prd.json'), JSON.stringify(PRD));
  writeFileSync(join(logs, 'healing-events.jsonl'), [
    { ts: 't1', story_id: 'REGI-005b', retry: 0, rung: 0, target: 'skill', diagnosis: 'classify_event is async; TC8 requires sync', patches_applied: 0 },
    { ts: 't2', story_id: 'REGI-005b', retry: 1, rung: 0, target: 'skill', diagnosis: 'classify_event still async', patches_applied: 0 },
    { ts: 't3', story_id: 'OTHER-1', retry: 0, rung: 0, target: 'none', diagnosis: 'unrelated', patches_applied: 0 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(logs, 'run-guidance.jsonl'), [
    { storyId: 'REGI-005b', note: 'Always: rewrite regintel/classifier.py as synchronous', target: 'skill' },
    { storyId: 'REGI-005b', note: 'Never define classify_event as async', target: 'skill' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { d, logs };
}
function sh(f: ReturnType<typeof fixture>, cmd: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)} 2>/dev/null; PROJECT_ROOT=${JSON.stringify(f.d)}; LOG_DIR=${JSON.stringify(f.logs)}; PRD_FILE=${JSON.stringify(join(f.d, 'prd.json'))}; MAIN_PRD_FILE=$PRD_FILE; log(){ echo "LOG: $*"; }; warning(){ echo "WARN: $*"; }; error(){ echo "ERR: $*"; }; ${cmd}`], { encoding: 'utf8', env: { ...process.env, ...env } });
  return `${r.stdout}${r.stderr}`;
}

describe('inputs', () => {
  it('write scope: what this story may touch, and who owns the rest', () => {
    const out = sh(fixture(), '_analyst_write_scope REGI-005b');
    expect(out).toMatch(/tests\/test_escalation\.py/);
    expect(out).toMatch(/regintel\/classifier\.py[^\n]*REGI-004a/);
  });
  it('shared criteria: other stories\' criteria on this story\'s source files — TC facts (greenfield) and VCs (brownfield) alike', () => {
    const f = fixture();
    const out = sh(f, '_analyst_shared_criteria REGI-005b');
    expect(out).toMatch(/REGI-004b on regintel\/classifier\.py:/);
    expect(out).toMatch(/async function/);
    expect(out).not.toMatch(/unrelated|cart/);
    // brownfield shape: a VC on a file this story declares
    const prd = JSON.parse(JSON.stringify(PRD)); prd.stories.push({ id: 'AMSD-10', status: 'in-progress', technicalNotes: { files: ['src/cart.ts'] } });
    writeFileSync(join(f.d, 'prd.json'), JSON.stringify(prd));
    expect(sh(f, '_analyst_shared_criteria AMSD-10')).toMatch(/AMSD-9 on src\/cart\.ts:\n\s+\* the cart total includes the promo discount/);
  });
  it('healing history: this story\'s prior diagnoses and prescriptions, in order, and that none resolved it', () => {
    const out = sh(fixture(), '_analyst_healing_history REGI-005b');
    expect(out).toMatch(/attempt 1[\s\S]*TC8 requires sync[\s\S]*rewrite regintel\/classifier\.py/);
    expect(out).toMatch(/attempt 2[\s\S]*still async/);
    expect(out).not.toMatch(/unrelated/);
    expect(out).toMatch(/did not resolve|not resolved|still failing/i);
  });
  it('is empty for a story with no history', () => {
    expect(sh(fixture(), '_analyst_healing_history REGI-004a').trim()).toBe('');
  });
  it('the template declares the three inputs', () => {
    const tpl = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/failure-analyst.json'), 'utf8'));
    for (const p of ['__WRITE_SCOPE__', '__SHARED_CRITERIA__', '__HEALING_HISTORY__']) { expect(tpl.placeholders).toContain(p); expect(tpl.body).toContain(p); }
    expect(tpl.mayBeEmpty).toContain('__SHARED_CRITERIA__'); expect(tpl.mayBeEmpty).toContain('__HEALING_HISTORY__');
    expect(readFileSync(LIB, 'utf8')).toMatch(/"__WRITE_SCOPE__":\$write_scope/);
  });
});

describe('outputs', () => {
  it('the prompt offers escalate, spec and environment, and asks for evidence and expected_outcome', () => {
    const body = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/failure-analyst.json'), 'utf8')).body;
    for (const t of ['target=escalate', 'target=spec', 'target=environment']) expect(body).toContain(t);
    expect(body).toMatch(/"evidence"/); expect(body).toMatch(/"expected_outcome"/);
    expect(body).toMatch(/"escalation"/);
  });
  it('the contract carries the new fields', () => {
    const c = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/seam-output-contracts.json'), 'utf8')).seams['impl-failure-analyst'];
    expect(c.shapes.evidence).toBe('string'); expect(c.shapes.expected_outcome).toBe('string');
  });
  it('escalate: files the escalation record the resolver reads — the same record the writer\'s tool writes', () => {
    const f = fixture();
    const out = sh(f, `_apply_analyst_escalation REGI-005b '{"target":"escalate","diagnosis":"classify_event is async","escalation":{"targetFile":"regintel/classifier.py","ownerStoryId":"REGI-004a","requiredFix":"make classify_event synchronous"}}'`);
    const rec = JSON.parse(readFileSync(join(f.d, '.epam/escalations/REGI-005b.json'), 'utf8'));
    expect(rec.targetFile, out).toBe('regintel/classifier.py');
    expect(rec.requiredFix).toMatch(/synchronous/);
    expect(rec.filedBy).toBe('failure-analyst');
  });
  it('escalate refuses a file inside the story\'s own scope — that is a skill note, not an escalation', () => {
    const f = fixture();
    const out = sh(f, `_apply_analyst_escalation REGI-005b '{"escalation":{"targetFile":"tests/test_escalation.py","requiredFix":"x"}}'; echo "RC=$?"`);
    expect(out).toMatch(/RC=1/);
    expect(existsSync(join(f.d, '.epam/escalations/REGI-005b.json'))).toBe(false);
  });
  it('spec: patches another story\'s criterion through the change reviewer; a rejection reverts it', () => {
    const f = fixture();
    const patch = `'[{"storyId":"REGI-004b","index":0,"new_text":"classify_event(conn, event_row) is a synchronous function returning ClassificationRecord"}]'`;
    const ok = sh(f, `run_prd_change_reviewer(){ echo pass; }; _apply_reviewed_tc_patches REGI-005b ${patch}; jq -r '.stories[]|select(.id=="REGI-004b")|.testCriteria.facts[0]' "$PRD_FILE"`);
    expect(ok).toMatch(/synchronous function returning/);
    const f2 = fixture();
    const rej = sh(f2, `run_prd_change_reviewer(){ echo fail; }; _apply_reviewed_tc_patches REGI-005b ${patch}; jq -r '.stories[]|select(.id=="REGI-004b")|.testCriteria.facts[0]' "$PRD_FILE"`);
    expect(rej).toMatch(/async function/);
    expect(rej).not.toMatch(/synchronous function returning/);
  });
  it('the dispatch has the three new branches and environment spends no ladder', () => {
    const src = readFileSync(LIB, 'utf8');
    expect(src).toMatch(/^\s*escalate\)/m); expect(src).toMatch(/^\s*spec\)/m); expect(src).toMatch(/^\s*environment\)/m);
    const at = src.search(/^\s*environment\)/m);
    const env = src.slice(at, at + 900);
    expect(env).toMatch(/COORDINATOR_ESCALATE="no"/);
  });
});

describe('the record and the summary', () => {
  it('the recorder keeps the prescription, evidence and expected outcome with the event', () => {
    const f = fixture();
    sh(f, `run_healing_recorder REGI-005b 2 skill "d" 0 false "Never make it async" "read classifier.py:241" "test_escalation passes"`);
    const last = readFileSync(join(f.logs, 'healing-events.jsonl'), 'utf8').trim().split('\n').pop()!;
    const e = JSON.parse(last);
    expect(e.note).toBe('Never make it async'); expect(e.evidence).toBe('read classifier.py:241'); expect(e.expected_outcome).toBe('test_escalation passes');
  });
  it('a per-story summary is written when the story ends: diagnosed → prescribed → outcome', () => {
    const f = fixture();
    const out = sh(f, 'write_healing_summary REGI-005b failed');
    const p = join(f.logs, 'healing-summary', 'REGI-005b.md');
    expect(existsSync(p), out).toBe(true);
    const md = readFileSync(p, 'utf8');
    expect(md).toMatch(/REGI-005b/); expect(md).toMatch(/failed/); expect(md).toMatch(/TC8 requires sync/); expect(md).toMatch(/rewrite regintel\/classifier\.py/);
    expect(md).toMatch(/2 attempt|attempts: 2/i);
    expect(out).toMatch(/\[SelfHeal\]/);
  });
  it('the story loop writes the summary on both outcomes', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/lib/story-attempt.sh'), 'utf8');
    expect((src.match(/write_healing_summary "\$story_id" "completed"/g) || []).length).toBeGreaterThanOrEqual(1);
    expect((src.match(/write_healing_summary "\$story_id" "failed"/g) || []).length).toBeGreaterThanOrEqual(1);
  });
});
