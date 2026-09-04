/**
 * A LANGFUSE RECORDING OF THIS PROJECT'S OWN RUN IS NOT "ANOTHER PROJECT'S ANSWER".
 *
 * Recording exists so a run can be replayed for nothing. On 2026-09-04 the operator asked the
 * obvious question — "I thought we recorded already, why are there no cassettes, that's the purpose
 * of langfuse" — and they were right: 113 traces of the paid AMSD-1919 run were sitting in Langfuse,
 * 89 of the first 100 carrying real outputs, and mock-expectations rejected every one of them.
 *
 * WHY. Ownership was decided by substring-matching a FILE PATH:
 *
 *     const _project = path.basename(process.env.EPAM_PROJECT_CONFIG_DIR || '');   // "metrolinx"
 *     const _mine = (c) => !!_project && String(c.file || '').includes(_project);
 *
 * That works for a capture read off disk, whose path contains /metrolinx/. A Langfuse capture's
 * `file` is `langfuse:session 20260904T163822Z` or `langfuse:45af80b32f8b` — an id. It can never
 * contain the project name, so EVERY Langfuse recording was reported foreign, always, and the
 * seams that actually blocked the run (roster-specialiser, codeline-discovery, agent-mint,
 * spec-agent) fell back to invented stand-ins. The replay capability could not work by
 * construction.
 *
 * THE RULE THAT DOES WORK, and it is read from the data rather than declared:
 *
 *   A Langfuse trace carries no project name — checked live, its fields are sessionId, tags and
 *   metadata{phase, provider, story_id, ladder_rung}. What it does carry is story_id. A session
 *   containing a trace whose story_id is one of THIS PRD's stories is this project's run, so every
 *   trace in that session is this project's.
 *
 *   Measured on the real data: session 20260904T163822Z holds 97 of 100 traces and 8 of them are
 *   tagged AMSD-1919, which is exactly the story this project's PRD declares. The other sessions
 *   carry STORY-1/STORY-9 and are genuinely foreign — so the rule discriminates, it does not just
 *   accept everything.
 *
 * THE LEAK GUARD STAYS. The original comment is about a real incident: mock3's spec pass was served
 * metrolinx's answer and declared a metrolinx file. Nothing here weakens that — a session whose
 * stories are not this project's is still foreign, and a disk capture is still matched by path.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const MOD = join(__dirname, '../../../orchestrations/scripts/mock-expectations.js');
const { captureIsOwned } = require(MOD);

describe('ownership of a capture', () => {
  it('the predicate is exported — it cannot be tested while it is buried in a loop', () => {
    expect(typeof captureIsOwned,
      'captureIsOwned is not exported from mock-expectations.js').toBe('function');
  });

  const ctx = { project: 'metrolinx', ownedSessions: new Set(['20260904T163822Z']) };

  it('a DISK capture under this project is ours — the original behaviour, unchanged', () => {
    expect(captureIsOwned(
      { file: 'orchestrations/logs/archive/pre-run-x/metrolinx/roster.log' }, ctx)).toBe(true);
  });

  it("a DISK capture from another project is NOT ours — the leak guard still holds", () => {
    // Live 2026-08-27: mock3's spec pass was served metrolinx's answer and declared a metrolinx
    // file that exists in neither mocka nor mockb.
    expect(captureIsOwned(
      { file: 'orchestrations/logs/archive/pre-run-x/mock3/roster.log' }, ctx)).toBe(false);
  });

  it('a LANGFUSE capture from a session that ran THIS project IS ours', () => {
    expect(captureIsOwned(
      { file: 'langfuse:session 20260904T163822Z (40 turns, 0 tool call(s))',
        session: '20260904T163822Z' }, ctx),
    'the recording of this project\'s own paid run was rejected as another project\'s — which is '
    + 'every Langfuse capture, always, because an id never contains the project name')
      .toBe(true);
  });

  it('a LANGFUSE capture from a DIFFERENT run is still foreign', () => {
    expect(captureIsOwned(
      { file: 'langfuse:9f4338bedabc', session: 'some-other-session' }, ctx),
    'the fix must discriminate; accepting every Langfuse capture would re-open the 2026-08-27 leak')
      .toBe(false);
  });

  it('a LANGFUSE capture with no session at all is not assumed ours', () => {
    expect(captureIsOwned({ file: 'langfuse:45af80b32f8b' }, ctx)).toBe(false);
  });

  it('with no project resolved, nothing is claimed — the caller falls back as before', () => {
    expect(captureIsOwned({ file: 'anything' }, { project: '', ownedSessions: new Set() }))
      .toBe(false);
  });

  it('an empty owned-session set never turns a Langfuse capture into ours', () => {
    expect(captureIsOwned(
      { file: 'langfuse:session X', session: 'X' },
      { project: 'metrolinx', ownedSessions: new Set() })).toBe(false);
  });
});

describe('which sessions this project owns is derived from the PRD, never declared', () => {
  const { ownedSessionsFromTraces } = require(MOD);

  it('the deriver is exported', () => {
    expect(typeof ownedSessionsFromTraces).toBe('function');
  });

  /** Traces shaped exactly as the live Langfuse API returns them. */
  const traces = [
    { sessionId: 'RUN-A', metadata: { story_id: 'AMSD-1919' } },
    { sessionId: 'RUN-A', metadata: { story_id: '' } },
    { sessionId: 'RUN-A', metadata: { story_id: 'pipeline' } },
    { sessionId: 'RUN-B', metadata: { story_id: 'STORY-9' } },
    { sessionId: 'RUN-C', metadata: {} },
  ];

  it('a session carrying one of THIS project\'s stories is owned', () => {
    const owned = ownedSessionsFromTraces(traces, ['AMSD-1919']);
    expect([...owned]).toContain('RUN-A');
  });

  it('a session carrying only ANOTHER project\'s stories is not', () => {
    const owned = ownedSessionsFromTraces(traces, ['AMSD-1919']);
    expect([...owned]).not.toContain('RUN-B');
  });

  it('a session that names no story at all is not claimed', () => {
    const owned = ownedSessionsFromTraces(traces, ['AMSD-1919']);
    expect([...owned]).not.toContain('RUN-C');
  });

  it('no stories means no owned sessions — never "everything"', () => {
    expect([...ownedSessionsFromTraces(traces, [])]).toEqual([]);
  });
});
