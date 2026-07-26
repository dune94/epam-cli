/**
 * "It said the word verdict" is not a quality gate passing.
 *
 * A gate's answer was accepted on this test alone:
 *
 *     grep -qE '"(verdict|findings|agent|summary)"' "$log"
 *
 * So any text containing the word passes — a truncated report, a fragment of
 * reasoning that quotes it, a verdict of "maybe". Nothing checked the JSON
 * parsed, that the verdict was legal, or that anything was actually said.
 *
 * This is the PRODUCED-vs-VALID gap again, and it is the reason two gates could
 * "review" a change on 2026-07-26 while emitting 40 bytes of a write-tool echo
 * between them.
 *
 * Validation happens AFTER the call rather than as a provider-level strict
 * json_schema, because these gates need tools to read source and strict schema
 * mode suppresses tool calling (SCHEMA-1). The reason is fed back into the
 * retry, so attempt 2 is told what was wrong instead of just getting a bigger
 * model.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HELPER = join(__dirname, '../../../orchestrations/scripts/lib/gate_verdict_schema.py');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function check(body: string, gate = 'qa-gate:perf-sentinel') {
  const dir = mkdtempSync(join(tmpdir(), 'gate-schema-'));
  dirs.push(dir);
  const f = join(dir, 'gate.log');
  writeFileSync(f, body);
  const r = spawnSync('python3', [HELPER, gate, f], { encoding: 'utf8', timeout: 20000 });
  return { ok: r.status === 0, reason: (r.stdout || '').trim() };
}

const GOOD = JSON.stringify({
  agent: 'perf-sentinel', verdict: 'pass', summary: 'No performance-sensitive code changed.',
  findings: [],
});

describe('a gate verdict must be a real verdict', () => {
  it('accepts a well-formed one', () => {
    expect(check(GOOD).ok).toBe(true);
  });

  it('rejects the live write-tool echo', () => {
    // perf-sentinel's ENTIRE log, both attempts, on 2026-07-26.
    const r = check('The file has been written successfully.');
    expect(r.ok, 'the exact output that passed for a review').toBe(false);
    expect(r.reason).toMatch(/write tool|reply/i);
  });

  it('rejects an empty log', () => {
    // fuzz-weaver's 0-byte log in the same run.
    expect(check('').ok).toBe(false);
  });

  it('rejects prose that merely mentions the word verdict', () => {
    const r = check('Let me think about the "verdict" for this change before I decide.');
    expect(r.ok, 'the old substring grep accepted exactly this').toBe(false);
    expect(r.reason).toMatch(/no JSON object/i);
  });

  it('rejects an illegal verdict value', () => {
    const r = check(JSON.stringify({ verdict: 'maybe', summary: 'unsure' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not one of/);
  });

  it('rejects a verdict with nothing said', () => {
    expect(check(JSON.stringify({ verdict: 'pass', summary: '' })).ok).toBe(false);
  });

  it('rejects "fail" with no findings — it blocks a run while saying nothing', () => {
    const r = check(JSON.stringify({ verdict: 'fail', summary: 'bad', findings: [] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no findings/i);
  });

  it('rejects a finding with no description', () => {
    const r = check(JSON.stringify({
      verdict: 'warn', summary: 'x', findings: [{ severity: 'major' }],
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/description|unactionable/i);
  });

  it('accepts not_applicable — a gate must be able to say a change is not its business', () => {
    // Silence is indistinguishable from failure, and a fabricated "pass" is
    // worse than both. This is what perf-sentinel should return for a backend
    // string-comparison fix with no perf surface.
    const r = check(JSON.stringify({
      agent: 'perf-sentinel', verdict: 'not_applicable',
      summary: 'No performance-sensitive surface in this change.', findings: [],
    }));
    expect(r.ok, 'a gate cannot legitimately decline, so it must fake a pass or return nothing')
      .toBe(true);
  });

  it('finds the verdict inside a chatty response', () => {
    const r = check(`Here is my analysis of the diff.\n\n${GOOD}\n\nHope that helps.`);
    expect(r.ok).toBe(true);
  });

  it('gives a reason written for the model that must fix it', () => {
    const r = check('nothing useful here');
    expect(r.reason.length, 'the rejection reason is too terse to act on').toBeGreaterThan(40);
  });
});

describe('the pipeline enforces it', () => {
  const ORCH = require('node:fs').readFileSync(
    join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
  // Bound by the function's own end, not a character count — the wrapper grew
  // when self-healing and schema validation were added, and a fixed window
  // measures the length of the code rather than its behaviour.
  const wrapStart = ORCH.indexOf('_run_qa_gate_with_retry() {');
  const wrapper = ORCH.slice(wrapStart, ORCH.indexOf('\n}', wrapStart));

  it('validates the gate output instead of grepping for a substring', () => {
    expect(wrapper, 'the gate result is still accepted on a substring match')
      .toMatch(/gate_verdict_schema/);
  });

  it('feeds the rejection reason back into the retry', () => {
    expect(wrapper, 'attempt 2 differs only by model — it is never told what was wrong')
      .toMatch(/_qg_schema_reason|schema.*reason/i);
  });
});

describe('brownfield gates judge the change, not the codebase', () => {
  const ORCH = require('node:fs').readFileSync(
    join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

  it('every gate prompt carries the brownfield scope', () => {
    // On 2026-07-26 only TWO of six gates mentioned the code the run changed.
    for (const gate of ['sast-sentinel', 'spec-validator', 'review-ranger',
                        'mutant-hunter', 'fuzz-weaver', 'perf-sentinel']) {
      expect(ORCH, `${gate} is still pointed at the whole codebase`)
        .toMatch(new RegExp(`_brownfield_gate_scope ${gate}`));
    }
  });

  it('is silent on greenfield — that flow is unchanged', () => {
    const fn = ORCH.slice(ORCH.indexOf('_brownfield_gate_scope() {'),
                          ORCH.indexOf('_brownfield_gate_scope() {') + 500);
    expect(fn).toMatch(/EPAM_BROWNFIELD.*\|\| return 0/s);
  });

  it('tells the gate which files this run produced', () => {
    const fn = ORCH.slice(ORCH.indexOf('_brownfield_gate_scope() {'),
                          ORCH.indexOf('BROWNFIELD_SCOPE\n}'));
    expect(fn, 'the gate is told to scope itself but not to what')
      .toMatch(/story_outputs_files/);
  });

  it('forbids reporting pre-existing problems as findings', () => {
    const fn = ORCH.slice(ORCH.indexOf('_brownfield_gate_scope() {'),
                          ORCH.indexOf('BROWNFIELD_SCOPE\n}'));
    expect(fn).toMatch(/pre-existing issue.*NOT a finding/s);
  });

  it('makes not_applicable a legitimate answer, with a reason', () => {
    // perf-sentinel on a backend string comparison has nothing to say. It must
    // be able to say that instead of returning nothing or faking a pass.
    const fn = ORCH.slice(ORCH.indexOf('_brownfield_gate_scope() {'),
                          ORCH.indexOf('BROWNFIELD_SCOPE\n}'));
    expect(fn).toMatch(/not_applicable/);
    expect(fn, 'a gate could still return "pass" to mean "I could not evaluate this"')
      .toMatch(/do NOT return "pass" to\s*#?\s*mean/is);
  });
});

/**
 * A gate that obeys its own prompt must not be rejected.
 *
 * Live metrolinx 2026-07-26, run 8. Everything the run existed for succeeded:
 * the detective found the real line, the fix was two lines reusing the
 * prescribed existing parser, the bug-reproduction gate proved it RED→GREEN by
 * execution, review approved it, the lint gate reported NEW_FINDINGS=0. Then the
 * run failed — on the spec validator, which had answered `pass`.
 *
 * Its prompt declares this exact shape:
 *
 *   { "agent": "...", "phase": "...",
 *     "stories": [{ "storyId": "...", "verdict": "pass|warn|fail", ... }],
 *     "overallVerdict": "pass|warn|fail" }
 *
 * The agent emitted precisely that. This validator demanded a TOP-LEVEL
 * "verdict" plus a "summary", found neither, and rejected it twice — then the
 * whole phase failed, and the finding-analyst had no grounded finding to
 * remediate because there was no defect, only a disagreement between two parts
 * of this engine about what an answer looks like.
 *
 * The prompt is the contract. A validator that contradicts the instructions the
 * agent was given is not enforcing a standard, it is inventing a second one.
 */
describe('the declared multi-item gate shape is accepted', () => {
  // Verbatim from orchestrations/logs/spec-validator-core.log, run 8.
  const LIVE = `\`\`\`json
{
  "agent": "spec-validator",
  "phase": "core",
  "stories": [{
    "storyId": "AMSD-1820",
    "title": "[Mozio] - The Promo code amount is NOT displayed as expected",
    "criteria": [],
    "overallCompliance": 100,
    "verdict": "pass"
  }],
  "overallVerdict": "pass"
}
\`\`\``;

  it('accepts the answer that failed run 8', () => {
    const r = check(LIVE, 'spec-validator');
    expect(r.ok, `a correct verdict was rejected: ${r.reason}`).toBe(true);
  });

  it('reads the verdict from overallVerdict when that is the declared field', () => {
    expect(check('{"overallVerdict":"fail","stories":[]}', 'spec-validator').ok).toBe(true);
  });

  it('does not demand a prose summary when structured detail is present', () => {
    // The per-item breakdown IS the account of what was checked; requiring a
    // separate sentence on top of it is a second, undeclared contract.
    const r = check('{"overallVerdict":"pass","stories":[{"storyId":"X","verdict":"pass"}]}',
                    'spec-validator');
    expect(r.ok, r.reason).toBe(true);
  });

  it('still rejects an illegal verdict value in the declared shape', () => {
    expect(check('{"overallVerdict":"maybe","stories":[]}', 'spec-validator').ok).toBe(false);
  });

  it('still rejects an object carrying no verdict of any kind', () => {
    expect(check('{"stories":[{"storyId":"X"}]}', 'spec-validator').ok).toBe(false);
  });

  it('still requires a summary from a gate that emits no structured detail', () => {
    // A bare {"verdict":"pass"} says nothing about what was examined.
    expect(check('{"verdict":"pass"}', 'sast-sentinel').ok).toBe(false);
  });
});
