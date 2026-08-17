/**
 * A CORRECTION CYCLE THAT REMOVES EVERY AGENT AND MINTS NONE HAS NOT CORRECTED ANYTHING.
 *
 * The roster review indicts agents; clearProjectRoster removes them; the re-mint is expected to
 * replace them. Nothing checked that it did.
 *
 * Live 2026-08-17, mock3:
 *
 *   cycle 1: 2 blocking finding(s) — 2 agent(s) indicted, 2 retained
 *     − fare-logic-engineer (indicted, being replaced)
 *     − schedule-rendering-engineer (indicted, being replaced)
 *   roster review (cycle 2): sound — 0 finding(s), 0 blocking
 *   FAILED: [assign] no project implementation roles are registered for this project
 *
 * Cycle 2 returned "sound" because BOTH implementers were gone. It reviewed an empty set and
 * correctly found nothing wrong with it. "Being replaced" replaced nothing, and the run died
 * several steps later at role assignment — pointing the operator at the assignment step rather
 * than at the cycle that emptied the roster.
 *
 * This is the same shape as the Step 3.55 vacuous pass and Step 3.58's empty intersection: a check
 * that reports success because it had nothing to examine. The fix is the same in all three —
 * distinguish "nothing to find" from "nothing to look at".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const MINT = join(ROOT, 'orchestrations/scripts/mint-agents-step.js');

const src = () => readFileSync(MINT, 'utf8');
const code = () => src().split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

describe('a correction cycle that mints nothing fails', () => {
  it('the emptied-roster case is detected at the cycle, not left to a later step', () => {
    const body = code();
    const i = body.indexOf('cleared.length && !remint.minted.length');
    expect(i, 'nothing checks whether the replacement produced anything').toBeGreaterThan(-1);
  });

  it('it fails rather than continuing to the next review', () => {
    // Continuing is what produced "sound — 0 findings" on an empty roster.
    const body = src();
    const i = body.indexOf('cleared.length && !remint.minted.length');
    const block = body.slice(i, i + 1600);
    expect(block, 'the cycle still continues after replacing nothing').toMatch(/process\.exit\(1\)/);
  });

  it('the failure names the agents that were removed', () => {
    // "no implementation roles are registered" several steps later does not tell the operator
    // WHICH agents vanished or WHY, and points at the wrong step.
    const body = src();
    const i = body.indexOf('cleared.length && !remint.minted.length');
    const block = body.slice(i, i + 1600);
    expect(block, 'the removed agents are not named').toMatch(/cleared\.join/);
    expect(block, 'the operator is not told where the blocking findings are')
      .toMatch(/roster-review\.json/);
  });

  it('it records a verdict distinguishable from a real review outcome', () => {
    // roster-review.json is what a later step or a human reads. Leaving the previous verdict in
    // place would say "defects_found" for a run that actually died of an empty replacement.
    const body = src();
    const i = body.indexOf('cleared.length && !remint.minted.length');
    expect(body.slice(i, i + 1600), 'the recorded verdict does not distinguish this case')
      .toMatch(/replacement_produced_nothing/);
  });

  it('a cycle that DOES replace its indicted agents still proceeds', () => {
    // The guard must not fire on the normal path — a correction that works is the common case.
    // The condition requires BOTH that agents were cleared AND that nothing was minted.
    const body = code();
    const i = body.indexOf('cleared.length && !remint.minted.length');
    const cond = body.slice(i, body.indexOf(')', i));
    expect(cond, 'the guard fires whenever anything was cleared, blocking normal corrections')
      .toContain('!remint.minted.length');
  });

  it('a cycle that indicted nobody is untouched', () => {
    // cleared.length === 0 means no agent was indicted; there is nothing to replace and the
    // absence of new agents is correct, not a failure.
    const body = code();
    const i = body.indexOf('cleared.length && !remint.minted.length');
    expect(body.slice(i - 5, i + 40), 'the guard fires when no agent was indicted at all')
      .toMatch(/cleared\.length &&/);
  });
});
