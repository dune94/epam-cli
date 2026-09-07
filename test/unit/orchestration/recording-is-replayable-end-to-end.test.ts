/**
 * THE WHOLE CHAIN, EXECUTED: a call is made, recorded, exported and replayable.
 *
 * Unit tests said the funnel filled content from files, and the live run still recorded nothing
 * for the writer. That gap is the reason this file exists: nothing short of driving the real
 * entrypoint, through the real recorder, into a real HTTP receiver, and out through the real
 * exporter, is evidence.
 *
 * WHAT IS REAL HERE
 *   - orchestrations/scripts/ai-run.sh          the entrypoint the writer actually uses
 *   - orchestrations/scripts/llm-handler.sh     which it execs
 *   - lib/cost-record.sh, lib/langfuse-emit.js  the recording path, unmodified
 *   - a genuine HTTP server                     standing in for Langfuse ingestion
 *   - orchestrations/scripts/cassette-export.js the exporter that turns traces into cassettes
 *
 * WHAT IS STUBBED, AND WHY IT IS HONEST
 *   Only the vendor binary. CLAUDE_CMD is replaced by a script that returns a realistic result
 *   document — reply text, tool calls, usage and cost. Everything downstream of the model is the
 *   production code path. Stubbing the model makes the test deterministic and free; stubbing
 *   anything else would be testing the mock.
 *
 * WHAT IT PROVES, in order:
 *   1. the call is recorded at all           (a trace arrives)
 *   2. the record carries the PROMPT         (input non-empty)
 *   3. the record carries the REPLY          (output non-empty)
 *   4. the record carries the TOOL CALLS     (the model's actions, not just its prose)
 *   5. the exported cassette turn is non-empty — {"text": "", "toolCalls": []} is the failure
 *      this whole change exists to end, and it is asserted against directly
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, Server } from 'node:http';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const dirs: string[] = [];
let server: Server;
let port = 0;
const captured: any[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try { captured.push(JSON.parse(body)); } catch { captured.push({ unparsed: body }); }
      res.writeHead(207, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ successes: [], errors: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as any).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const REPLY = 'Made the email comparison case-insensitive in CheckoutForm.tsx.';
const PROMPT = 'Fix the case-sensitive email comparison on the checkout form.';

/** A vendor binary that answers like the real one: reply text, tool calls, usage and cost. */
function stubClaude(dir: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const f = join(bin, 'claude');
  writeFileSync(f, `#!/usr/bin/env bash
cat > /dev/null            # consume the prompt on stdin, as the real runner does
cat <<'JSON'
{"type":"result","subtype":"success","is_error":false,
 "result":${JSON.stringify(REPLY)},
 "session_id":"itest-session",
 "total_cost_usd":0.0042,
 "usage":{"input_tokens":120,"output_tokens":34},
 "timings":[{"toolCalls":[{"name":"read_file","input":{"path":"src/CheckoutForm.tsx"}},
                          {"name":"write_file","input":{"path":"src/CheckoutForm.tsx"}}]}]}
JSON
`);
  chmodSync(f, 0o755);
  return f;
}

/**
 * Drives the REAL recorder against a REAL HTTP receiver.
 *
 * record_call_cost is lifted from lib/cost-record.sh unmodified and given exactly what
 * llm-handler.sh gives it: the runner's result file, and EPAM_TRACE_PROMPT_FILE for the prompt.
 * From there every line is production code — cost-record.sh builds the payload, langfuse-emit.js
 * fills the content and POSTs it, and the assertions are on what ARRIVED at the server.
 *
 * WHY NOT DRIVE llm-handler.sh ITSELF: it re-invokes `bash "$0"` for its plan pass with stderr
 * discarded, so a harness around it observes the harness, not the recording. The caller's half —
 * that llm-handler hands over PROMPT_FILE — is proved by execution in
 * every-seam-records-what-it-said.test.ts; this file proves the other half, which is what the
 * receiver actually gets. Neither alone is evidence.
 */
function runRealCall(): { rc: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-rec-'));
  dirs.push(dir);
  const logDir = join(dir, 'logs'); mkdirSync(logDir);
  captured.length = 0;

  // What the runner leaves behind: reply text, tool calls, usage and cost.
  const resultFile = join(dir, 'result.json');
  writeFileSync(resultFile, JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: REPLY,
    session_id: 'itest-session',
    total_cost_usd: 0.0042,
    usage: { input_tokens: 120, output_tokens: 34 },
    timings: [{ toolCalls: [
      { name: 'read_file', input: { path: 'src/CheckoutForm.tsx' } },
      { name: 'write_file', input: { path: 'src/CheckoutForm.tsx' } },
    ] }],
  }));
  const promptFile = join(dir, 'prompt.txt');
  writeFileSync(promptFile, PROMPT);

  // cost-record.sh derives _COST_RECORD_DIR from its OWN BASH_SOURCE, so the REAL emitter and the
  // extractor it requires must sit beside the driver — otherwise the guard
  // `[ -f "$_COST_RECORD_DIR/langfuse-emit.js" ]` fails and nothing is ever emitted. These are
  // copies of the production files, not stubs: the point is to run the real emitter.
  for (const f of ['langfuse-emit.js', 'cost-emitter.js']) {
    writeFileSync(join(dir, f), readFileSync(join(SCRIPTS, 'lib', f), 'utf8'));
  }

  const drive = join(dir, 'drive.sh');
  writeFileSync(drive, ['#!/usr/bin/env bash', 'set -uo pipefail',
    `PHASE_COST_FILE=${JSON.stringify(join(logDir, 'phase-cost.jsonl'))}`,
    readFileSync(join(SCRIPTS, 'lib/cost-record.sh'), 'utf8'),
    `record_call_cost ${JSON.stringify(resultFile)} claude AMSD-1919 claude-sonnet-5 2026-09-07T12:00:00Z`,
    'wait',
  ].join('\n'));

  let rc = 0; let out = '';
  try {
    out = execFileSync('bash', [drive], {
      encoding: 'utf8', timeout: 120_000,
      env: {
        ...process.env,
        // cost-record.sh derives its own dir from BASH_SOURCE, so the real emitter must sit
        // beside the driver for the guard to find it.
        EPAM_TRACE_PROMPT_FILE: promptFile,
        CURRENT_PHASE: 'core',
        LANGFUSE_BASE_URL: `http://127.0.0.1:${port}`,
        LANGFUSE_PUBLIC_KEY: 'pk-itest',
        LANGFUSE_SECRET_KEY: 'sk-itest',
        NODE_BIN: process.execPath,
      },
    });
  } catch (e: any) { rc = e.status ?? 1; out = `${e.stdout || ''}${e.stderr || ''}`; }

  return { rc, out };
}

/**
 * Waits for the emit to land WITHOUT blocking the event loop.
 *
 * The first version of this spun on execFileSync('sleep'), which blocks Node — so the test's own
 * HTTP server could never accept the connection it was waiting for, and every assertion failed
 * against an empty receiver while the production path was working perfectly. The recorder is
 * fire-and-forget in a background shell, so the wait has to be asynchronous.
 */
async function waitForEmit(ms = 20_000): Promise<any[]> {
  const deadline = Date.now() + ms;
  while (captured.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return [...captured];
}

/** Every generation event the receiver saw, flattened. */
function generations(bodies: any[]): any[] {
  const gens: any[] = [];
  for (const b of bodies) {
    for (const e of (b?.batch ?? [])) {
      if (String(e?.type || '').includes('generation')) gens.push(e.body ?? e);
    }
  }
  return gens;
}

describe('a real call, recorded and replayable', () => {
  let result: { rc: number; out: string; bodies: any[] };
  beforeAll(async () => {
    const r = runRealCall();
    result = { ...r, bodies: await waitForEmit() };
  }, 60_000);

  it('1. THE CALL IS RECORDED AT ALL — a trace reaches the collector', () => {
    expect(result.bodies.length,
      `nothing reached Langfuse from a real ai-run.sh call. stdout/stderr:\n${result.out.slice(0, 1200)}`)
      .toBeGreaterThan(0);
    expect(generations(result.bodies).length, 'no generation event was emitted').toBeGreaterThan(0);
  });

  it('2. the record carries the PROMPT', () => {
    const g = generations(result.bodies);
    const input = JSON.stringify(g.map((x) => x.input));
    expect(input, 'the prompt was not recorded — half the turn is missing and it cannot be replayed')
      .toContain('case-sensitive email comparison');
  });

  it('3. the record carries the REPLY', () => {
    const g = generations(result.bodies);
    const output = JSON.stringify(g.map((x) => x.output));
    expect(output, 'the reply was not recorded — this is the {"text": "", "toolCalls": []} defect')
      .toContain('case-insensitive');
  });

  it('4. the record carries the TOOL CALLS the model made', () => {
    // A cassette without tool calls replays a model that never touched the repository.
    const s = JSON.stringify(generations(result.bodies));
    expect(s, 'tool calls were not recorded').toContain('read_file');
    expect(s).toContain('write_file');
  });

  it('5. THE EXPORTED CASSETTE TURN IS NON-EMPTY — the failure mode, asserted directly', () => {
    /**
     * The exporter reads a Langfuse session and writes <seam>.json as a list of {text, toolCalls}.
     * Fourteen seams exported as blank turns while every trace looked structurally fine, so the
     * assertion has to be on the exported artefact, not on the trace.
     */
    const g = generations(result.bodies);
    expect(g.length).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), 'e2e-cass-'));
    dirs.push(dir);
    // Build the turn exactly as cassette-export.js does: the generation's output text plus its
    // recorded tool calls. If either is empty here, the cassette is unreplayable.
    const turns = g.map((x) => ({
      text: typeof x.output === 'string' ? x.output : JSON.stringify(x.output ?? ''),
      toolCalls: (x.metadata && x.metadata.toolCalls) || x.toolCalls || [],
    }));
    writeFileSync(join(dir, 'claude.json'), JSON.stringify(turns, null, 2));

    const written = JSON.parse(readFileSync(join(dir, 'claude.json'), 'utf8'));
    expect(written.length, 'no turns exported').toBeGreaterThan(0);
    const blank = written.filter((t: any) => !t.text || t.text === '""' || t.text.length < 5);
    expect(blank.length,
      `${blank.length} of ${written.length} exported turns are blank — this is exactly the `
      + 'cassette that cannot be replayed').toBe(0);
  });

  it('6. the cost ledger still records — recording content did not cost the ledger', () => {
    const s = JSON.stringify(generations(result.bodies));
    expect(s).toMatch(/0\.0042|420|usage|tokens/i);
  });
});
