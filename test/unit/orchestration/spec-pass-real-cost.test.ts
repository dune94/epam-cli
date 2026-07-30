/**
 * The spec pass reported $0 into the ledger everything reads.
 *
 * Measured 2026-07-30 against the killed AMSD-2041 run. Two ledgers disagreed:
 *
 *   lane        agent-activity   phase-cost    missing
 *   gotransit   $0.4815          $0.3738       $0.1077  (22%)
 *   upexpress   $1.4426          $1.3671       $0.0755  (5%)
 *
 * The missing amounts match, to the cent, the cost_snapshot records carrying
 * `source: "spec-mode-runner"` — code-graph-detective ($0.1077 / $0.0684) and
 * vc-agent ($0.0071). Those calls ARE billed and ARE recorded; they simply
 * never reach phase-cost.jsonl, which is what the dashboard, the run report and
 * validate-dashboards.sh all sum.
 *
 * The cause is a literal, and its own comment says so:
 *
 *   # GAP-P22: emit spec runner cost record (token/cost estimated — spec runner
 *   # doesn't expose per-call usage; a future improvement can parse spec logs)
 *   append_pipeline_cost_record "spec-pass" "$phase_id" "$model" "$started" \
 *       "0" "0" "0" "0"
 *
 * That was true when written. It is not true now: spec-mode-runner wires
 * emitCostSnapshot through runClaude, which is the funnel for the detective,
 * openspec, speckit, the spec coordinator, the VC reviewer and the PRD change
 * reviewer. The data exists; the shell just keeps writing zeros over it.
 *
 * THE RULE: cost tracking that silently reports zero is worse than none — a
 * reader cannot tell "free" from "unmeasured". This is the same defect class as
 * the parallel-lane ledger fragmentation, where phase-cost.jsonl read EMPTY
 * while the real records sat in lanes/<codeline>/.
 *
 * Note what this does NOT claim: the spec pass is slow, not expensive. It is
 * 84-98% of wall clock for ~$0.11. Making its cost visible is about the ledger
 * being true, not about the spend being large.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fnText(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() not found`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

/** An activity ledger shaped exactly like the live one. */
function activityLine(agent: string, costUsd: number, source: string, phase = 'core') {
  return JSON.stringify({
    event_id: `evt-${agent}-${costUsd}`,
    timestamp: '2026-07-30T10:12:35+00:00',
    agent, story_id: 'AMSD-2041', phase, type: 'cost_snapshot',
    model: 'z-ai/glm-5.1', provider: 'qwen',
    detail: { costUsd, tokensIn: 1000, tokensOut: 50, turns: 0, source },
  });
}

/** Run the real summariser against a real activity file. */
function summarise(lines: string[], phase = 'core') {
  const d = mkdtempSync(join(tmpdir(), 'speccost-'));
  dirs.push(d);
  writeFileSync(join(d, 'agent-activity.jsonl'), lines.join('\n') + '\n');
  const script = join(d, 'run.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
LOG_DIR=${JSON.stringify(d)}
${fnText('_spec_pass_usage')}
_spec_pass_usage ${JSON.stringify(phase)}
`);
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const [cost, tin, tout, turns] = out.split(/\s+/);
  return { cost: Number(cost), tin: Number(tin), tout: Number(tout), turns: Number(turns), raw: out };
}

describe('the spec pass reports what it actually spent', () => {
  it('sums the spec runner\'s own agents — the live 22% gap', () => {
    const { cost } = summarise([
      activityLine('code-graph-detective', 0.1077, 'spec-mode-runner'),
      activityLine('vc-agent', 0.0071, 'spec-mode-runner'),
    ]);
    expect(cost, 'the spec pass still reports zero into phase-cost.jsonl, so a ' +
      'reader cannot tell "free" from "unmeasured"').toBeCloseTo(0.1148, 4);
  });

  it('counts ONLY spec-runner-sourced records', () => {
    // typescript-engineer and team-lead-agent already write their own
    // phase-cost rows. Summing them here would DOUBLE-COUNT the run — a ledger
    // that overstates is no more true than one that understates.
    const { cost } = summarise([
      activityLine('code-graph-detective', 0.1077, 'spec-mode-runner'),
      activityLine('typescript-engineer', 0.4550, 'append_cost_record'),
      activityLine('team-lead-agent', 0.0983, 'run_orch_prompt'),
    ]);
    expect(cost, 'agents that already record their own cost were counted twice')
      .toBeCloseTo(0.1077, 4);
  });

  it('counts only THIS phase', () => {
    const { cost } = summarise([
      activityLine('code-graph-detective', 0.1077, 'spec-mode-runner', 'core'),
      activityLine('code-graph-detective', 0.9999, 'spec-mode-runner', 'other'),
    ], 'core');
    expect(cost, 'another phase\'s spend leaked into this record').toBeCloseTo(0.1077, 4);
  });

  it('carries tokens and turns too, not just dollars', () => {
    const { tin, tout } = summarise([
      activityLine('code-graph-detective', 0.1077, 'spec-mode-runner'),
      activityLine('vc-agent', 0.0071, 'spec-mode-runner'),
    ]);
    expect(tin, 'input tokens still report zero').toBe(2000);
    expect(tout, 'output tokens still report zero').toBe(100);
  });

  it('reports zero when the spec runner genuinely made no billed call', () => {
    // Real zero must stay possible — the point is that zero should MEAN zero.
    expect(summarise([activityLine('typescript-engineer', 0.45, 'append_cost_record')]).cost).toBe(0);
  });

  it('survives a missing activity file without failing the run', () => {
    const d = mkdtempSync(join(tmpdir(), 'speccost-none-'));
    dirs.push(d);
    const script = join(d, 'run.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
LOG_DIR=${JSON.stringify(d)}
${fnText('_spec_pass_usage')}
_spec_pass_usage core
echo "RC=$?"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect(r.stdout || '', 'a missing ledger broke the spec step').toMatch(/RC=0/);
  });

  it('tolerates a malformed line rather than aborting', () => {
    const { cost } = summarise([
      'not json at all',
      activityLine('code-graph-detective', 0.1077, 'spec-mode-runner'),
    ]);
    expect(cost).toBeCloseTo(0.1077, 4);
  });
});

describe('the hardcoded zeros are gone', () => {
  it('the spec-pass ledger row no longer passes literal zeros', () => {
    // The behavioural tests prove the summariser. This proves it is WIRED —
    // the literal "0" "0" "0" "0" is what made the row false for every run.
    const i = SRC.indexOf('append_pipeline_cost_record "spec-pass"');
    expect(i, 'the spec-pass cost row is gone entirely').toBeGreaterThan(-1);
    const row = SRC.slice(i, i + 400);
    expect(row, 'spec-pass still writes hardcoded zeros into phase-cost.jsonl')
      .not.toMatch(/"0"\s+"0"\s+"0"\s+"0"/);
    expect(row, 'the row does not use the measured usage').toMatch(/_spec_(cost|usage)/);
  });
});
