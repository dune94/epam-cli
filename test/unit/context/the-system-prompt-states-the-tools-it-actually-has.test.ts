/**
 * THE SYSTEM PROMPT STATES THE TOOLS THE AGENT ACTUALLY HAS.
 *
 * DEFAULT_SYSTEM_PROMPT told every agent, unconditionally:
 *
 *   "You have access to tools to read files, write files, search code, and execute commands."
 *
 * Most orchestration seams are granted `read-only` — read_file, list_files, search. So a
 * read-only agent was told it could write files and run commands, planned on that basis, and then
 * could not finish. Live 2026-08-23, two independent read-only seams answered with an apology
 * instead of their work:
 *
 *   project-roster-review: "I don't have a `WriteFile` tool available in my current tool set —
 *                           only read_file, list_files, and search are defined. I cannot write
 *                           the file without it."
 *   agent-mint:            "I don't have a WriteFile tool available in my current toolset."
 *
 * Neither prompt asked for a file. project-roster-review's template does not contain the word
 * "write" at all — the instruction came from the system prompt, and the agent believed it.
 *
 * The capability sentence must therefore be DERIVED from the tools actually passed, so a grant and
 * the prompt describing it cannot disagree. This is the same "declared and not delivered" shape as
 * the tool grant, the ladder and the brief block: a value stated in one place and contradicted by
 * what the agent is really given.
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../../src/context/ContextBuilder.js';

const build = (tools?: string[]) => buildSystemPrompt({
  contextFilePath: '/nonexistent/context.md',
  projectRoot: null,
  toolNames: tools,
} as Parameters<typeof buildSystemPrompt>[0]);

describe('the capability sentence follows the grant', () => {
  it('does NOT promise writing or commands to a read-only agent', async () => {
    const p = await build(['read_file', 'list_files', 'search']);
    expect(p, 'a read-only agent is still told it can write files').not.toMatch(/write files/i);
    expect(p, 'a read-only agent is still told it can execute commands')
      .not.toMatch(/execute commands/i);
  });

  it('names the tools it does have, so the agent can plan against them', async () => {
    const p = await build(['read_file', 'list_files', 'search']);
    expect(p).toMatch(/read_file/);
    expect(p).toMatch(/search/);
  });

  it('DOES promise writing when the write tool is granted', async () => {
    // The sentence must not simply lose its teeth — a write-granted seam like roster-specialiser
    // has to know it is expected to produce a file.
    const p = await build(['read_file', 'WriteFile']);
    expect(p).toMatch(/WriteFile/);
  });

  it('falls back to a truthful generic line when the caller passes no tool list', async () => {
    // Callers that never pass tools (chat, repl) must keep working, but must not inherit a
    // promise of capabilities this particular agent may not hold.
    const p = await build(undefined);
    expect(p.length).toBeGreaterThan(0);
    expect(p).toMatch(/EPAM CLI/);
  });

  it('an agent with NO tools is not told it has any', async () => {
    const p = await build([]);
    expect(p, 'a tool-less agent is promised tools it cannot call').not.toMatch(/write files/i);
    expect(p).toMatch(/EPAM CLI/);
  });
});

describe('the system prompt does not tell the agent HOW to respond', () => {
  /**
   * THE REGRESSION THIS SUITE MISSED, AND WHY.
   *
   * Fixing the false-capability defect on 2026-08-23 I replaced the sentence and ADDED a second
   * one: "If a task seems to need a tool that is not in that list, say so in your answer rather
   * than asking for it." Every assertion above tests the text I REMOVED; none covered the text I
   * added, because the red-first test was written to describe the BUG and the new sentence did
   * not exist yet.
   *
   * Live 2026-08-25, AMSD-1919 died at codeline discovery:
   *
   *   No JSON in LLM response: I don't have a WriteFile tool available — my only tools are
   *   read_file, list_files, and search. I cannot write files. Please copy t...
   *
   * The model obeyed me exactly. That instruction reached ALL 39 seams and competes with every
   * one of their output contracts — codeline-discovery's own prompt ends "Respond with ONLY the
   * JSON object. No prose, no markdown fences."
   *
   * THE RULE: response shape belongs to the seam, never to the system prompt. The system prompt
   * may state what tools exist. It may not say what to put in the answer.
   */
  const RESPONSE_SHAPING = [
    /say so in your answer/i,
    /in your (answer|response|reply)/i,
    /respond with/i,
    /answer with/i,
    /rather than asking/i,
    /explain (why|that)/i,
  ];

  const assertNoShaping = (p: string, when: string) => {
    for (const re of RESPONSE_SHAPING) {
      expect(p, `${when}: the system prompt instructs the agent how to answer (${re}). `
        + 'Response shape is each seam\'s contract — 39 of them — and an instruction here '
        + 'overrides all of them. AMSD-1919 died at discovery because the model followed it '
        + 'instead of returning JSON.').not.toMatch(re);
    }
  };

  it('says nothing about the answer for a read-only agent', async () => {
    assertNoShaping(await build(['read_file', 'list_files', 'search']), 'read-only');
  });

  it('says nothing about the answer for a write-granted agent', async () => {
    assertNoShaping(await build(['read_file', 'WriteFile']), 'write-granted');
  });

  it('says nothing about the answer when no tool list is passed', async () => {
    assertNoShaping(await build(undefined), 'no tool list');
  });

  it('says nothing about the answer when the agent has NO tools', async () => {
    // This branch legitimately needs to say where the information comes from, but must still not
    // dictate the shape of what the agent returns.
    assertNoShaping(await build([]), 'no tools');
  });

  it('still states the tools — the fix must not empty the sentence', async () => {
    const p = await build(['read_file', 'search']);
    expect(p).toMatch(/read_file/);
    expect(p).toMatch(/search/);
  });
});
