/**
 * DECLARING A SEAM IS NOT APPLYING IT.
 *
 * An agent identity resolving to a seam only means the registry HAS an answer. The answer reaches
 * the call solely through seamInvocationEnv, which is what turns `ladder`, `reasoningEffort`,
 * `maxOutputTokens`, `timeoutSecs` and `allowedTools` into environment the model call actually
 * runs under.
 *
 * Three of the mint's five agents resolved correctly and never asked: estate-survey, agent-mint and
 * role-assigner. Their profiles sat in the registry reaching nothing, and every earlier check —
 * "does the identity resolve", "does the seam declare a ladder" — passed while the ladder was
 * inert. roster-review and prompt-builder did ask, which is what made the gap invisible: the stage
 * looked wired because part of it was.
 *
 * This is the other half of every-agent-identity-resolves-to-a-seam: that one asks whether an
 * answer exists, this one asks whether anybody reads it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');

/** The agents the mint stage runs, and the file that builds each one's environment. */
const MINT_AGENTS: Array<{ seam: string; file: string }> = [
  { seam: 'estate-survey', file: 'spec-mode-runner.js' },
  { seam: 'agent-mint', file: 'spec-mode-runner.js' },
  { seam: 'role-assigner', file: 'spec-mode-runner.js' },
  { seam: 'roster-review', file: 'spec-mode-runner.js' },
  { seam: 'prompt-builder', file: 'mint-agents-step.js' },
];

const sourceOf = (f: string) => readFileSync(join(SCRIPTS, f), 'utf8');

describe('a declared seam is actually asked', () => {
  it('every mint agent has its seam applied at the invocation', () => {
    const unasked: string[] = [];
    for (const { seam, file } of MINT_AGENTS) {
      const src = sourceOf(file)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))     // a comment naming it is not a call
        .join('\n');
      if (!src.includes(`seamInvocationEnv('${seam}'`)) unasked.push(`${seam} (${file})`);
    }
    expect(unasked,
      `${unasked.length} agent(s) resolve to a seam that nothing asks for, so their ladder, effort `
      + `and budget reach nothing:\n  ${unasked.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the seam a call asks for is the identity it announces', () => {
    // Asking for one seam while announcing another is how roster-reviewer once ran on the code
    // reviewer's configuration: cost, self-heal and the KB are keyed on the identity, the ladder on
    // the seam, and the two silently describing different agents is worse than neither working.
    const mismatched: string[] = [];
    for (const { seam, file } of MINT_AGENTS) {
      const src = sourceOf(file);
      const i = src.indexOf(`seamInvocationEnv('${seam}'`);
      if (i < 0) continue;                                 // covered by the test above
      // Same object literal or the lines immediately around it. Wide enough that a comment
      // between the two does not read as a mismatch — the first version of this check was 400
      // characters and failed on a call site whose only fault was being well explained.
      const window = src.slice(Math.max(0, i - 900), i + 900);
      const declaresIt = window.includes(`EPAM_AGENT_NAME: '${seam}'`)
        || window.includes(`EPAM_AGENT_NAME = '${seam}'`);
      if (!declaresIt) {
        mismatched.push(`${seam} (${file}) asks for its seam but does not announce it`);
      }
    }
    expect(mismatched, mismatched.join('\n  ')).toEqual([]);
  });

  it('finds the call sites — it is not matching nothing', () => {
    const total = MINT_AGENTS.filter(({ seam, file }) => sourceOf(file).includes(`seamInvocationEnv('${seam}'`)).length;
    expect(total, 'no mint agent applies a seam at all — the scan is looking in the wrong place')
      .toBe(MINT_AGENTS.length);
  });
});
