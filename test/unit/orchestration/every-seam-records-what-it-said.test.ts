/**
 * EVERY SEAM RECORDS WHAT IT ACTUALLY SAID — one funnel, no seam exempt.
 *
 * Measured on the Successful-Run-Sept-05-1 cassettes, and again on 2026-09-07:
 *
 *     RICH   17 seams   real text and tool calls
 *     EMPTY  14 seams   every turn {"text": "", "toolCalls": []}
 *
 * The empty fourteen include the WRITER (claude), the failure analyst,
 * repro-test-writer, team-lead-review and all seven qa-gate sentinels. Their cassettes are
 * structurally valid and completely unreplayable, so a replay stops at the seam that writes the
 * code. It also explains "Coordinator[L1]: no raw output file to read" — the analyst is blind for
 * the same reason its cassette is blank.
 *
 * NOT FOURTEEN BUGS — ONE FUNNEL THAT DROPS THE PAYLOAD. Both paths already end at
 * emitGeneration:
 *   - lib/cost-emitter.js (JS) passes input, output and toolCalls; those seams record richly
 *   - lib/cost-record.sh (shell) builds its payload with jq and passes agent, model, tokens and
 *     cost — and no content at all
 * The shell caller HAS both: record_call_cost receives $ORCH_JSON_RESULT, and llm-handler.sh
 * holds $PROMPT_FILE. It simply never sent them.
 *
 * So emitGeneration fills input/output/toolCalls from the files when a caller supplies files
 * instead of strings, using the SAME extractors the JS path uses — one implementation, so the two
 * can never drift into recording different things.
 *
 * THE PIPELINE MUST NOT REGRESS: an explicit value always wins, so the seventeen rich seams record
 * byte-identically; and recording stays fire-and-forget — a missing or malformed file records less,
 * never throws, and never fails a call.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/langfuse-emit.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const emit = require(LIB);
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A result file in the shape the runner writes, with a reply and a tool call. */
function resultFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'emit-'));
  dirs.push(dir);
  const f = join(dir, 'result.json');
  writeFileSync(f, JSON.stringify({
    type: 'result',
    result: 'I changed CheckoutForm.tsx to compare emails case-insensitively.',
    session_id: 'sess-1',
    usage: { input_tokens: 100, output_tokens: 20 },
  }));
  return f;
}

function promptFile(text = 'Fix the case-sensitive email comparison.'): string {
  const dir = mkdtempSync(join(tmpdir(), 'emitp-'));
  dirs.push(dir);
  const f = join(dir, 'prompt.txt');
  writeFileSync(f, text);
  return f;
}

const body = (f: Record<string, unknown>) =>
  emit.buildIngestionBody(f, { traceId: 't', obsId: 'o', sessionId: 's' });

/** The generation event's input/output, however the body nests them. */
function io(b: unknown): { input: string; output: string } {
  const s = JSON.stringify(b);
  const gen = (b as any[]).find?.((e) => JSON.stringify(e).includes('generation'))
    ?? (b as any);
  const j = JSON.stringify(gen.body ?? gen ?? {});
  return { input: j, output: s };
}

describe('the recording funnel', () => {
  it('GUARD: an explicit input/output is recorded — the harness can see content at all', () => {
    const b = body({ agent: 'prompt-review', model: 'm', input: 'THE PROMPT', output: 'THE REPLY' });
    const s = JSON.stringify(b);
    expect(s, 'explicit content is not reaching the payload').toContain('THE PROMPT');
    expect(s).toContain('THE REPLY');
  });

  it('fills the OUTPUT from a result file when the caller has no string', () => {
    const b = body({ agent: 'claude', model: 'm', resultFile: resultFile() });
    expect(JSON.stringify(b),
      'a shell-invoked seam recorded no output — its cassette is {"text": "", "toolCalls": []} '
      + 'and a replay cannot exercise it')
      .toContain('case-insensitively');
  });

  it('fills the INPUT from a prompt file when the caller has no string', () => {
    const b = body({ agent: 'claude', model: 'm', promptFile: promptFile() });
    expect(JSON.stringify(b), 'the prompt was not recorded, so the turn cannot be replayed')
      .toContain('case-sensitive email comparison');
  });

  it('AN EXPLICIT VALUE STILL WINS — the seventeen rich seams do not change', () => {
    // The JS path passes strings today. If a file could override them, every currently-correct
    // recording would change, which is the regression this whole change must not cause.
    const b = body({
      agent: 'prompt-review', model: 'm',
      input: 'EXPLICIT IN', output: 'EXPLICIT OUT',
      promptFile: promptFile('FILE IN'), resultFile: resultFile(),
    });
    const s = JSON.stringify(b);
    expect(s).toContain('EXPLICIT IN');
    expect(s).toContain('EXPLICIT OUT');
    expect(s, 'a file overrode an explicit value').not.toContain('FILE IN');
    expect(s, 'a file overrode an explicit value').not.toContain('case-insensitively');
  });

  it('records the TOOL CALLS from the result, not just the text', () => {
    // A cassette without tool calls replays a model that never touched the repo.
    const dir = mkdtempSync(join(tmpdir(), 'emit-tc-'));
    dirs.push(dir);
    const f = join(dir, 'r.json');
    writeFileSync(f, JSON.stringify({
      type: 'result', result: 'done', session_id: 'sess-2',
      timings: [{ toolCalls: [{ name: 'read_file', input: { path: 'CheckoutForm.tsx' } }] }],
    }));
    const b = body({ agent: 'claude', model: 'm', resultFile: f });
    expect(JSON.stringify(b), 'tool calls were not recorded').toContain('read_file');
  });

  it('FIRE AND FORGET — missing, empty and malformed files never throw', () => {
    /**
     * cost-record.sh runs this in the background with output discarded and `|| true`; the emitter
     * is documented as never failing a call. Recording less is always better than failing a run.
     */
    const dir = mkdtempSync(join(tmpdir(), 'emit-bad-'));
    dirs.push(dir);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, '');
    for (const f of [
      { agent: 'a', model: 'm', resultFile: '/nonexistent/r.json' },
      { agent: 'a', model: 'm', promptFile: '/nonexistent/p.txt' },
      { agent: 'a', model: 'm', resultFile: bad },
      { agent: 'a', model: 'm', resultFile: empty },
    ]) {
      expect(() => body(f), `threw on ${JSON.stringify(f)}`).not.toThrow();
    }
  });

  it('a seam with no content at all still records its cost — nothing is lost', () => {
    // The cost ledger is what the operator reads; it must survive a contentless call.
    const b = body({ agent: 'a', model: 'm', costUsd: 0.42, tokensIn: 10, tokensOut: 2 });
    expect(JSON.stringify(b)).toContain('0.42');
  });
});

describe('the shell path sends what it has', () => {
  /**
   * WIRING, EXECUTED. The funnel filling content from files is worth nothing if the shell caller
   * never sends the paths — which is precisely the state that produced fourteen blank cassettes
   * while the code that could have filled them already existed on the other path.
   *
   * The real record_call_cost is lifted and driven with a stub `node` that captures the JSON it
   * would have piped to langfuse-emit.js.
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { execFileSync } = require('node:child_process');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync, mkdirSync, chmodSync, existsSync } = require('node:fs');

  function emitted(opts: { withPrompt: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), 'crec-'));
    dirs.push(dir);
    const lib = join(__dirname, '../../../orchestrations/scripts/lib');
    const reply = join(dir, 'result.json');
    // total_cost_usd is what record_call_cost keys on — without it the recorder returns early,
    // exactly as it does for a call that never reached a model. A fixture missing it would test
    // the early return rather than the recording.
    writeFileSync(reply, JSON.stringify({
      type: 'result', result: 'the reply text', session_id: 's',
      total_cost_usd: 0.0123,
      usage: { input_tokens: 5, output_tokens: 2 },
    }));
    const prompt = join(dir, 'prompt.txt');
    writeFileSync(prompt, 'the prompt text');

    // A stub node that records the payload instead of emitting it, and a stub emitter file so the
    // guard `[ -f .../langfuse-emit.js ]` passes without touching the real one.
    const fake = join(dir, 'bin'); mkdirSync(fake);
    const captured = join(dir, 'captured.json');
    writeFileSync(join(fake, 'node'), `#!/usr/bin/env bash\ncat > ${JSON.stringify(captured)}\nexit 0\n`);
    chmodSync(join(fake, 'node'), 0o755);
    // cost-record.sh derives _COST_RECORD_DIR from BASH_SOURCE, so the stub emitter must sit
    // beside the driver — setting the variable beforehand is overwritten by the file itself.
    writeFileSync(join(dir, 'langfuse-emit.js'), '// stub\n');

    const src = readFileSync(join(lib, 'cost-record.sh'), 'utf8');
    const drive = join(dir, 'drive.sh');
    writeFileSync(drive, ['#!/usr/bin/env bash', 'set -uo pipefail',
      `PHASE_COST_FILE=${JSON.stringify(join(dir, 'cost.jsonl'))}`,
      src,
      `record_call_cost ${JSON.stringify(reply)} claude AMSD-1919 claude-sonnet-5 2026-09-07T00:00:00Z`,
      'wait',
    ].join('\n'));

    try {
      execFileSync('bash', [drive], {
        encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, NODE_BIN: join(fake, 'node'),
               ...(opts.withPrompt ? { EPAM_TRACE_PROMPT_FILE: prompt } : {}) },
      });
    } catch { /* the recorder is fire-and-forget */ }
    return existsSync(captured) ? JSON.parse(readFileSync(captured, 'utf8') || '{}') : null;
  }

  it('sends the RESULT FILE, so the writer stops recording an empty turn', () => {
    const p = emitted({ withPrompt: false });
    expect(p, 'nothing was emitted at all').toBeTruthy();
    expect(p.resultFile, 'the shell path still sends no result — the cassette stays blank')
      .toBeTruthy();
    expect(readFileSync(p.resultFile, 'utf8')).toContain('the reply text');
  });

  it('sends the PROMPT FILE when the caller exports one', () => {
    const p = emitted({ withPrompt: true });
    expect(p.promptFile, 'the prompt was not sent, so only half the turn is recorded').toBeTruthy();
    expect(readFileSync(p.promptFile, 'utf8')).toContain('the prompt text');
  });

  it('still sends cost and tokens — the ledger is unchanged', () => {
    // The whole point of this payload before today. It must survive the addition.
    const p = emitted({ withPrompt: true });
    expect(p.agent).toBe('claude');
    expect(p.storyId).toBe('AMSD-1919');
    expect(p.model).toBe('claude-sonnet-5');
    expect(typeof p.costUsd).toBe('number');
    expect(typeof p.tokensIn).toBe('number');
  });

  it('with NO prompt exported it still records — promptFile is empty, never an error', () => {
    const p = emitted({ withPrompt: false });
    expect(p).toBeTruthy();
    expect(p.promptFile).toBe('');
  });
});

describe('llm-handler hands the prompt to the recorder', () => {
  /**
   * THE CALL SITE, EXECUTED. A mutation that blanked EPAM_TRACE_PROMPT_FILE in llm-handler.sh
   * survived every test above, because they drive record_call_cost directly with the variable
   * already set. That is the same shape as the defect being fixed: the funnel could fill content
   * it was never handed, and nothing asserted that the caller handed it over.
   *
   * The real invocation block is lifted and driven with a stub record_call_cost that captures the
   * environment it was called in.
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { execFileSync } = require('node:child_process');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync, existsSync } = require('node:fs');

  it('exports EPAM_TRACE_PROMPT_FILE pointing at the prompt it just sent', () => {
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/llm-handler.sh'), 'utf8');
    const at = src.indexOf('record_call_cost "${ORCH_JSON_RESULT:-}"');
    expect(at, 'the record_call_cost call site was not found in llm-handler.sh').toBeGreaterThan(0);
    // Lift the whole `if declare -f record_call_cost ... fi` block that contains the call.
    const start = src.lastIndexOf('if declare -f record_call_cost', at);
    const end = src.indexOf('\n    fi\n', at) + '\n    fi\n'.length;
    expect(start, 'the guarding block was not found').toBeGreaterThan(0);

    const dir = mkdtempSync(join(tmpdir(), 'llmh-'));
    dirs.push(dir);
    const captured = join(dir, 'captured.txt');
    const drive = join(dir, 'drive.sh');
    writeFileSync(drive, ['#!/usr/bin/env bash', 'set -uo pipefail',
      // A stub with the same NAME the real guard tests for, recording what it was handed.
      `record_call_cost() { printf '%s\\n' "\${EPAM_TRACE_PROMPT_FILE:-<unset>}" > ${JSON.stringify(captured)}; }`,
      'PROMPT_FILE=/tmp/the-prompt-this-call-sent.txt',
      'ORCH_JSON_RESULT=/tmp/the-result.json',
      'EPAM_AGENT_NAME=claude', 'EPAM_STORY_ID=AMSD-1919', 'AI_MODEL=claude-sonnet-5',
      '_call_started_at=2026-09-07T00:00:00Z',
      src.slice(start, end),
    ].join('\n'));

    try { execFileSync('bash', [drive], { encoding: 'utf8', timeout: 60_000 }); }
    catch { /* the block is guarded and non-fatal by design */ }

    expect(existsSync(captured), 'record_call_cost was never called at all').toBe(true);
    expect(readFileSync(captured, 'utf8').trim(),
      'llm-handler did not hand the prompt file to the recorder, so only half of every '
      + 'shell-invoked turn can ever be recorded')
      .toBe('/tmp/the-prompt-this-call-sent.txt');
  });
});
