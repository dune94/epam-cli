/**
 * AN OUTPUT-CAP HIT IS A FAILURE CLASS, AND THE RETRY GETS ROOM. NO CREDIT IS ANOTHER, AND IT HALTS.
 *
 * regintel 140717Z (2026-09-21): z-ai/glm-5.3 returned exactly the per-iteration cap on every
 * iteration, the CLI said so on stderr — "Response truncated at max_tokens with no usable output …
 * Raise EPAM_MAX_OUTPUT_TOKENS" — and exited 1 with no result. The coordinator saw only
 * raw=0 bytes / exit=1, called it an environment failure, checked the API key, and let the ladder
 * retry the identical cap: 8 attempts on REGI-004-A, 8 on REGI-010-A, both marked FAILED.
 * Later the same signature (0 bytes, exit 1) was the account running out of credit, and the
 * diagnosis still said "key OK — model/timeout issue".
 *
 * classify_failure_class now reads the attempt's own log: the runner's truncation message is class
 * output_cap and the retry is given the widest tier's output budget; a balance at zero is class
 * credit and the story halts instead of burning its ladder. Driven through the REAL function.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const HEAL = join(ROOT, 'orchestrations/scripts/lib/failure-healing.sh');
const ATTEMPT = join(ROOT, 'orchestrations/scripts/lib/story-attempt.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fn(name: string): string {
  const lines = engineSource(HEAL).split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(l));
  if (start < 0) throw new Error(`${name}() not found in failure-healing.sh`);
  const end = lines.findIndex((l, i) => i > start && /^\}/.test(l));
  return lines.slice(start, end + 1).join('\n');
}

const TRUNCATION = 'Error: Response truncated at max_tokens with no usable output — the model spent its entire output budget on reasoning. Raise EPAM_MAX_OUTPUT_TOKENS or disable reasoning for this call. Partial text (0 chars):';

function classify(opts: { log: string; balance?: string; budget?: string }) {
  const d = mkdtempSync(join(tmpdir(), 'cap-class-')); dirs.push(d);
  const log = join(d, 'main-S-1.log'); writeFileSync(log, opts.log);
  const raw = join(d, 'raw.json'); writeFileSync(raw, '');           // 0 bytes, as the runner left it
  const s = join(d, 'h.sh');
  writeFileSync(s, `#!/usr/bin/env bash
set -uo pipefail
log(){ echo "LOG: $*"; }; warning(){ echo "WARN: $*"; }; error(){ echo "ERR: $*"; }
spend_probe_read(){ :; }
balance_probe_read(){ printf '%s' "${opts.balance ?? ''}"; }
EPAM_CLI=bash
# The budgets come from the REAL loader over the REAL config — not a variable set here. The first
# version of this test set EPAM_EFFORT_MAX_MAX_OUTPUT_TOKENS by hand, and live the loader had never
# exported it (it iterated a written list of tiers), so the retry ran at the same cap.
AUTOMATION_DIR="${join(ROOT, 'orchestrations')}"; PRD_FILE=/dev/null
. "${join(ROOT, 'orchestrations/scripts/lib/model-ladder.sh')}"
load_llm_settings_json 2>/dev/null || true
STORY_MAX_OUTPUT_TOKENS=6144
${fn('classify_failure_class')}
${fn('raise_output_budget_after_cap_hit')}
classify_failure_class "${raw}" "" 1 S-1 "${log}"
echo "CLASS=$COORDINATOR_FAILURE_CLASS ESCALATE=$COORDINATOR_ESCALATE"
raise_output_budget_after_cap_hit
echo "BUDGET=$STORY_MAX_OUTPUT_TOKENS"
`);
  const r = spawnSync('bash', [s], { encoding: 'utf8', timeout: 60_000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return { out, cls: /CLASS=(\S+)/.exec(out)?.[1], esc: /ESCALATE=(\S+)/.exec(out)?.[1], budget: /BUDGET=(\S+)/.exec(out)?.[1] };
}

describe('an output-cap hit is classified and the retry is given room', () => {
  it("the runner's truncation message in the attempt log is class output_cap, not env", () => {
    const r = classify({ log: `=== epam output ===\n${TRUNCATION}\n=== epam exited with code 1 ===\n` });
    expect(r.cls, r.out).toBe('output_cap');
    expect(r.esc).toBe('yes');
  });
  it("the next attempt's output budget becomes the widest tier the config declares", () => {
    const tiers = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/llm-defaults.json'), 'utf8')).effortTiers;
    const widest = Math.max(...Object.values(tiers).map((t: any) => Number(t.maxOutputTokens)));
    const r = classify({ log: TRUNCATION });
    expect(r.budget, r.out.slice(-600)).toBe(String(widest));
    expect(widest).toBeGreaterThan(6144);
  });
  it('a plain 0-byte failure with credit in the account is still env (and the budget is untouched)', () => {
    const r = classify({ log: 'some other stderr\n', balance: '12.40' });
    expect(r.cls).toBe('env');
    expect(r.budget).toBe('6144');
  });
});

describe('no credit is its own class and it halts', () => {
  it('a balance at zero is class credit, escalate no, and says so', () => {
    const r = classify({ log: 'some other stderr\n', balance: '0.02' });
    expect(r.cls, r.out).toBe('credit');
    expect(r.esc).toBe('no');
    expect(r.out).toMatch(/credit|balance/i);
  });
  it('the story loop hands the classifier the attempt log and stops on credit', () => {
    const src = readFileSync(ATTEMPT, 'utf8');
    expect(src).toMatch(/classify_failure_class "\$_raw_for_coord" "\$json_result_file" "\$exit_code" "\$story_id" "\$output_file"/);
    const at = src.indexOf('classify_failure_class "$_raw_for_coord"');
    const after = src.slice(at, at + 1200);
    expect(after).toMatch(/raise_output_budget_after_cap_hit/);
    expect(after).toMatch(/"credit"/);
  });
});
