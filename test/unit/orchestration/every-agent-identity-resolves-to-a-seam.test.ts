/**
 * AN AGENT THAT NAMES ITSELF SOMETHING THE REGISTRY DOES NOT KNOW HAS NO SEAM, AND A SEAM IS
 * WHERE ITS LADDER, ITS BUDGET AND ITS TOOL GRANT COME FROM.
 *
 * Every model call carries an identity in EPAM_AGENT_NAME. That identity is what resolveSeam maps
 * to a seam, and the seam is what declares `ladder`, `reasoningEffort`, `maxOutputTokens`,
 * `timeoutSecs` and `allowedTools`. An identity that resolves to nothing gets none of it — the
 * call still happens, on whatever ambient model the environment carried, and nothing says so.
 *
 * Found live: the AC gate names itself 'ac-gate' and 'ac-gate-codeline'. The registry declares
 * 'ac-classification' (ladder=base, effort=low) and 'ac-elaboration' (ladder=top, effort=medium)
 * for exactly this stage — profiles written for a step, addressed by no caller, while the caller
 * announced two names nothing knows. The gate's model came from a hardcoded fallback literal
 * instead, which is the shape the ladder work removed everywhere else with the rule that a seam
 * with no resolvable model must decline rather than guess.
 *
 * The check is on IDENTITIES DECLARED IN SHIPPED CODE, so it catches the next one at the moment
 * it is written rather than at the first run that quietly under-powers an agent.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

/** Every literal EPAM_AGENT_NAME in shipped pipeline code. */
function declaredIdentities(): string[] {
  const raw = execSync(
    // QUOTED VALUES ONLY. An unquoted one is a VARIABLE — `EPAM_AGENT_NAME: seam` resolves at
    // runtime to whatever that holds, and reading the identifier as an identity reported a seam
    // literally named 'seam'. A scan that cannot see the value must not invent one.
    `grep -rhoE "EPAM_AGENT_NAME[:=] *['\\"][a-z0-9:._-]+" ${JSON.stringify(SCRIPTS)} 2>/dev/null || true`,
    { encoding: 'utf8' },
  );
  return [...new Set(
    raw.split('\n')
      .map((l) => l.replace(/.*[:=] *['"]?/, '').trim())
      // A variable reference is not a literal identity — those are resolved at runtime from
      // values this scan cannot see, and asserting on the text `process.env.` proves nothing.
      .filter((x) => x && /^[a-z]/.test(x) && !x.startsWith('process.') && !x.startsWith('$')),
  )].sort();
}

const resolveSeam = () => require(join(SCRIPTS, 'lib/seam-invocation.js')).resolveSeam;

/**
 * Identities with no seam YET, each with the reason. An entry is a debt, not an exemption: it says
 * this agent runs with no ladder and no budget, and names the step where that has to be settled.
 *
 * Empty is the goal. Adding one is a decision; leaving one undocumented is the state this ends.
 */
const NO_SEAM_YET: Record<string, string> = {
  'estate-surveyor':
    'Runs in the spec pass (step 3.01), which has not been assessed yet. Its seam and ladder are '
    + 'settled when that step is, rather than guessed at from here.',
  'kb-synthesizer':
    'Synthesises knowledge-base entries after a story completes. Not reached in steps 0.1-1.4 and '
    + 'its seam is decided with the step that invokes it.',
};

/** Files that call a model without a seam env, each with the reason it is not yet wired. */
const UNWIRED_YET: Record<string, string> = {
  'orchestrations/scripts/lib/cpa-inference.js':
    'The CPA pre-pass is step 3.02. Wiring its seam belongs with assessing that step.',
  'orchestrations/scripts/lib/kb-synthesizer.js':
    'Same agent as above — no seam yet, so there is none to apply.',
  'orchestrations/scripts/detective-rerun-step.js':
    'Resolves its executor through spec.resolvePromptExec, which is the runClaude path. Whether '
    + 'that path carries the seam env is a question for the spec-pass step, not an answer to '
    + 'invent here.',
};

describe('every agent identity resolves to a seam', () => {
  it('finds identities to check — not passing on an empty scan', () => {
    expect(declaredIdentities().length, 'no agent identity found anywhere').toBeGreaterThan(3);
  });

  it('every declared identity maps to a seam the registry knows', () => {
    const resolve = resolveSeam();
    const orphans: string[] = [];
    for (const id of declaredIdentities()) {
      if (NO_SEAM_YET[id]) continue;
      try { resolve(id, REGISTRY); } catch { orphans.push(id); }
    }
    expect(orphans,
      `${orphans.length} agent identit(y|ies) resolve to no seam, so they run with no ladder, no `
      + `budget and no tool grant — and nothing reports it:\n  ${orphans.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the seam each one resolves to declares a ladder position', () => {
    // Resolving is not enough. A seam with no `ladder` gives the call no escalation chain, which
    // is the same silence one step further in.
    const resolve = resolveSeam();
    const registry = JSON.parse(require('fs').readFileSync(REGISTRY, 'utf8'));
    const noLadder: string[] = [];
    for (const id of declaredIdentities()) {
      let seam: string;
      try { seam = resolve(id, REGISTRY); } catch { continue; }   // covered by the test above
      const profile = (registry.profiles || {})[seam] || {};
      if (!profile.ladder) noLadder.push(`${id} -> seam '${seam}'`);
    }
    expect(noLadder,
      `a seam declares no ladder position, so the agent cannot escalate:\n  ${noLadder.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every file that calls a model applies the seam environment', () => {
    // The other half. An identity that resolves is worthless if the invocation never asks the
    // registry what that seam grants — which is exactly how the AC gate ran on a fallback literal
    // while two profiles sat unread.
    const raw = execSync(
      `grep -rl "ai-run.sh" ${JSON.stringify(SCRIPTS)} --include=*.js 2>/dev/null || true`,
      { encoding: 'utf8' },
    );
    const callers = raw.split('\n').filter(Boolean)
      .filter((f) => !f.endsWith('seam-invocation.js'))
      // MENTIONS ARE NOT CALLS. Three files name ai-run.sh only in a comment explaining what it
      // does; counting those reported callers that call nothing, which is a guard crying wolf.
      .filter((f) => require('fs').readFileSync(f, 'utf8').split('\n')
        .some((l) => /ai-run\.sh/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l)));

    const unwired = callers.filter((f) => {
      const src = require('fs').readFileSync(f, 'utf8');
      return !/seamInvocationEnv/.test(src);
    }).map((f) => f.replace(`${ROOT}/`, '')).filter((f) => !UNWIRED_YET[f]);

    expect(unwired,
      `${unwired.length} file(s) call a model without asking the registry what their seam grants:\n`
      + `  ${unwired.join('\n  ')}`,
    ).toEqual([]);
  });
});
