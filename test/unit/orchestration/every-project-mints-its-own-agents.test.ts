/**
 * THE ROSTER IS MINTED FOR EVERY PROJECT, NOT ONLY FOR ONE THAT INGESTS FROM A TRACKER.
 *
 * The mint is what gives a project its own agents: it proposes the roster, reviews it, assigns
 * every story a role, provisions this project's prompts and links them to the agents it minted.
 * Without it a run uses the canonical base roster — epam-cli's own first-commit agents — which is
 * the exact failure the mint was built to end: "a client codeline ran with epam-cli's OWN
 * first-commit agents".
 *
 * It was invoked from exactly one place, inside `_run_jira_pipeline`. A project whose PRD is
 * authored never reaches it, so it silently runs unminted: no project roster, no role assignment,
 * no project prompt library, and no prompt-agent-link. For a project that declares
 * EPAM_PROMPT_PROVISION_MODE=generate, the entire provisioning path goes unexercised.
 *
 * Same shape as codeline discovery, which was also reachable only from the Jira branch. The rule
 * is the same and names no project: a capability every project needs cannot live behind the
 * branch that only some projects take.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

const lines = () => readFileSync(ORCH, 'utf8').split('\n');

/** The line range of a shell function, by name. */
function functionRange(name: string): { start: number; end: number } | null {
  const src = lines();
  const start = src.findIndex((l) => new RegExp(`^${name}\\(\\) *\\{`).test(l));
  if (start < 0) return null;
  for (let i = start + 1; i < src.length; i += 1) {
    if (/^\}/.test(src[i])) return { start: start + 1, end: i + 1 };
  }
  return null;
}

describe('every project mints its own agents', () => {
  it('the mint is invoked somewhere', () => {
    const hits = lines()
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) => /mint-agents-step\.js/.test(l) && !/^\s*#/.test(l));
    expect(hits.length, 'nothing invokes the mint at all').toBeGreaterThan(0);
  });

  it('is reachable on a path that does not require JIRA_PIPELINE=1', () => {
    const jira = functionRange('_run_jira_pipeline');
    expect(jira, '_run_jira_pipeline was not found — this test is measuring nothing').toBeTruthy();

    const callSites = lines()
      .map((l, i) => ({ l, line: i + 1 }))
      // THE CALL, not the definition. Checking where mint-agents-step.js is NAMED passes as
      // soon as the helper is defined outside the Jira function — whether or not anything on the
      // other path invokes it. The mutation proved that: removing the canonical call left this
      // green. What matters is an INVOCATION reachable without JIRA_PIPELINE=1.
      .filter(({ l }) => /_run_agent_mint / .test(l) && !/^\s*#/.test(l) && !/^_run_agent_mint\(\)/.test(l))
      .map(({ line }) => line);

    const outside = callSites.filter((n) => n < jira!.start || n > jira!.end);
    expect(outside.length,
      `every mint call site (${callSites.join(', ')}) is inside _run_jira_pipeline `
      + `(lines ${jira!.start}-${jira!.end}). A project with an authored PRD never mints, so it runs `
      + 'on the canonical base roster with no project prompts and no role assignment.',
    ).toBeGreaterThan(0);
  });

  it('the canonical path checks the mint exit status rather than a pipeline status', () => {
    // The mint is piped to tee for the run log. Without pipefail the pipeline status is tee's,
    // which is why the Jira call site tests PIPESTATUS[0] explicitly. Any second call site has to
    // do the same or a failed mint reads as a success.
    const src = readFileSync(ORCH, 'utf8');
    const callCount = (src.match(/"\$SCRIPT_DIR\/mint-agents-step\.js"/g) || []).length;
    const guardCount = (src.match(/PIPESTATUS\[0\]/g) || []).length;
    expect(guardCount,
      `${callCount} mint call site(s) but only ${guardCount} PIPESTATUS guard(s) in the file`,
    ).toBeGreaterThanOrEqual(callCount);
  });
});
