/**
 * TEST CRITERIA AGREE ACROSS STORIES THAT SHARE A FILE.
 *
 * regintel 20260919T224649Z: REGI-004b's criteria fixed classify_event as
 * `async (event, client=, sink=)`; REGI-005b's TC writer, reading its own story's ACs, wrote
 * `def classify_event(conn, event_row, *, threshold)` — SYNCHRONOUS — and even wrote a
 * "CONFLICT NOTE" fact saying the existing tests disagreed. Nothing read the note. The two
 * contracts then fought for 20 attempts. Rule 4 of the TC writer ("the criterion wins over the
 * implementation") was right about the code and blind to the other story.
 *
 * Now: (1) the TC writer's brief carries the criteria OTHER stories already hold on each of its
 * source files, and any interface the story declared it consumes; (2) the prompt says those are
 * the contract in force — write consistent facts, and report a genuine need to change that
 * contract in `conflictsWith` instead of writing a contradicting fact; (3) the gate sends a
 * reported conflict to the prd-change-reviewer, and a rejection becomes the writer's corrective
 * note on its next attempt (the note the gate computed and never passed until now).
 * Executed: the real context handler, the real apply handler, the real gate with stubs.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const H = join(ROOT, 'orchestrations/scripts/lib/handlers');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PRD = {
  implementationOrder: { core: ['REGI-004a', 'REGI-004b', 'REGI-005a', 'REGI-005b'] },
  stories: [
    { id: 'REGI-004a', status: 'completed', technicalNotes: { files: ['regintel/classifier.py'] }, acceptanceCriteria: ['classifies'] },
    { id: 'REGI-004b', status: 'completed', technicalNotes: { files: ['tests/test_classifier.py'] }, dependencies: ['REGI-004a'], acceptanceCriteria: ['tested'],
      testCriteria: { sourceFiles: ['regintel/classifier.py'], facts: ['classify_event is an async function with signature classify_event(event: EventRecord, client: Any = None, sink: Any = None) -> ClassificationRecord', 'classify_event raises TypeError if event is not an EventRecord'] } },
    { id: 'REGI-005a', status: 'completed', technicalNotes: { files: ['regintel/escalation.py'] }, dependencies: ['REGI-004a'], acceptanceCriteria: ['escalates'],
      consumesInterfaces: [{ file: 'regintel/classifier.py', ownerStoryId: 'REGI-004a', symbol: 'classify_event', signature: 'async def classify_event(event, client=None, sink=None) -> ClassificationRecord' }] },
    { id: 'REGI-005b', status: 'pending', technicalNotes: { files: ['tests/test_escalation.py'] }, dependencies: ['REGI-005a', 'REGI-004a'], acceptanceCriteria: ['escalation tested'] },
  ],
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tc-agree-')); dirs.push(dir);
  writeFileSync(join(dir, 'prd.json'), JSON.stringify(PRD));
  return dir;
}

describe('(1) the brief: criteria other stories hold on this story\'s source files', () => {
  it('REGI-005b is told REGI-004b\'s facts on classifier.py, and the interface its impl sibling consumes', () => {
    const dir = fixture();
    const r = spawnSync('python3', [join(H, 'tc-story-context.py'), dir, join(dir, 'prd.json'), 'core', 'REGI-005b'], { encoding: 'utf8' });
    const ctx = JSON.parse(r.stdout || '[]');
    const s = ctx.find((x: any) => x.storyId === 'REGI-005b');
    expect(s, r.stderr).toBeTruthy();
    expect(s.implSourceFiles).toContain('regintel/classifier.py');
    const shared = s.existingCriteriaOnSharedFiles || [];
    expect(shared.some((e: any) => e.storyId === 'REGI-004b' && e.file === 'regintel/classifier.py' && e.facts.some((f: string) => /async function/.test(f))), JSON.stringify(s)).toBe(true);
    expect((s.consumesInterfaces || []).some((c: any) => c.symbol === 'classify_event' && c.ownerStoryId === 'REGI-004a')).toBe(true);
  });
  it('a story whose source files nobody else has criteria on gets an empty list, not a missing key', () => {
    const dir = fixture();
    const prd = JSON.parse(JSON.stringify(PRD));
    prd.stories[1].testCriteria = undefined; prd.stories[2].consumesInterfaces = undefined;
    writeFileSync(join(dir, 'prd.json'), JSON.stringify(prd));
    const r = spawnSync('python3', [join(H, 'tc-story-context.py'), dir, join(dir, 'prd.json'), 'core', 'REGI-005b'], { encoding: 'utf8' });
    const s = JSON.parse(r.stdout || '[]').find((x: any) => x.storyId === 'REGI-005b');
    expect(s.existingCriteriaOnSharedFiles).toEqual([]);
  });
});

describe('(2) the prompt: the contract in force, and how to report a needed change', () => {
  const tpl = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/tc-writer.json'), 'utf8'));
  it('tells the writer existing criteria on a shared file are the contract in force', () => {
    expect(tpl.body).toMatch(/existingCriteriaOnSharedFiles/);
    expect(tpl.body).toMatch(/conflictsWith/);
    expect(tpl.body).toMatch(/consumesInterfaces/);
  });
  it('carries the corrective note from the previous attempt', () => {
    expect(tpl.placeholders).toContain('__CORRECTIVE_NOTE__');
    expect(tpl.mayBeEmpty || []).toContain('__CORRECTIVE_NOTE__');
  });
  it('post-impl-tc-writer supplies the note from the gate', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/post-impl-tc-writer.sh'), 'utf8');
    expect(src).toMatch(/"__CORRECTIVE_NOTE__":\$corrective_note/);
    expect(src).toMatch(/TC_CORRECTIVE_NOTE/);
  });
});

describe('(2b) the apply handler keeps a reported conflict', () => {
  it('conflictsWith is persisted on the story\'s testCriteria', () => {
    const dir = fixture();
    const tc = { 'REGI-005b': { facts: ['escalation persists one record'], sourceFiles: ['regintel/classifier.py'], mockStrategy: 'fake client',
      conflictsWith: [{ storyId: 'REGI-004b', fact: 'classify_event is an async function with signature classify_event(event: EventRecord, client: Any = None, sink: Any = None) -> ClassificationRecord', reason: 'escalation requires a synchronous call taking the connection' }] } };
    writeFileSync(join(dir, 'tc.json'), JSON.stringify(tc));
    const r = spawnSync('python3', [join(H, 'tc-apply-to-prd.py'), join(dir, 'tc.json'), dir, join(dir, 'prd.json'), '0', 'core', 'REGI-005b'], { encoding: 'utf8' });
    const prd = JSON.parse(readFileSync(join(dir, 'prd.json'), 'utf8'));
    const s = prd.stories.find((x: any) => x.id === 'REGI-005b');
    expect(s.testCriteria.conflictsWith, r.stdout + r.stderr).toHaveLength(1);
    expect(s.testCriteria.conflictsWith[0].storyId).toBe('REGI-004b');
  });
});

describe('(3) the gate: a reported conflict goes to the reviewer; a rejection corrects the next attempt', () => {
  function runGate(opts: { verdicts: string[]; conflict: boolean }) {
    const dir = fixture();
    const logs = join(dir, 'logs'); mkdirSync(logs);
    const bins = join(dir, 'bins'); mkdirSync(bins);
    const record = join(dir, 'record.txt'); writeFileSync(record, '');
    // The writer stand-in: records the corrective note it was given, writes facts (+ a conflict
    // when asked) into the PRD the way the real apply handler does.
    writeFileSync(join(bins, 'post-impl-tc-writer.sh'), `#!/usr/bin/env bash
echo "WRITER corrective=<\${TC_CORRECTIVE_NOTE:-}>" >> ${JSON.stringify(record)}
python3 - "$@" <<'PY'
import json,sys,os
prd=json.load(open(${JSON.stringify(join(dir, 'prd.json'))}))
for s in prd['stories']:
    if s['id']=='REGI-005b':
        tc={'facts':['classify_event(conn, event_row) is synchronous'],'sourceFiles':['regintel/classifier.py']}
        if os.environ.get('WRITE_CONFLICT')=='1':
            tc['conflictsWith']=[{'storyId':'REGI-004b','fact':'classify_event is an async function','reason':'needs sync'}]
        s['testCriteria']=tc
json.dump(prd,open(${JSON.stringify(join(dir, 'prd.json'))},'w'))
PY
exit 0
`); chmodSync(join(bins, 'post-impl-tc-writer.sh'), 0o755);
    writeFileSync(join(bins, 'update-monitor.sh'), '#!/usr/bin/env bash\nexit 0\n'); chmodSync(join(bins, 'update-monitor.sh'), 0o755);
    writeFileSync(join(bins, 'agent-attempt-analyst.sh'), '#!/usr/bin/env bash\necho "analyst note"\n'); chmodSync(join(bins, 'agent-attempt-analyst.sh'), 0o755);
    const verdictsFile = join(dir, 'verdicts'); writeFileSync(verdictsFile, opts.verdicts.join('\n') + '\n');
    const script = join(dir, 'run.sh');
    writeFileSync(script, [
      `source ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/tc-writer-gate.sh'))}`,
      `SCRIPT_DIR=${JSON.stringify(bins)}`, `PRD_FILE=${JSON.stringify(join(dir, 'prd.json'))}`, `LOG_DIR=${JSON.stringify(logs)}`,
      `PROJECT_ROOT=${JSON.stringify(dir)}`, `OUTPUT_DIR=${JSON.stringify(dir)}`, `EPAM_MODEL=model-a`, `EPAM_MODEL_LADDER_MEDIUM="model-a=model-b|model-b=model-c"`,
      `export WRITE_CONFLICT=${opts.conflict ? 1 : 0}`,
      `log() { echo "LOG: $*"; }; warning() { echo "WARN: $*"; }; success() { echo "OK: $*"; }; error() { echo "ERR: $*"; }`,
      `_tc_story_needs_criteria() { return 0; }`, `_tc_writer_gate_maybe_split_test_story() { return 1; }`,
      `_tc_writer_gate_maybe_mark_very_high_complexity() { :; }`, `_tc_writer_gate_maybe_upgrade_model() { :; }`, `_tc_writer_gate_log_retry() { :; }`, `_ladder_skip_reason() { echo none; }`,
      // The reviewer stand-in: records what it was asked and answers the next scripted verdict.
      `run_prd_change_reviewer() { echo "REVIEW type=$2 story=$1 before=$3 after=$4" >> ${JSON.stringify(record)}; v=$(head -1 ${JSON.stringify(verdictsFile)}); sed -i 1d ${JSON.stringify(verdictsFile)}; [ "$v" = fail ] && echo "the shared contract is async; REGI-005b must consume it" >&2; echo "$v"; }`,
      `run_inline_tc_writer_gate REGI-005b core; echo "EXIT:$?"`,
    ].join('\n'));
    const r = spawnSync('bash', [script], { encoding: 'utf8' });
    const prd = JSON.parse(readFileSync(join(dir, 'prd.json'), 'utf8'));
    return { out: `${r.stdout}${r.stderr}`, record: readFileSync(record, 'utf8'), story: prd.stories.find((s: any) => s.id === 'REGI-005b') };
  }

  it('no conflict reported → no review, facts kept, one attempt', () => {
    const t = runGate({ verdicts: [], conflict: false });
    expect(t.record).not.toMatch(/REVIEW/);
    expect(t.record.match(/WRITER/g)).toHaveLength(1);
    expect(t.story.testCriteria.facts).toHaveLength(1);
    expect(t.out).toMatch(/EXIT:0/);
  });
  it('a conflict is sent to the reviewer as tc_conflict with the other story\'s fact as "before"', () => {
    const t = runGate({ verdicts: ['pass'], conflict: true });
    expect(t.record).toMatch(/REVIEW type=tc_conflict story=REGI-005b before=.*async function/);
  });
  it('a REJECTED conflict reverts the facts and the reviewer\'s reason is the next attempt\'s corrective note', () => {
    const t = runGate({ verdicts: ['fail', 'pass'], conflict: true });
    const writers = t.record.split('\n').filter((l) => l.startsWith('WRITER'));
    expect(writers.length, t.out).toBeGreaterThanOrEqual(2);
    expect(writers[0]).toMatch(/corrective=<>/);
    expect(writers[1]).toMatch(/corrective=<.*async.*>/);
  });
  it('an APPROVED conflict keeps the facts and marks the conflict approved', () => {
    const t = runGate({ verdicts: ['pass'], conflict: true });
    expect(t.story.testCriteria.facts).toHaveLength(1);
    expect(t.story.testCriteria.conflictsWith[0].approved).toBe(true);
    expect(t.out).toMatch(/EXIT:0/);
  });
});
