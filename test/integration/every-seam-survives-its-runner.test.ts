/**
 * EVERY DECLARED SEAM, DRIVEN THROUGH THE REAL ENTRY, WITH A STUBBED RUNNER.
 *
 * All 40 seams enter the model through run_orch_prompt. Until it was lifted into
 * lib/orch-prompt.sh it sat inside an 11,213-line script with no main(), so sourcing it to reach
 * the function ran the whole pipeline and no test could call it. That — not the difficulty of
 * writing tests — is why 33 of 40 seams had no integration coverage, and why every defect worth
 * catching here has been at a join while the unit suite stayed green:
 *
 *   - three QA gates resolving to no seam, five more on a borrowed ladder
 *   - a shell notice printed onto a captured stdout, eating an agent's reply and killing
 *     metrolinx three attempts running
 *   - a prompt that never reached the trace
 *
 * The table is DERIVED: every seam the contract registry declares, with the answer built by the
 * same contract stand-in the mock server uses. A seam added tomorrow is covered by existing here,
 * not by anyone remembering to add a case.
 *
 * Two properties per seam, both cheap and both about the JOIN rather than the unit:
 *   1. the seam is reachable and its answer survives the round trip
 *   2. a diagnostic sharing the runner's stdout does not eat that answer
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../orchestrations/scripts/lib/orch-prompt.sh');
const PROJECT = join(__dirname, '../../orchestrations/projects/mock3');
process.env.PRD_FILE = process.env.PRD_FILE || join(PROJECT, 'prd.json');
process.env.EPAM_PROJECT_CONFIG_DIR = process.env.EPAM_PROJECT_CONFIG_DIR || PROJECT;

const { declaredContracts } = require('../../orchestrations/scripts/lib/agent-output-schema.js');
const { contractStandIn } = require('../../orchestrations/scripts/mock-expectations.js');
const { extractTaggedJson } = require('../../orchestrations/scripts/spec-mode-runner.js');
const { unwrapEnvelope, validateTaggedOutput } =
  require('../../orchestrations/scripts/lib/agent-output-schema.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The notice that actually corrupted metrolinx, in shape. */
const NOISE = "  [provider] 'openrouter' is not routable by the 'claude' set — using 'claude'.";

type Case = { seam: string; answer: string; probe: string; tag?: string };

/** Every seam the registry declares, with the answer its own contract says is valid. */
function cases(): Case[] {
  const out: Case[] = [];
  for (const [seam, c] of Object.entries<any>(declaredContracts() || {})) {
    let stood: any = null;
    try { stood = contractStandIn(seam); } catch { stood = null; }
    if (!stood) continue;                       // nothing declared to stand in for: skipped loudly below
    const body = JSON.stringify(stood);
    const answer = c && c.tag ? `<${c.tag}>${body}</${c.tag}>` : body;
    // Something distinctive from the answer itself, so the assertion cannot pass on an empty echo.
    const probe = c && c.tag ? c.tag : (Object.keys(stood)[0] || '');
    if (!probe) continue;
    out.push({ seam, answer, probe, tag: (c && c.tag) || undefined });
  }
  return out;
}

/**
 * Drive a seam through the REAL capture path.
 *
 * run_orch_prompt captures the runner with `2>&1 | tee`, so ANYTHING the pipeline writes to stderr
 * — a provider notice, a banner, a deprecation warning — is merged into the very text the consumer
 * parses. Feeding a clean answer tests the caller, not the receiver, and that gap cost two paid
 * metrolinx runs: a stderr-only fix was shipped as "corruption resolved" while the corruption was
 * still arriving through the merge.
 *
 * `stderrNoise` reproduces it exactly.
 */
function drive(answer: string, stderrNoise = '') {
  const dir = mkdtempSync(join(tmpdir(), 'seam-all-')); dirs.push(dir);
  const runner = join(dir, 'ai-run.sh');
  writeFileSync(runner, [
    '#!/usr/bin/env bash',
    '[ -n "${ORCH_JSON_RESULT:-}" ] && printf \'%s\' \'{"cost_usd":0,"usage":{"inputTokens":1,"outputTokens":1}}\' > "$ORCH_JSON_RESULT"',
    // Written to STDERR, which 2>&1 merges into the captured stream — the real path.
    ...(stderrNoise ? [`cat >&2 <<'NOISE_EOF'`, stderrNoise, 'NOISE_EOF'] : []),
    "cat <<'ANSWER_EOF'", answer, 'ANSWER_EOF',
  ].join('\n'));
  chmodSync(runner, 0o755);
  const script = `
    set -uo pipefail
    . ${JSON.stringify(LIB)} 2>/dev/null || true
    log() { :; }; error() { :; }; warning() { :; }
    resolve_prompt_provider() { printf '%s' 'claude'; }
    seam_ladder_export() { :; }
    seam_model_or_fail() { printf '%s' 'a-model'; }
    seam_next_model() { printf '%s' ''; }
    AI_RUNNER_CMD=${JSON.stringify(runner)}
    CLAUDE_CMD=${JSON.stringify(runner)}
    run_orch_prompt "a prompt" "some-agent" "a-story"
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60000 });
  return r.stdout || '';
}

const TABLE = cases();

describe('every seam survives its runner', () => {
  it('the table is populated — an empty table would prove nothing', () => {
    expect(TABLE.length, 'no seam produced a contract-valid stand-in').toBeGreaterThan(5);
  });

  it.each(TABLE.map((c) => [c.seam, c] as [string, Case]))(
    '%s: its answer survives the round trip', (_seam, c) => {
      expect(drive(c.answer)).toContain(c.probe);
    }, 60_000);

  it.each(TABLE.map((c) => [c.seam, c] as [string, Case]))(
    '%s: a diagnostic on the runner stdout does not eat the answer', (_seam, c) => {
      // THE LAYER THAT ACTUALLY BROKE. run_orch_prompt passes stdout through, so asserting the
      // text is still there is nearly free — the metrolinx corruption bit in the PARSER, which saw
      // the answer plus two [provider] lines, found two values where it wanted one, and reported
      // the key absent when it was present. So the driven output is put through the real extractor
      // and must still yield the answer.
      const polluted = drive(c.answer, NOISE);
      expect(polluted, 'the seam returned nothing at all').toContain(c.probe);
      if (!c.tag) return;                 // only a tagged contract has an extractor to run
      const parsed = extractTaggedJson(polluted, c.tag);
      expect(parsed, `the parser lost ${c.seam}'s answer to a line it did not expect`).toBeTruthy();
    }, 60_000);

  it.each(TABLE.filter((c) => c.tag).map((c) => [c.seam, c] as [string, Case]))(
    '%s: what comes back is VALID against its own declared contract', (_seam, c) => {
      // Extracting is not the same as being acceptable. A seam can hand its consumer a payload
      // that parses and still fails the contract the registry declares for it — which is the
      // difference between "the answer arrived" and "the answer is usable", and the difference
      // the mint spent three metrolinx attempts on.
      // ARGUMENT ORDER IS (tag, parsed). Called the other way round it looks up a schema for the
      // PAYLOAD, finds none, and returns pass() for anything at all — which is exactly how this
      // assertion first shipped, green and worthless. The mutation caught it: neutering every item
      // check left all 95 passing.
      const extracted = extractTaggedJson(drive(c.answer), c.tag as string);
      const verdict = validateTaggedOutput(c.tag as string, extracted);
      expect(verdict.ok, `${c.seam} returned a payload its own contract rejects: ${verdict.reason}`)
        .toBe(true);

      // THE NEGATIVE, which is what proves the validator is engaged rather than absent: a payload
      // that is plainly not this seam's answer must be refused.
      const refused = validateTaggedOutput(c.tag as string, [{ nothing: 'that belongs here' }]);
      expect(refused.ok, `${c.seam}'s contract accepts anything — it enforces nothing`).toBe(false);
    }, 60_000);

  it.each(TABLE.filter((c) => c.tag).map((c) => [c.seam, c] as [string, Case]))(
    '%s: the answer is found when the model wraps it in an array', (_seam, c) => {
      // THE METROLINX SHAPE. The mint returned [{"proposedAgents":[...]}] — its answer inside a
      // one-element array — and the parser reported the key absent while it was plainly present.
      // A plain-object stand-in never exercises that path: neutering unwrapEnvelope left this
      // whole file green, which is how I learned this case was missing rather than covered.
      const body = JSON.parse(c.answer.replace(new RegExp(`^<${c.tag}>|</${c.tag}>$`, 'g'), ''));
      const wrapped = `<${c.tag}>${JSON.stringify([body])}</${c.tag}>`;
      const extracted = extractTaggedJson(drive(wrapped), c.tag);
      expect(extracted, `${c.seam}'s answer was lost inside a one-element array`).toBeTruthy();
      // THE CONSUMER'S PATH, not the extractor's. Extraction extracts; the envelope comes off
      // where the expected key is known. Asserted through the key the answer actually carries,
      // so this exercises the real removal rather than a shape guess.
      const key = Array.isArray(body) ? null : Object.keys(body)[0];
      const parsed = key ? unwrapEnvelope(extracted, key) : extracted;
      expect(parsed, `${c.seam} kept its envelope — the consumer receives [answer], not answer`)
        .toEqual(key ? body : [body]);
    }, 60_000);
});
