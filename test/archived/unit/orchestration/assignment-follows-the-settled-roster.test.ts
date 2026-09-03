/**
 * A STORY IS ASSIGNED TO A ROLE THAT EXISTS.
 *
 * Assignment derives from the roster, so it must run once the roster is SETTLED — after the
 * review/correction loop, not before it.
 *
 * Live 2026-08-08: assignment ran before the loop. All three lanes were assigned
 * 'contentstack-live-preview-engineer'; the reviewer then indicted it and the correction
 * replaced it with 'contentstack-live-preview-integration-engineer'. The assignments were
 * never revisited, so every lane pointed at a role with no profile — an agent with an empty
 * system prompt that the write perimeter would refuse, because the name is not in
 * project-roles.json. That is precisely the "proposed, briefed, wired, assigned a story — and
 * then unable to write a byte" failure the perimeter exists to prevent.
 *
 * ARCH-7's targeted correction is what made this reachable. A wholesale re-mint would have
 * failed loudly; a surgical replacement leaves the roster looking healthy and only the
 * assignments stale, which is quieter and worse.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const STEP = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/mint-agents-step.js'), 'utf8');

describe('assignment happens after the roster is settled', () => {
  it('the role-assigner runs after the correction loop, not before it', () => {
    const loop = STEP.indexOf('while (_mintedDetail.length && cycle <= maxCycles)');
    const assign = STEP.indexOf("EPAM_AGENT_NAME = 'role-assigner'");
    expect(loop, 'the correction loop is gone').toBeGreaterThan(-1);
    expect(assign, 'the role-assigner is gone').toBeGreaterThan(-1);
    expect(
      assign,
      'stories are assigned from the PROPOSED roster and never revisited after correction',
    ).toBeGreaterThan(loop);
  });

  it('role-assignments.json is written after the loop too', () => {
    const loop = STEP.indexOf('while (_mintedDetail.length && cycle <= maxCycles)');
    expect(STEP.indexOf("'role-assignments.json'")).toBeGreaterThan(loop);
  });
});

describe('an assignment naming a nonexistent role fails the step', () => {
  it('the settled roster is checked against every assignment', () => {
    // Ordering alone is not proof: a later change could reorder again. This check is the
    // guarantee, and it is mechanical rather than a matter of sequence.
    const check = STEP.slice(STEP.indexOf('_orphaned'), STEP.indexOf('_orphaned') + 900);
    expect(check).toMatch(/_finalRoles/);
    expect(check).toMatch(/throw new Error/);
  });

  it('the failure names the offending assignments, not just a count', () => {
    const check = STEP.slice(STEP.indexOf('_orphaned'), STEP.indexOf('_orphaned') + 900);
    expect(check).toMatch(/_orphaned\.join/);
  });

  it('the roster it checks against is read from disk, not from the pre-correction list', () => {
    const check = STEP.slice(STEP.indexOf('_finalRoles'), STEP.indexOf('_finalRoles') + 200);
    expect(check).toMatch(/readFileSync\(PROFILES_PATH/);
  });
});
