/**
 * A TOOL GRANT REACHES THE AGENT THAT WAS GRANTED IT.
 *
 * The convention — a grant travels as EPAM_ALLOWED_TOOLS plus the AI_GATE_ALLOW_TOOLS flag that
 * permits tools at all — was written out by hand at four call sites, and the fourth got it wrong
 * in the way a duplicated convention eventually does: the grant was passed as a POSITIONAL
 * argument, into the slot holding the story id. The roster reviewer therefore ran with no tools,
 * could not open the roster it was asked to judge, and reported that it had nothing to review.
 *
 * A gate structurally unable to examine the thing it gates is the failure this suite exists to
 * catch, and it is invisible to a test that only checks the gate was called.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const RUNNER = join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withToolGrant } = require(RUNNER);

describe('a grant travels as env, and travels whole', () => {
  it('carries BOTH the list and the flag that permits tools at all', () => {
    // Either alone is useless: the list without the flag is a permission the runner never turns
    // on, and the flag without the list is tools enabled with nothing allowed.
    const env = withToolGrant({ EPAM_AGENT_NAME: 'x' }, 'read_file,search');
    expect(env.EPAM_ALLOWED_TOOLS).toBe('read_file,search');
    expect(env.AI_GATE_ALLOW_TOOLS).toBe('1');
  });

  it('leaves an absent grant absent — it does not invent an empty allow-list', () => {
    // An empty allow-list is not "no grant": it reads as tools ON and nothing permitted, which
    // fails differently and later than simply having no grant.
    for (const nothing of ['', undefined, null]) {
      const env = withToolGrant({ EPAM_AGENT_NAME: 'x' }, nothing as unknown as string);
      expect(env.EPAM_ALLOWED_TOOLS, `a grant appeared from ${String(nothing)}`).toBeUndefined();
      expect(env.AI_GATE_ALLOW_TOOLS).toBeUndefined();
    }
  });

  it('does not disturb what the seam already declared', () => {
    const env = withToolGrant(
      { EPAM_AGENT_NAME: 'roster-review', EPAM_MAX_ITERATIONS: '12' }, 'read_file');
    expect(env.EPAM_AGENT_NAME).toBe('roster-review');
    expect(env.EPAM_MAX_ITERATIONS).toBe('12');
  });
});

describe('the story id is a story, not a tool list', () => {
  it('a grant is never what identifies the work', () => {
    // The defect this pins: the grant was handed to the storyId parameter, so cost was attributed
    // to a "story" named after an allow-list and the trace was labelled with one. Any value that
    // looks like a grant in that position is a bug, whatever else is true.
    const grant = 'read_file,list_files,search,codegraph_query,scan_secrets';
    const env = withToolGrant({}, grant);
    // The grant lives HERE...
    expect(env.EPAM_ALLOWED_TOOLS).toBe(grant);
    // ...and the identity of the work is not derived from it.
    expect(env.EPAM_STORY_ID).toBeUndefined();
  });
});
