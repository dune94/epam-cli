/**
 * CODEMIE ANSWERS THROUGH THE REAL PATH — AND CLAUDE STILL DOES. LIVE TOKENS.
 *
 * THE FAILURE (2026-09-07, AMSD-1919 on the codemie stack): codeline-discovery gave up after 3
 * attempts — "the answer was EMPTY (no text at all — a transport or budget failure, not a format
 * one)" — and the run aborted before doing any work.
 *
 * It WAS a format failure, and the pipeline could not say so:
 *   - `codemie-claude --print --output-format json` prints a human banner FIRST
 *     ("CLI Version │ 0.10.1", "Session │ …"), then the JSON. The plain `claude` CLI does not.
 *     This arm's own comment claimed the wrapper "answers in the same JSON shape".
 *   - so `jq -r '.result // empty'` died on "Invalid numeric literal at line 2" → EMPTY.
 *   - and the arm sent the wrapper's stderr to /dev/null, so nothing explained it. The plain
 *     claude arm got exactly that stderr fix on 2026-08-26 (916ea6f2 "the hub was hiding the
 *     reason"); this arm, fifteen lines below in the same case statement, never did.
 *
 * WHY LIVE TOKENS ARE REQUIRED. Every cheap check passed while the pipeline was dead: provider
 * resolves, model resolves, TEXT-mode call answers, a 51KB prompt answers. Only the JSON arm —
 * which every cost-tracked seam selects by setting ORCH_JSON_RESULT — failed. A mocked wrapper
 * would have encoded the same false assumption about its output shape, so it must be the real
 * binary.
 *
 * CLAUDE IS PROVEN UNCHANGED HERE TOO, in the same file, because "I only edited the other branch"
 * is a claim and this is evidence. Baseline taken before the fix: stdout "OK", cost JSON parses,
 * .result "OK".
 *
 * Gated on EPAM_LIVE_CODEMIE=1 so an ordinary suite run spends nothing.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const LIVE = process.env.EPAM_LIVE_CODEMIE === '1';
const HANDLER = join(process.cwd(), 'orchestrations', 'scripts', 'llm-handler.sh');
const SRC = readFileSync(HANDLER, 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** One vendor arm of the case statement, so an assertion cannot pass on a neighbour's lines. */
function arm(name: string): string {
  const i = SRC.indexOf(`\n    ${name})`);
  expect(i, `arm ${name} not found`).toBeGreaterThan(-1);
  const rest = SRC.slice(i + 1);
  const j = rest.search(/\n    [a-z0-9|_-]+\)\n/);
  return j > -1 ? rest.slice(0, j) : rest;
}

/** Drives the REAL handler the way a cost-tracked seam does: ORCH_JSON_RESULT set. */
function call(provider: string, set: string) {
  const d = tmp('llm-');
  const jsonOut = join(d, 'result.json');
  let stdout = '', stderr = '', status = 0;
  try {
    stdout = execFileSync('bash', [HANDLER, '--provider', provider, '--model', 'claude-sonnet-5'], {
      input: 'Reply with the single word OK and nothing else.\n',
      encoding: 'utf8', timeout: 300_000,
      env: { ...process.env, ORCH_JSON_RESULT: jsonOut, EPAM_PROVIDER_SET: set },
    });
  } catch (e: any) { stdout = e.stdout || ''; stderr = e.stderr || ''; status = e.status ?? -1; }
  return { stdout, stderr, status, json: existsSync(jsonOut) ? readFileSync(jsonOut, 'utf8') : '' };
}

describe.skipIf(!LIVE)('codemie-claude on the cost-tracked JSON arm (live tokens)', () => {
  it('RETURNS THE ANSWER instead of the empty string discovery reads as a transport failure', () => {
    const r = call('codemie-claude', 'codemie');
    expect(r.stdout.trim(), 'the handler returned NOTHING. This is exactly what codeline-discovery '
      + `reports as "the answer was EMPTY". stderr: ${r.stderr.slice(0, 300)}`).not.toBe('');
    expect(r.stdout, 'the answer text is missing').toMatch(/OK/i);
  });

  it("does not leak the wrapper's banner into the answer", () => {
    const r = call('codemie-claude', 'codemie');
    expect(r.stdout, 'the CLI banner reached the caller as if it were the model\'s answer')
      .not.toMatch(/CLI Version|CodeMie URL|Session\s+│/);
  });

  it('writes a cost record that PARSES — or every codemie call costs "unknown"', () => {
    const r = call('codemie-claude', 'codemie');
    expect(r.json, 'no cost record written').not.toBe('');
    expect(() => JSON.parse(r.json),
      `the cost ledger stored unparseable content: ${r.json.slice(0, 160)}`).not.toThrow();
    expect(JSON.parse(r.json).result, 'the record has no .result for the ledger to read')
      .toMatch(/OK/i);
  });
});

describe.skipIf(!LIVE)('claude is NOT broken by the codemie fix (live tokens)', () => {
  it('answers exactly as it did before the change', () => {
    const r = call('claude', 'claude');
    expect(r.stdout.trim(), `claude regressed. stderr: ${r.stderr.slice(0, 300)}`).toMatch(/OK/i);
    expect(r.json, 'claude wrote no cost record').not.toBe('');
    expect(() => JSON.parse(r.json), 'claude cost record no longer parses').not.toThrow();
    expect(JSON.parse(r.json).result, 'claude .result missing').toMatch(/OK/i);
  });
});

describe('arm invariants (no tokens)', () => {
  it('THE CLAUDE ARM IS UNTOUCHED — pinned to the bytes captured before the codemie fix', () => {
    // Not a style rule: the operator's standing constraint is that a codemie fix may not change
    // the provider that works. If a future change to this arm is intended, update the pin
    // deliberately and re-run the live claude case above.
    const sha = createHash('sha256').update(arm('claude')).digest('hex');
    expect(sha, 'the claude arm changed — re-prove it live before updating this pin')
      .toBe('b2e4e8d57a7b19fdbd8b215fc4306c84608991558b569473bdc34f1d72508113');
  });

  it('the codemie arm keeps stderr, like the claude arm already does', () => {
    expect(arm('codemie-claude'), 'stderr discarded again — an empty answer will explain nothing')
      .toMatch(/2>"\$_cm_err"/);
  });

  it('the codemie arm does not assume the wrapper emits bare JSON', () => {
    // The payload is ONE line: the banner precedes it and a sign-off follows it, so a range that
    // runs to end-of-file still is not JSON — that mistake made the first fix look applied while
    // the arm stayed broken, and only the live case caught it.
    expect(arm('codemie-claude'), 'raw wrapper output piped to jq — the banner breaks it')
      .toMatch(/grep -m1 '\^\[\[:space:\]\]\*\{'/);
  });
});
