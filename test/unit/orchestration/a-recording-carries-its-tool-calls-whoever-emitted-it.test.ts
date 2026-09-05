/**
 * A RECORDING CARRIES THE CALLS THE MODEL MADE — WHICHEVER CALL SITE EMITTED IT.
 *
 * Measured 2026-09-05 by orchestrations/scripts/test/tool-call-recording-harness.js, which drives
 * all six links of this path against a real runner invocation. Five of the six hold: the runner
 * makes tool calls, writes them to its session transcript, the transcript is findable, the
 * ingestion body carries them, and Langfuse stores and returns them (proved live — 1 tool call
 * stored on the probe trace). The sixth is the one that has silently failed three times:
 *
 *     lib/ac-gate.js:77            startedAt=NO  endedAt=NO   → 0 calls
 *     lib/codeline-discovery.js:47 startedAt=NO  endedAt=NO   → 0 calls
 *     lib/cpa-inference.js:363     startedAt=NO  endedAt=NO   → 0 calls
 *     lib/handlers/emit-cost.js:28 startedAt=NO  endedAt=NO   → 0 calls
 *     spec-mode-runner.js:9334     startedAt=yes endedAt=NO   → 0 calls
 *
 * transcriptForCall does `Date.parse(endedAt || '')` and returns nothing unless BOTH ends are
 * finite. Not one call site supplies both, so the resolver returned [] on every call ever made,
 * regardless of what the model did. Three "fixes" all landed on the reachable links while this one
 * was never exercised with the arguments the call sites actually pass — each diagnosis was drawn
 * from a paid run, and a run only shows the last link.
 *
 * WHY THE FIX IS NOT "PASS THE TIMESTAMPS AT ALL FIVE SITES". That repairs today's five and leaves
 * the sixth site added next month silently recording nothing, in a feature whose entire failure
 * mode is silence. The window is also the weakest available key: it needs slack for flush timing,
 * and it goes ambiguous exactly when parallel lanes run, which is when a run is most interesting.
 *
 * THE RECORD ALREADY IDENTIFIES ITS OWN CALL, on both arms, and the emitter already reads it:
 *   - claude / codemie-claude: `session_id`, which IS the transcript's filename — an exact match,
 *     no window, no slack, no ambiguity (measured: session 521698d3… → 1 Bash call).
 *   - epam (openrouter/minimax): `timings[].toolCalls[]` inline — no transcript needed at all
 *     (measured: 16 calls in the 2026-08-17 estate-survey record).
 *
 * So the seam can answer from what it is already holding, and no call site can forget.
 *
 * BOTH ENDS ARE TESTED, and the second is the one that protects the replay corpus: a call whose
 * transcript genuinely cannot be identified must still yield NOTHING rather than a guess. A
 * mis-attributed transcript replays another agent's action undetectably, which is the exact
 * contamination class this repo has been bitten by twice.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const emitter = require(join(LIB, 'cost-emitter.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tx = require(join(LIB, 'transcript-tool-calls.js'));

/** A real-shaped runner transcript: one JSON object per line, tool_use blocks in message.content. */
function transcript(calls: string[]): string {
  return calls.map((name) => JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: `t-${name}`, name, input: { a: 1 } }] },
  })).join('\n') + '\n';
}

/**
 * A workspace shaped exactly like the runner's: a cwd, and ~/.claude/projects/<slug>/<session>.jsonl
 * beneath a HOME we control, so nothing reads or writes the real one.
 */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'toolcalls-'));
  const home = join(dir, 'home');
  const cwd = join(dir, 'codeline');
  mkdirSync(cwd, { recursive: true });
  const slugDir = join(home, '.claude', 'projects', tx.transcriptDirFor(cwd, home).split('/').pop()!);
  mkdirSync(slugDir, { recursive: true });
  return {
    dir, home, cwd, slugDir,
    write: (session: string, calls: string[]) =>
      writeFileSync(join(slugDir, `${session}.jsonl`), transcript(calls)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Drive the seam the way a call site does, with that site's HOME/cwd/PROJECT_ROOT in force. */
function resolve(w: ReturnType<typeof workspace>, record: object, opts: {
  startedAt?: string; endedAt?: string;
} = {}) {
  const envWas = { ...process.env };
  const cwdWas = process.cwd();
  try {
    process.env.HOME = w.home;
    process.env.PROJECT_ROOT = w.cwd;
    process.chdir(w.cwd);
    // The seam is handed the parsed record it already read, plus whatever window the site gave.
    return emitter.toolCallsForCall(record, opts.startedAt, opts.endedAt) as Array<{ name: string }>;
  } finally {
    process.chdir(cwdWas);
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, envWas);
  }
}

describe('the seam resolves a call\'s tool calls from what it already holds', () => {
  it('END ONE — session_id alone is enough: NO timestamps, and the calls are still found', () => {
    // This is the shape every failing call site produces: no window at all.
    const w = workspace();
    try {
      w.write('sess-abc', ['Bash', 'Write']);
      const got = resolve(w, { session_id: 'sess-abc', result: 'done' });
      expect(got.map((c) => c.name), [
        'a call site that supplies no window recorded nothing, which is what all five real call',
        'sites do today — so every trace in the corpus carries zero tool calls.',
      ].join('\n')).toEqual(['Bash', 'Write']);
    } finally { w.cleanup(); }
  });

  it('the epam arm answers from the record inline, needing no transcript at all', () => {
    const w = workspace();  // deliberately empty: no transcript exists anywhere
    try {
      const got = resolve(w, {
        result: 'done',
        timings: [
          { iteration: 1, toolCalls: [{ name: 'codegraph_query' }, { name: 'codegraph_query' }] },
          { iteration: 2, toolCalls: [{ name: 'Read' }] },
          { iteration: 3, toolCalls: [] },
        ],
      });
      expect(got.map((c) => c.name),
        'the epam arm carries its calls in the record the emitter already reads, and they were '
        + 'ignored in favour of a transcript that arm never writes')
        .toEqual(['codegraph_query', 'codegraph_query', 'Read']);
    } finally { w.cleanup(); }
  });

  it('END TWO — an UNIDENTIFIABLE call yields nothing, never a guess', () => {
    // Two transcripts, no session_id, a window spanning both. Attributing either would put another
    // agent's actions into this recording and replay the wrong thing, undetectably.
    const w = workspace();
    try {
      w.write('one', ['Bash']);
      w.write('two', ['Write']);
      const got = resolve(w, { result: 'done' },
        { startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date().toISOString() });
      expect(got, [
        'an ambiguous window was resolved to one of the candidates. A missing recording costs a',
        'stand-in; a wrong one poisons the replay.',
      ].join('\n')).toEqual([]);
    } finally { w.cleanup(); }
  });

  it('END TWO (b) — the SAME session id in two searched directories yields nothing', () => {
    /**
     * Caught by mutation, not by design: replacing `named.length === 1` with `named.length` left
     * all seven other tests green, because every one of them put the transcript in exactly one
     * place. The window path had an ambiguity test and the session-id path did not.
     *
     * It is reachable. transcriptDirsToSearch searches PROJECT_ROOT *and each of its immediate
     * children*, so a codeline root holding 41 repositories contributes 42 directories, and a
     * runner session id that appears under two of them is genuinely ambiguous. Taking the first
     * would put another repository's actions into this recording.
     */
    const w = workspace();
    try {
      const rootA = join(w.cwd, 'repo-a');
      const rootB = join(w.cwd, 'repo-b');
      mkdirSync(rootA, { recursive: true });
      mkdirSync(rootB, { recursive: true });
      for (const [r, calls] of [[rootA, ['Bash']], [rootB, ['Write']]] as const) {
        const d = tx.transcriptDirFor(r, w.home);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'collide.jsonl'), transcript([...calls]));
      }
      expect(resolve(w, { session_id: 'collide' }), [
        'the same session id existed under two searched directories and one of them was chosen.',
        'A missing recording costs a stand-in; a wrong one replays another agent\'s action',
        'undetectably — the contamination class this repo has been bitten by twice.',
      ].join('\n')).toEqual([]);
    } finally { w.cleanup(); }
  });

  it('a session_id naming a transcript that does not exist yields nothing', () => {
    const w = workspace();
    try {
      w.write('real', ['Bash']);
      expect(resolve(w, { session_id: 'not-written' }),
        'a missing transcript was substituted with whatever else was lying in the directory')
        .toEqual([]);
    } finally { w.cleanup(); }
  });

  it('never throws — observability must not fail the call it observes', () => {
    const w = workspace();
    try {
      for (const bad of [null, undefined, 'a string', 42, { session_id: 42 }, { timings: 'no' }]) {
        expect(() => resolve(w, bad as object)).not.toThrow();
      }
    } finally { w.cleanup(); }
  });

  it('does not read the real HOME when the runner ran somewhere else', () => {
    // Guards the harness itself: if this ever reads ~/.claude/projects it would pass vacuously off
    // the developer's own transcripts, which is how a green test can prove nothing.
    const w = workspace();
    try {
      expect(w.home.startsWith(homedir()) && w.home !== homedir()).toBe(false);
      expect(resolve(w, { session_id: 'absent' })).toEqual([]);
    } finally { w.cleanup(); }
  });
});

describe('no call site can silently opt out', () => {
  it('every emitCostSnapshot call site is served without supplying a window', () => {
    // The requirement, stated structurally: the seam must answer from the record. If this ever
    // needs a window again, the five sites are back to recording nothing and nobody will notice.
    const w = workspace();
    try {
      w.write('s1', ['Bash']);
      expect(resolve(w, { session_id: 's1' }).length,
        'the seam still depends on the caller passing timestamps').toBe(1);
    } finally { w.cleanup(); }
  });
});
