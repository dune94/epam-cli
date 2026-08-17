/**
 * EVERY AGENT THE ENGINE INVOKES BY ITS OWN LABEL MUST GET ITS DECLARED SEAM.
 *
 * run_orch_prompt applies a seam via seam_ladder_export, which required the label to be a direct
 * key of `profiles`. It never consulted `agentSeams` — the registry's other, equally explicit,
 * per-agent declaration. So skills_audit, tools_audit, story_recovery, lint-fixer and
 * team-lead-agent got nothing: no ladder, no reasoning effort, no output-token budget, no tool
 * grant. Three of those hold Bash and WriteFile and rewrite engine state — skills_audit rewrites
 * profiles.json itself.
 *
 * It was invisible because resolveSeam DOES throw for an unregistered agent — that is its whole
 * design, "never {}, and never a guess" — and the call site ran it under `2>/dev/null || true`.
 * The registry's refusal to guess was being discarded by the one caller that needed to hear it.
 *
 * The distinction the fix preserves: agentSeams is exact and deliberate, one entry per agent.
 * seamPatterns/defaultSeam are a fallback, and applying those blindly is what gave seven agents
 * the wrong configuration on 2026-08-15. Exact declarations count; guesses still do not.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const LADDER = join(SCRIPTS, 'lib/seam-ladder.sh');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const NODE = process.execPath;

/** Run seam_ladder_export exactly as run_orch_prompt does, and report what it exported. */
function exportFor(agent: string): { rc: number; effort: string; tokens: string } {
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LADDER)}
     seam_ladder_export ${JSON.stringify(agent)}; rc=$?
     echo "rc=$rc effort=\${EPAM_REASONING_EFFORT:-NONE} tokens=\${EPAM_MAX_OUTPUT_TOKENS:-NONE}"`,
  ], {
    encoding: 'utf8',
    env: { ...process.env, NODE_BIN: NODE, EPAM_MODEL_LADDER_TIER_ORDER: 'base,mid,top' },
  });
  const line = r.stdout.trim().split('\n').pop() || '';
  const m = /rc=(\d+) effort=(\S+) tokens=(\S+)/.exec(line);
  expect(m, `seam_ladder_export produced no readable result for ${agent}: ${r.stdout}${r.stderr}`).toBeTruthy();
  return { rc: Number(m![1]), effort: m![2], tokens: m![3] };
}

/** Every label the engine passes to run_orch_prompt / run_orch_prompt_with_tools. */
function engineLabels(): string[] {
  const src = [ORCH, join(SCRIPTS, 'claude.sh')]
    .map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  const found = new Set<string>();
  for (const m of src.matchAll(/run_orch_prompt(?:_with_tools)? "[^"]*" "([a-z0-9_:-]+)"/g)) found.add(m[1]);
  for (const m of src.matchAll(/_run_qa_gate_with_retry "[^"]*" "([a-z0-9_:-]+)"/g)) found.add(m[1]);
  return [...found];
}

describe('an engine agent runs with its declared seam', () => {
  const labels = engineLabels();

  it('finds the call sites — it is not matching nothing', () => {
    expect(labels.length, 'no engine agent label was found at all').toBeGreaterThan(8);
  });

  it('every label the engine invokes is declared in the registry', () => {
    const undeclared = labels.filter((a) => exportFor(a).rc === 3);
    expect(undeclared,
      `${undeclared.length} agent(s) run with no ladder, no effort and no tool grant. `
      + 'Add each to profiles or agentSeams in invocation-profiles.json:',
    ).toEqual([]);
  });

  it('a declared agent actually receives its settings, not merely a resolution', () => {
    // Resolving is not applying. This asserts the environment the agent will really run under.
    for (const agent of ['skills_audit', 'tools_audit', 'story_recovery', 'lint-fixer']) {
      const got = exportFor(agent);
      expect(got.rc, `${agent} is not declared`).toBe(0);
      expect(got.effort, `${agent} received no reasoning effort`).not.toBe('NONE');
      expect(got.tokens, `${agent} received no output-token budget`).not.toBe('NONE');
    }
  });

  it('an agentSeams entry is honoured, not only a profiles key', () => {
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    const viaAgentSeams = Object.keys(reg.agentSeams || {}).filter((a) => !(reg.profiles || {})[a]);
    expect(viaAgentSeams.length, 'no agent is declared via agentSeams alone — the test proves nothing')
      .toBeGreaterThan(0);
    expect(exportFor(viaAgentSeams[0]).rc,
      `${viaAgentSeams[0]} is declared in agentSeams but seam_ladder_export ignored it`,
    ).toBe(0);
  });

  it('an agent the registry does not know is still refused, not guessed at', () => {
    // The guard this must not weaken: seamPatterns/defaultSeam would happily supply SOMETHING.
    // Wrong configuration presented as resolved configuration is worse than none.
    const got = exportFor('definitely-not-a-real-agent');
    expect(got.rc, 'an unknown agent was silently given a seam').toBe(3);
    expect(got.effort).toBe('NONE');
  });

  it('the caller reports an unconfigured agent instead of discarding the reason', () => {
    const body = readFileSync(ORCH, 'utf8');
    const i = body.indexOf('seam_ladder_export "$agent_type"');
    expect(i, 'the seam is no longer applied at the gate call site').toBeGreaterThan(-1);
    const block = body.slice(i - 200, i + 400);
    expect(block, 'the registry’s refusal is silenced again').not.toMatch(/seam_ladder_export "\$agent_type" 2>\/dev\/null \|\| true/);
    expect(block, 'an unconfigured agent produces no message').toMatch(/warning|no seam configured/i);
  });
});
