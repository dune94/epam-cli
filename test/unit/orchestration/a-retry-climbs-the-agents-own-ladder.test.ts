/**
 * A RETRY HAS TO ACTUALLY MOVE THE MODEL.
 *
 * The QA gates and the phase assessment escalated by ASSIGNING ORCH_GATE_MODEL and letting
 * run_orch_prompt pick it up through `${EPAM_MODEL:-${ORCH_GATE_MODEL:-...}}`. When the ladder
 * became the only source of a model, run_orch_prompt stopped reading that variable — so those
 * assignments became inert and every retry silently re-ran the SAME model. A retry that changes
 * nothing is worse than no retry: it spends a second budget to reproduce the first failure, and
 * the log says "escalated".
 *
 * (That regression was introduced by the ladder change itself, and is exactly the class the
 * ladder change was meant to end: a second variable deciding a model behind the seam's back.)
 *
 * What replaces it is still the ladder — ORCH_AGENT_MODEL_CLIMB carries the next rung of THIS
 * agent's own chain, so a base-tier gate and a top-tier gate escalate to different places instead
 * of both jumping to one run-wide "high" model.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestratorSource } from '../../helpers/orchestrator-source';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
// THE PROPERTY IS ABOUT THE SHIPPED CODE, WHICH NOW LIVES IN TWO FILES. run_orch_prompt was
// moved out of the 11,213-line orchestrator into lib/orch-prompt.sh so a test could reach it
// without running the pipeline — but the retry CALL SITES that set the climb stayed behind. A
// test that reads only one of them checks half the path, so both are read.
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const ORCH_PROMPT = join(SCRIPTS, 'lib/orch-prompt.sh');
const NODE = process.execPath;

const src = () => orchestratorSource();
const code = () => src().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** Run a ladder expression with mock3's ladders loaded, as the engine does. */
function ladder(script: string): string {
  const r = spawnSync('bash', ['-c',
    `set -a; . ${JSON.stringify(join(SCRIPTS, 'lib/model-ladders.sh'))}; set +a
     export_model_ladders ${JSON.stringify(join(ROOT, 'orchestrations/projects/mock3/llm-settings.json'))}
     . ${JSON.stringify(join(SCRIPTS, 'lib/seam-ladder.sh'))}
     ${script}`,
  ], { encoding: 'utf8', env: { ...process.env, NODE_BIN: NODE } });
  return `${r.stdout}`.trim();
}

describe('a retry climbs the agent’s own ladder', () => {
  it('the escalation no longer works by assigning a variable nothing reads', () => {
    const body = code();
    const assigns = body.split('\n').filter((l) => /ORCH_GATE_MODEL="\$\{ESCALATION_MODEL_HIGH/.test(l));
    expect(assigns, 'an inert escalation assignment is back — the retry would re-run the same model')
      .toEqual([]);
  });

  it('both retry paths climb, and both name the agent they are climbing for', () => {
    const body = code();
    const climbs = body.split('\n').filter((l) => /ORCH_AGENT_MODEL_CLIMB=\$\(seam_next_model/.test(l));
    expect(climbs.length, 'expected the QA-gate retry and the phase-assessment retry to climb')
      .toBe(2);
    for (const line of climbs) {
      expect(line, `a climb resolves no agent identity: ${line.trim()}`)
        .toMatch(/seam_next_model "\$?[A-Za-z_][\w-]*"/);
    }
  });

  it('run_orch_prompt honours the climb, and only after the seam has resolved', () => {
    // seam_ladder_export overwrites EPAM_MODEL, so a climb read before it would be clobbered.
    const body = src();
    const fn = body.slice(body.indexOf('run_orch_prompt() {'));
    const seamAt = fn.indexOf('seam_ladder_export "$agent_type"');
    const climbAt = fn.indexOf('ORCH_AGENT_MODEL_CLIMB:-');
    expect(seamAt, 'the seam is no longer resolved').toBeGreaterThan(-1);
    expect(climbAt, 'the climb is not honoured at all').toBeGreaterThan(-1);
    expect(climbAt, 'the climb is read before the seam resolves, so it gets overwritten')
      .toBeGreaterThan(seamAt);
  });

  it('the climb is cleared on every path, so it cannot leak to the next agent', () => {
    // A rung left set would silently apply to whatever gate ran next.
    const clears = code().split('\n').filter((l) => /unset ORCH_AGENT_MODEL_CLIMB/.test(l));
    expect(clears.length, 'the climb is not cleared on every return path').toBeGreaterThanOrEqual(4);
  });

  it('a base-tier agent and a top-tier agent climb to different models', () => {
    // The whole point. One shared escalation model is a pin; a ladder differentiates by position.
    const out = ladder(
      'b=$(seam_model_or_fail ac-classification); t=$(seam_model_or_fail story-writer);'
      + ' echo "$(seam_next_model ac-classification "$b") $(seam_next_model story-writer "$t")"');
    const [base, top] = out.split(/\s+/);
    expect(base, `no climb resolved for the base tier: ${out}`).toBeTruthy();
    expect(top, `no climb resolved for the top tier: ${out}`).toBeTruthy();
    expect(base, 'both tiers escalate to the same model — that is a shared pin, not a ladder')
      .not.toBe(top);
  });

  it('the climb actually moves off the starting model', () => {
    const out = ladder('m=$(seam_model_or_fail story-writer); echo "$m $(seam_next_model story-writer "$m")"');
    const [start, next] = out.split(/\s+/);
    expect(next, `the retry would re-run the same model: ${out}`).not.toBe(start);
  });
});

describe('the phase assessment refuses to judge evidence it never gathered', () => {
  it('a failed precompute stops the step instead of handing the assessor {}', () => {
    // The precompute exists so the agent does not explore for the numbers. If it fails and the
    // agent is handed '{}', the agent still answers — fluently, about nothing — and its output
    // feeds a PRD mutation.
    const body = src();
    const i = body.indexOf('assess-precompute.py');
    expect(i, 'the precompute is gone').toBeGreaterThan(-1);
    const block = body.slice(i - 300, i + 800);
    expect(block, 'the precompute’s exit status is still ignored').toMatch(/if ! python3/);
    expect(block, 'an empty summary is still passed to the assessor').toMatch(/= "\{\}"/);
  });

  it('neither prompt reaches the assessor unrendered', () => {
    const body = src();
    const i = body.indexOf('render_engine_prompt skill-assessment-postphase');
    expect(i, 'the assessment prompt is no longer rendered here').toBeGreaterThan(-1);
    expect(body.slice(i - 300, i + 400), 'a failed render still reaches the assessor as an empty prompt')
      .toMatch(/if ! assessment_prompt=/);
  });
});
