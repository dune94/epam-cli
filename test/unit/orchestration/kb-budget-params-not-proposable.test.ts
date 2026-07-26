/**
 * Self-heal may not set resource budgets. They are not knowledge.
 *
 * FIRST PRINCIPLES, after four failed attempts at refereeing these proposals.
 *
 * There is ALREADY a legitimate, bounded mechanism for budget assignment:
 *
 *     Jira ticket -> synthesize-prd-from-jira.js  (effort defaults to "medium")
 *     CPA pass    -> an LLM estimates estimatedHours
 *     estimate-stories.sh:get_effort_tier()       <=2h low | <=6h medium | >6h high
 *     claude.sh:resolve_effort_settings()         low=6 | medium=10 | high=15 iterations
 *
 * The model expresses a judgement it can actually make — how big is this work —
 * and DETERMINISTIC code owns the numbers. It never picks an integer.
 *
 * Self-heal proposing a raw integer bypasses every step of that: no estimate, no
 * tier, no threshold, no table. Just a model inventing a number from a single
 * observed failure, with no view of the distribution. Live evidence across three
 * runs, every budget rule it ever produced:
 *
 *   EPAM_MAX_ITERATIONS = 14   (after the agent exhausted 15)
 *   EPAM_MAX_ITERATIONS = 1    ("Prevents iterative retries that could lead to
 *                                repeated file writing failures")
 *   EPAM_MAX_ITERATIONS = 14   (again, next run)
 *
 * Three for three harmful. Zero useful. The one REAL budget problem all session —
 * the repro-test-writer needing more than 15 iterations — was fixed by a config
 * change, and the next run produced a valid test on attempt 1.
 *
 * I built four successive guards trying to separate good budget proposals from bad
 * ones. The honest position is that the model cannot make a good one, because it
 * lacks the information the effort pipeline has. So the fix is to remove budgets
 * from the proposable space rather than referee them: a constraint that sets a
 * budget is now UNCONSTRUCTABLE, in the same spirit as prose being unconstructable.
 *
 * Behaviour is still fully expressible — tool_scope narrows reach, gate enables a
 * deterministic check, pre_exec_block forbids a command, response_schema binds
 * output. Those are all "what the agent may DO". A budget is "how much resource it
 * gets", which is capacity planning.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const py = () => {
  const venv = join(LIB, '..', '.venv', 'bin', 'python3');
  try { execFileSync(venv, ['--version']); return venv; } catch { return 'python3'; }
};

function validate(record: unknown) {
  try {
    return JSON.parse(execFileSync(py(), [join(LIB, 'kb_schema.py'), 'validate-constraint'],
      { input: JSON.stringify(record), encoding: 'utf8' }));
  } catch (e: any) {
    return JSON.parse((e.stdout || '{"ok":false,"detail":"crashed"}').trim());
  }
}

const base = {
  id: 'repro-test-writer-class-max-iterations',
  scope: { agent_role: 'repro-test-writer' },
  trigger: { signature: 'class:max_iterations' },
  reason: 'agent exhausted its iteration budget',
};

const BUDGETS = [
  'EPAM_MAX_ITERATIONS', 'STORY_MAX_ITERATIONS',
  'EPAM_MAX_OUTPUT_TOKENS', 'STORY_MAX_OUTPUT_TOKENS',
  'EPAM_STORY_TIMEOUT_SECS', 'EPAM_GATE_TIMEOUT_SECS',
];

describe('budget parameters are not proposable by self-heal', () => {
  for (const name of BUDGETS) {
    it(`rejects a rule that sets ${name}`, () => {
      const r = validate({ ...base, enforcement: { kind: 'param', name, value: '40' } });
      expect(r.ok,
        `${name} is a RESOURCE ALLOCATION owned by the effort pipeline ` +
        `(estimatedHours -> tier -> table), not knowledge self-heal can derive from ` +
        `one failure`).toBe(false);
    });
  }

  it('rejects the exact live rule that starved the agent to one turn', () => {
    const r = validate({ ...base,
      trigger: { signature: 'class:no_file' },
      enforcement: { kind: 'param', name: 'EPAM_MAX_ITERATIONS', value: '1' } });
    expect(r.ok).toBe(false);
  });

  it('STILL ALLOWS a non-budget param — behaviour remains expressible', () => {
    const r = validate({ ...base,
      enforcement: { kind: 'param', name: 'EPAM_REASONING_EFFORT', value: 'high' } });
    expect(r.ok, `a legitimate behavioural param was rejected: ${r.detail}`).toBe(true);
  });

  it('STILL ALLOWS the other enforcement kinds', () => {
    for (const enforcement of [
      { kind: 'gate', check: 'tsc-strict' },
      { kind: 'tool_scope', allowed_write_paths: 'src/foo.ts' },
      { kind: 'pre_exec_block', pattern: 'sudo ' },
    ]) {
      const r = validate({ ...base, enforcement });
      expect(r.ok, `${enforcement.kind} was rejected: ${r.detail}`).toBe(true);
    }
  });
});
