/**
 * THE ANALYST SEES WHAT THIS ATTEMPT DID — NOT WHAT THE STORY HAS DONE SO FAR.
 *
 * regintel 20260919T224649Z resume 7 (2026-09-20 07:32): the scoped fix in REGI-005a made 18
 * read_file calls, 4 bash calls and ZERO writes, ended its turn with "Now I'll write both files",
 * and was recorded as a "quality failure (agent ran, result produced)". _attempt_change_summary
 * diffed against the STORY's baseline — which carried 005a's earlier, completed work — so the
 * analyst was told the attempt changed files it never touched, and diagnosed code instead of the
 * absence of an attempt. Same shape on brownfield: a retry after a first attempt that wrote sees
 * the first attempt's diff as its own.
 *
 * The evidence is (1) the tree as it stood when THIS attempt started, snapshotted before the
 * agent runs, and (2) the attempt's own tool record — counts per tool, from whichever runner's
 * raw output exists. Both are machine facts; the analyst judges them. Executed with real git.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
// engineSource reassembles the split monolith from the functions the split map records; helpers
// added to a lib since the split are read from the lib itself.
const src = engineSource(join(ROOT, 'orchestrations/scripts/claude.sh')) + '\n' + readFileSync(join(ROOT, 'orchestrations/scripts/lib/failure-healing.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fn(name: string): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${name}() {`);
  if (start === -1) throw new Error(`no ${name}`);
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) { body.push(lines[i]); if (lines[i] === '}') return body.join('\n'); }
  throw new Error(`unterminated ${name}`);
}
const git = (dir: string, ...a: string[]) => spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).stdout.trim();

/** A codeline where the story's earlier attempt already changed classifier.py and committed. */
function codeline() {
  const dir = mkdtempSync(join(tmpdir(), 'attempt-evidence-')); dirs.push(dir);
  git(dir, 'init', '-q'); mkdirSync(join(dir, 'regintel'));
  writeFileSync(join(dir, 'regintel/classifier.py'), 'async def classify_event(event, client=None): ...\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'baseline');
  const baseline = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'regintel/classifier.py'), 'async def classify_event(event, client=None, sink=None): ...\n# earlier attempt of this story\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'REGI-005a: story complete');
  return { dir, baseline };
}

function summarise(dir: string, baseline: string, script: string) {
  const r = spawnSync('bash', ['-c', [
    `PROJECT_ROOT=${JSON.stringify(dir)}`, `_resolved_baseline_ref() { echo ${baseline}; }`, `evidence_window() { echo 200; }`,
    fn('_attempt_start_snapshot'), fn('_attempt_tool_record'), fn('_attempt_change_summary'),
    script,
  ].join('\n')], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

describe('the change summary is scoped to THIS attempt', () => {
  it('an attempt that wrote nothing is reported as writing nothing, even though the story changed files earlier', () => {
    const { dir, baseline } = codeline();
    const out = summarise(dir, baseline, 'ATTEMPT_START_REF=$(_attempt_start_snapshot); _attempt_change_summary REGI-005a');
    expect(out, out).toMatch(/changed NO files/);
    expect(out).not.toMatch(/classifier\.py/);
  });

  it('an attempt that wrote a file reports that file, and only that', () => {
    const { dir, baseline } = codeline();
    const out = summarise(dir, baseline, [
      'ATTEMPT_START_REF=$(_attempt_start_snapshot)',
      `printf 'def classify_event(conn, event_row): ...\\n' > "$PROJECT_ROOT/regintel/classifier.py"`,
      `printf 'x' > "$PROJECT_ROOT/regintel/new_module.py"`,
      '_attempt_change_summary REGI-005a',
    ].join('\n'));
    expect(out).toMatch(/classifier\.py/);
    expect(out).toMatch(/new_module\.py/);
    expect(out).not.toMatch(/changed NO files/);
  });

  it('an untracked file that ALREADY existed when the attempt started is not credited to the attempt', () => {
    const { dir, baseline } = codeline();
    writeFileSync(join(dir, 'leftover.txt'), 'from the previous attempt');
    const out = summarise(dir, baseline, 'ATTEMPT_START_REF=$(_attempt_start_snapshot); _attempt_change_summary REGI-005a');
    expect(out).toMatch(/changed NO files/);
    expect(out).not.toMatch(/leftover/);
  });

  it('with no snapshot (a caller that never took one) it still diffs against the story baseline, as before', () => {
    const { dir, baseline } = codeline();
    const out = summarise(dir, baseline, 'unset ATTEMPT_START_REF; _attempt_change_summary REGI-005a');
    expect(out).toMatch(/classifier\.py/);
  });
});

describe('the tool record — counts per tool from whichever runner produced the raw output', () => {
  function record(name: string, content: string) {
    const dir = mkdtempSync(join(tmpdir(), 'tool-record-')); dirs.push(dir);
    const f = join(dir, name); writeFileSync(f, content);
    const r = spawnSync('bash', ['-c', `${fn('_attempt_tool_record')}\n_attempt_tool_record ${JSON.stringify(f)}`], { encoding: 'utf8' });
    return `${r.stdout}${r.stderr}`;
  }
  it('the epam runner\'s iteration record (the live REGI-005a attempt: 18 reads, 4 bash, 0 writes)', () => {
    const iters = [...Array(18).fill({ toolCalls: [{ name: 'read_file' }] }), ...Array(4).fill({ toolCalls: [{ name: 'bash' }] }), { toolCalls: [] }];
    const out = record('r_raw.json', JSON.stringify({ result: 'Now I will write both files.', iterations: iters }));
    expect(out).toMatch(/read_file[^\n]*18/);
    expect(out).toMatch(/bash[^\n]*4/);
    expect(out).toMatch(/write_file[^\n]*\b0\b|no write/i);
  });
  it('a claude stream-json record (tool_use blocks)', () => {
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Edit' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
      { type: 'result', result: 'done' },
    ].map((l) => JSON.stringify(l)).join('\n');
    const out = record('r_raw.jsonl', lines);
    expect(out).toMatch(/Read[^\n]*2/);
    expect(out).toMatch(/Edit[^\n]*1/);
  });
  it('a codex item record (item.completed with item.type)', () => {
    const lines = [
      { type: 'item.completed', item: { type: 'command_execution' } },
      { type: 'item.completed', item: { type: 'file_change' } },
      { type: 'item.completed', item: { type: 'command_execution' } },
    ].map((l) => JSON.stringify(l)).join('\n');
    const out = record('r_raw.jsonl', lines);
    expect(out).toMatch(/command_execution[^\n]*2/);
    expect(out).toMatch(/file_change[^\n]*1/);
  });
  it('says when there is no record rather than pretending', () => {
    expect(record('r_raw.json', 'not json')).toMatch(/no tool record/i);
  });
});

describe('the summary the analyst receives carries the tool record', () => {
  it('the tool record is appended to the change summary when the attempt\'s raw file is known', () => {
    const { dir, baseline } = codeline();
    const raw = join(dir, 'S_result_raw.json');
    writeFileSync(raw, JSON.stringify({ iterations: [{ toolCalls: [{ name: 'read_file' }] }, { toolCalls: [{ name: 'read_file' }] }] }));
    const out = summarise(dir, baseline, `ATTEMPT_START_REF=$(_attempt_start_snapshot); ATTEMPT_RAW_FILE=${JSON.stringify(raw)}; _attempt_change_summary REGI-005a`);
    expect(out).toMatch(/changed NO files/);
    expect(out).toMatch(/read_file[^\n]*2/);
  });
});

describe('wiring: the snapshot is taken before every invocation and the raw file is named for the summary', () => {
  it('implement_story snapshots the tree right before invoking the writer', () => {
    const body = fn('implement_story');
    const iSnap = body.indexOf('ATTEMPT_START_REF=$(_attempt_start_snapshot)');
    const iInvoke = body.indexOf('log "Invoking $story_cli (attempt');
    expect(iSnap, 'no snapshot taken').toBeGreaterThan(0);
    expect(iSnap, 'the snapshot must precede the invocation').toBeLessThan(iInvoke);
  });
  it('the raw attempt file is exported for the summary', () => {
    // Named from the same resolution the coordinator already uses (_raw.json or _raw.jsonl).
    expect(fn('implement_story')).toMatch(/ATTEMPT_RAW_FILE="\$_raw_for_coord"/);
  });
});
