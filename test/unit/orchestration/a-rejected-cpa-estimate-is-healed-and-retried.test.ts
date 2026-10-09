/**
 * A REJECTED CPA ESTIMATE IS HEALED AND RETRIED — never silently reverted.
 *
 * Live AMSD-2974 run 2 (2026-10-09): the reviewer rejected the story's CPA estimate and the script
 * reverted it to its pre-CPA values. No self-heal analyst, no retry, no climb — the operator: "a
 * critical problem". Self-heal is for any and all retries, not the writer's alone.
 *
 * Now a rejection: (1) is kept on disk with the reviewer's issues, (2) goes through the self-heal
 * analyst, told why, (3) re-asks the estimator with the reviewer's issues, one rung up its ladder,
 * (4) is reviewed again; the pre-CPA values stand only when every round is rejected.
 *
 * EXECUTED: the real contextualize-stories.sh --apply, the real cpa-inference.js, the real
 * agent-attempt-analyst.sh. Only the model is stood in (AI_RUNNER_CMD), answering by the agent asking.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, chmodSync, cpSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// THE REAL ESTATE: the project's own minted prompts and ladder settings, copied from the install the
// live runs use (read-only source). Skipped, and said so, on a machine without that install.
const PROJECT = process.env.CPA_RETRY_PROJECT
  || join(homedir(), 'projects/tests/installs/amsd-2974-20260930T1455/orchestrations/projects/metrolinx');
const HAS_PROJECT = existsSync(join(PROJECT, 'prompts', 'cpa-inference.json'));
const ISSUE = 'the estimate prices one codeline but the story spans four';

function estate(rejections: number) {
  const d = mkdtempSync(join(tmpdir(), 'cpa-retry-')); dirs.push(d);
  const calls = join(d, 'calls'); mkdirSync(calls);
  const logs = join(d, 'logs'); mkdirSync(logs);
  const cfg = join(d, 'cfg'); mkdirSync(cfg);
  for (const f of ['prompts', 'llm-settings.json', 'agent-profiles.json', 'roster.json']) {
    if (existsSync(join(PROJECT, f))) cpSync(join(PROJECT, f), join(cfg, f), { recursive: true });
  }
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    project: { name: 'p' },
    implementationOrder: { core: ['S-1'] },
    stories: [{ id: 'S-1', title: 'fix the thing', description: 'd', effort: 'low', estimatedAiMinutes: 10, estimatedCost: 1,
      estimatedTokens: 1000, estimatedTurns: 2, codelines: ['a', 'b', 'c', 'd'], issueType: 'Bug' }],
  }));
  // The stand-in model: one numbered record per call, the answer chosen by the agent that asked.
  const runner = join(d, 'runner.sh');
  writeFileSync(runner, `#!/usr/bin/env bash
in=$(cat); n=$(ls ${calls} | wc -l); f=${calls}/$(printf %03d $n)-\${EPAM_AGENT_NAME:-unknown}.txt
printf 'MODEL=%s\n%s' "\${EPAM_MODEL:-}" "$in" > "$f"
case "\${EPAM_AGENT_NAME:-}" in
  prd-change-reviewer)
    r=$(ls ${calls} | grep -c prd-change-reviewer)
    if [ "$r" -le ${rejections} ]; then echo '{"verdict":"fail","issues":["${ISSUE}"],"reason":"underpriced"}'
    else echo '{"verdict":"pass","issues":[],"reason":"ok"}'; fi ;;
  cpa-inference)
    echo '{"confidence":0.8,"adjustedEstimate":{"aiMinutes":40,"cost":4,"tokens":40000,"turns":8},"riskFlags":[],"reasoning":"r","effort":"medium","iterationEstimate":30}' ;;
  *) echo 'DIAGNOSIS: the estimator priced one codeline. CORRECTIVE: price every codeline the story spans.' ;;
esac
`);
  chmodSync(runner, 0o755);
  return { d, calls, logs, cfg, prd, runner };
}

function cpa(e: ReturnType<typeof estate>) {
  return spawnSync('bash', [join(SCRIPTS, 'contextualize-stories.sh'), '--phase', 'core', '--apply'], {
    encoding: 'utf8', timeout: 120000,
    env: {
      ...process.env, PRD_FILE: e.prd, CPA_LOG: join(e.logs, 'cpa-review.jsonl'), COST_LOG: join(e.logs, 'phase-cost.jsonl'),
      LOG_DIR: e.logs, EPAM_PROJECT_CONFIG_DIR: e.cfg, KB_ROOT: join(e.cfg, 'kb'), ACTIVITY_FILE: join(e.logs, 'agent-activity.jsonl'),
      AI_RUNNER_CMD: e.runner, ORCH_GATE_PROVIDER: 'stand-in', AI_PROVIDER: 'stand-in', AI_MODEL: 'stand-in', EPAM_MODEL: 'stand-in',
      NODE_CMD: process.execPath, NODE_BIN: process.execPath, PROJECT_ROOT: e.d, EPAM_BROWNFIELD: '1',
      EPAM_STAGE_COVERAGE_BLOCK: '0',
    },
  });
}
const callsBy = (e: ReturnType<typeof estate>, agent: string) => readdirSync(e.calls).filter((f) => f.endsWith(`-${agent}.txt`)).sort();
const story = (e: ReturnType<typeof estate>) => JSON.parse(readFileSync(e.prd, 'utf8')).stories[0];

describe.skipIf(!HAS_PROJECT)('a rejected CPA estimate is healed and retried', () => {
  it('one rejection: the analyst is told why, the estimator is re-asked with the issues, the second estimate stands', () => {
    const e = estate(1); const r = cpa(e); const out = r.stdout + r.stderr;
    const reviews = callsBy(e, 'prd-change-reviewer'); const asks = callsBy(e, 'cpa-inference');
    expect(reviews.length, out).toBe(2);
    expect(asks.length, out).toBe(2);
    // The self-heal analyst ran between the rounds, and was told the reviewer's issue.
    const analystCalls = readdirSync(e.calls).filter((f) => !/prd-change-reviewer|cpa-inference/.test(f));
    expect(analystCalls.length, out).toBeGreaterThan(0);
    expect(readFileSync(join(e.calls, analystCalls[0]), 'utf8')).toContain(ISSUE);
    // The first ask carries no rejection; the retry carries the reviewer's issue.
    expect(readFileSync(join(e.calls, asks[0]), 'utf8')).not.toContain(ISSUE);
    expect(readFileSync(join(e.calls, asks[1]), 'utf8')).toContain(ISSUE);
    // ... one rung up the estimator's own ladder.
    const model = (f: string) => (readFileSync(join(e.calls, f), 'utf8').match(/^MODEL=(.*)$/m) || [])[1];
    expect(model(asks[0]), 'the first ask resolved no model').toBeTruthy();
    expect(model(asks[1]), 'the retry did not climb the ladder').not.toBe(model(asks[0]));
    // The approved retry's estimate is the story's, not the pre-CPA values.
    expect(story(e).estimatedAiMinutes, out).not.toBe(10);
    expect(story(e).cpaGate, out).toBeTruthy();
    // The rejection is on disk with the reviewer's words.
    const rej = JSON.parse(readFileSync(join(e.logs, 'cpa-rejections', 'S-1-round1.json'), 'utf8'));
    expect(rej.issues).toContain(ISSUE);
  });

  it('rejected in every round: the pre-CPA values stand, after the rounds were spent', () => {
    const e = estate(99); const r = cpa(e); const out = r.stdout + r.stderr;
    expect(callsBy(e, 'prd-change-reviewer').length, out).toBe(3);
    expect(callsBy(e, 'cpa-inference').length, out).toBe(3);
    expect(story(e).estimatedAiMinutes, out).toBe(10);
    expect(out).toMatch(/rejected in all 3 rounds/);
    expect(existsSync(join(e.logs, 'cpa-rejections', 'S-1-round3.json'))).toBe(true);
  });

  it('approved first time: no analyst, no retry', () => {
    const e = estate(0); const r = cpa(e); const out = r.stdout + r.stderr;
    expect(callsBy(e, 'prd-change-reviewer').length, out).toBe(1);
    expect(callsBy(e, 'cpa-inference').length, out).toBe(1);
    expect(readdirSync(e.calls).filter((f) => !/prd-change-reviewer|cpa-inference/.test(f))).toEqual([]);
  });
});
