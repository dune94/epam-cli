/**
 * THE ASSIGNMENT PROMPT CONTRADICTED ITSELF, AND THE MODEL OBEYED THE ABSOLUTE HALF.
 *
 * Live 2026-08-09, AMSD-2041 across three codelines. The prompt said both of these:
 *
 *     STORIES — a story listing more than one codeline needs ONE ASSIGNMENT PER CODELINE:
 *       codelines (assign one role for EACH): gotransit, upexpress, metrolinx
 *     ...
 *     Every story must be assigned exactly one role.
 *
 * The first needs three assignments; the second needs one. The model emitted exactly one, for
 * gotransit, and the run aborted: "[assign] unassigned after the agent's full retry/ladder
 * budget: AMSD-2041 @ upexpress, AMSD-2041 @ metrolinx". Its full retry and ladder budget was
 * spent re-answering a question that could not be answered consistently — every rung produced
 * an answer obeying one sentence and violating the other.
 *
 * The sentence predates multi-codeline stories. The unit of assignment is a (story, codeline)
 * PAIR — which is exactly what the coverage check downstream requires, keyed on
 * `storyId \0 codeline`. The prompt now says so, and states the count the story needs, so the
 * requirement is checkable by the model before it answers rather than only by the gate after.
 *
 * No codeline or client name appears here: the fixture supplies its own.
 */
import { describe, it, expect } from 'vitest';

const { buildAssignmentPrompt } = require('../../../orchestrations/scripts/spec-mode-runner.js');

const ROLES = [
  { name: 'alpha-engineer', brief: 'Owns the service layer.' },
  { name: 'beta-engineer', brief: 'Owns the component layer.' },
];
const SPANNING = [{ id: 'S-1', title: 'spanning story', description: 'do the thing', codelines: ['one', 'two', 'three'] }];
const SOLO = [{ id: 'S-2', title: 'single story', description: 'do the thing', codelines: ['one'] }];

describe('the fixture is real', () => {
  it('the spanning story genuinely spans, and the solo one does not', () => {
    expect(SPANNING[0].codelines.length).toBe(3);
    expect(SOLO[0].codelines.length).toBe(1);
  });

  it('the prompt renders and is not empty', () => {
    expect(buildAssignmentPrompt(SPANNING, ROLES).length).toBeGreaterThan(200);
  });
});

describe('THE DEFECT: no instruction demands exactly one assignment per STORY', () => {
  it('the contradictory sentence is gone', () => {
    const p = buildAssignmentPrompt(SPANNING, ROLES);
    expect(
      p,
      'the prompt still tells the model a story gets exactly one role, which is false for a ' +
      'story spanning codelines and is what left two lanes unassigned',
    ).not.toMatch(/every story must be assigned exactly one role/i);
  });

  it('the unit of assignment is stated as the pair', () => {
    const p = buildAssignmentPrompt(SPANNING, ROLES).toLowerCase();
    expect(p).toMatch(/per codeline|each codeline|story.{0,20}codeline pair/);
  });

  it('the required number of assignments is stated for a spanning story', () => {
    // The model can check its own answer before returning it, instead of the gate catching it after.
    expect(buildAssignmentPrompt(SPANNING, ROLES)).toMatch(/\b3\b/);
  });

  it('every codeline is named, so none can be silently skipped', () => {
    const p = buildAssignmentPrompt(SPANNING, ROLES);
    for (const cl of SPANNING[0].codelines) expect(p).toContain(cl);
  });
});

describe('a single-codeline story is unaffected', () => {
  it('it still asks for one assignment', () => {
    const p = buildAssignmentPrompt(SOLO, ROLES);
    expect(p).toContain('S-2');
    expect(p).not.toMatch(/every story must be assigned exactly one role/i);
  });

  it('a story with no codelines at all does not break the prompt', () => {
    const p = buildAssignmentPrompt([{ id: 'S-3', title: 't', description: 'd' }], ROLES);
    expect(p).toContain('S-3');
  });
});

describe('the roles are offered verbatim and completely', () => {
  it('every available role appears', () => {
    const p = buildAssignmentPrompt(SPANNING, ROLES);
    for (const r of ROLES) expect(p).toContain(r.name);
  });

  it('the code-authorship requirement is preserved', () => {
    // A role that owns no source files cannot deliver a story; that rule was learned live.
    expect(buildAssignmentPrompt(SPANNING, ROLES)).toMatch(/EDIT THE FILES|author the code/i);
  });
});

describe('more than one role may be needed in one codeline', () => {
  it('the prompt does not forbid the model from saying so', () => {
    // Two implementers were minted for this story — SDK wiring and React subscriptions — and a
    // rule of "one role, full stop" makes a correct answer unavailable.
    const p = buildAssignmentPrompt(SPANNING, ROLES).toLowerCase();
    expect(p).not.toMatch(/only one role|a single role for the (whole|entire) story/);
  });
});
