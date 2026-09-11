/**
 * THE PROVIDER TOLD US EXACTLY WHAT WAS WRONG AND THE RUN LOG SAID "no response to parse".
 *
 * On 2026-09-11 (openrouter run 20260910T222155Z) the failure analyst lost three calls across two
 * models. The run log carried only:
 *
 *     [FailureAnalyst] Gate invocation FAILED for z-ai/glm-5.3 (attempt 1/3) — no response to parse
 *
 * The real cause was sitting in orchestrations/logs/claude_outputs/, a file nothing points the
 * operator at:
 *
 *     OpenRouter API error: 404 {"error":{"message":"No endpoints found for z-ai/glm-5.3.",
 *      "metadata":{"routing_funnel":[... {"step":"Filter by Fallback","endpoint_count":0}]}}}
 *
 * Reading only the run log, I diagnosed this wrongly twice — first as "no model on the ladder can
 * produce parseable output", then as "transient" — before finding the funnel. Both were stated to
 * the operator with more confidence than the evidence carried. A message that hides the cause does
 * not just cost debugging time; it produces confident wrong answers.
 *
 * So the failure line carries the cause. [[fb_no_silent_failure_mechanisms]], and
 * [[fb_diagnose_tooling_not_model]] — this looked like a model fault and was a routing fault.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** The real helper, lifted from claude.sh — never a re-typed copy. */
function extractFn(): string {
  const lines = readFileSync(CLAUDE_SH, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^_gate_call_failure_detail\(\)\s*\{/.test(l));
  if (start < 0) throw new Error('_gate_call_failure_detail() not found in claude.sh');
  const end = lines.findIndex((l, i) => i > start && /^\}/.test(l));
  if (end < 0) throw new Error('_gate_call_failure_detail() has no closing brace at column 0');
  return lines.slice(start, end + 1).join('\n');
}

function detailFor(stderrText: string): string {
  const d = tmp('gatefail-');
  const errFile = join(d, 'err.txt');
  writeFileSync(errFile, stderrText);
  const s = join(d, 'h.sh');
  writeFileSync(s, `#!/usr/bin/env bash
set -uo pipefail
${extractFn()}
_gate_call_failure_detail "${errFile}"
`);
  const r = spawnSync('bash', [s], { encoding: 'utf8', timeout: 60_000 });
  return ((r.stdout ?? '') + (r.stderr ?? '')).trim();
}

const FUNNEL_404 = `[coverage-gate] standing down
Error: All providers exhausted without a successful response. Attempted: openrouter/z-ai/glm-5.3: OpenRouter/OpenRouter API error: 404 {"error":{"message":"No endpoints found for z-ai/glm-5.3.","code":404,"metadata":{"routing_funnel":[{"step":"Initial Endpoints","endpoint_count":28},{"step":"Filter by Fallback","endpoint_count":0}]}}}
[ai-run] 'claude' failed after 3 attempt(s) across every provider and ladder rung.`;

describe('a failed gate call names its cause', () => {
  it('surfaces the provider error instead of swallowing it', () => {
    const d = detailFor(FUNNEL_404);
    expect(d, `detail was: '${d}'`).toMatch(/404|No endpoints found/);
  });

  it('names the routing funnel — the part that says WHY the endpoints went to zero', () => {
    expect(detailFor(FUNNEL_404).toLowerCase()).toMatch(/fallback|routing_funnel|endpoint/);
  });

  it('says plainly when the call produced no error text at all — never invents one', () => {
    const d = detailFor('');
    expect(d.length, 'an empty stderr produced no explanation').toBeGreaterThan(0);
    expect(d.toLowerCase()).toMatch(/no error output|empty|nothing/);
  });

  it('is bounded — a huge stderr cannot flood the run log', () => {
    const d = detailFor('x'.repeat(50_000) + '\n' + FUNNEL_404);
    expect(d.length, `detail was ${d.length} chars`).toBeLessThan(1000);
  });

  it('the failure warning actually uses it', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const line = src.split('\n').find((l) => l.includes('Gate invocation FAILED for'));
    expect(line, 'the failure warning is gone').toBeTruthy();
    expect(line!, `the warning still reports only "no response to parse": ${line}`)
      .toMatch(/_gate_call_failure_detail|_gate_fail_detail/);
  });
});
