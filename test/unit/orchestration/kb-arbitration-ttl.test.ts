/**
 * PILLAR 2 — conflict resolution and knowledge pruning.
 *
 * A self-healed rule is correct only for the system as it was when the rule was
 * written. When the underlying code moves on, the old fix becomes the new drift.
 * Two mechanisms, both absent today:
 *
 *   ARBITRATION  Before a rule is admitted, a conflict merge runs against existing
 *                rules in the same scope. Contradiction -> the stale rule is
 *                ARCHIVED and superseded, never left to fight the new one.
 *   TTL          A rule that stops firing is not trusted indefinitely. Idle cycles
 *                accumulate; at expiry the rule is retired for re-validation.
 *
 * Today's KB has neither, and worse: `run_failure_analyst` persists a rule even
 * when the reviewer rejects it three times, tagged `[unreviewed-fallback]`. A
 * write path that cannot say no is a drift generator. Arbitration here fails
 * CLOSED — an unresolvable conflict rejects the new rule rather than storing both.
 *
 * Nothing is deleted. Superseded and expired rules move to constraints.archive.jsonl
 * so a bad arbitration decision is auditable and reversible.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
let store: any, arb: any, dir: string;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-arb-')); dirs.push(dir);
  store = require(join(LIB, 'kb-store.js'));
  arb = require(join(LIB, 'kb-arbitration.js'));
  store.configure({ root: dir });
});

const c = (over: any = {}) => ({
  id: 'iter-12', scope: { agent_role: 'typescript-engineer' }, trigger: { signature: 'TS2532' },
  enforcement: { kind: 'param', name: 'EPAM_REASONING_EFFORT', value: 'high' },
  reason: 'needs more iterations', origin_episodes: ['e1'], ...over,
});

describe('arbitration — contradiction archives the stale rule', () => {
  it('two rules setting the SAME param to different values cannot both be active', () => {
    store.putConstraint(c());
    arb.admit(store, c({ id: 'iter-20', enforcement: { kind: 'param', name: 'EPAM_REASONING_EFFORT', value: 'medium' } }));
    const active = store.lookup({ agent_role: 'typescript-engineer', signature: 'TS2532' });
    expect(active).toHaveLength(1);
    expect(active[0].enforcement.value).toBe('medium');
  });

  it('the superseded rule is archived, not deleted', () => {
    store.putConstraint(c());
    arb.admit(store, c({ id: 'iter-20', enforcement: { kind: 'param', name: 'EPAM_REASONING_EFFORT', value: 'medium' } }));
    const archived = store.readConstraints().find((x: any) => x.id === 'iter-12');
    expect(archived.status).toBe('archived');
    expect(archived.superseded_by).toBe('iter-20');
    expect(existsSync(store._paths().archive)).toBe(true);
  });

  it('a non-conflicting rule in the same scope is admitted alongside', () => {
    store.putConstraint(c());
    arb.admit(store, c({ id: 'gate-narrow', enforcement: { kind: 'gate', check: 'narrow-optionals' } }));
    expect(store.lookup({ agent_role: 'typescript-engineer', signature: 'TS2532' })).toHaveLength(2);
  });

  it('an identical rule MERGES origin episodes instead of duplicating', () => {
    store.putConstraint(c());
    arb.admit(store, c({ id: 'iter-12-again', origin_episodes: ['e2'] }));
    const active = store.lookup({ agent_role: 'typescript-engineer', signature: 'TS2532' });
    expect(active).toHaveLength(1);
    expect(active[0].origin_episodes.sort()).toEqual(['e1', 'e2']);
  });

  it('rules in DIFFERENT scopes never conflict', () => {
    store.putConstraint(c());
    arb.admit(store, c({ id: 'other', scope: { agent_role: 'test-engineer' } }));
    expect(store.readConstraints().filter((x: any) => x.status !== 'archived')).toHaveLength(2);
  });
});

describe('TTL — a rule that stops firing is retired, not trusted forever', () => {
  it('idle cycles accumulate for rules that did not fire', () => {
    store.putConstraint(c({ ttl_cycles: 3 }));
    arb.tick(store, { fired: [] });
    arb.tick(store, { fired: [] });
    expect(store.readConstraints()[0].cycles_idle).toBe(2);
  });

  it('firing resets the idle counter and stamps last_fired', () => {
    store.putConstraint(c({ ttl_cycles: 3 }));
    arb.tick(store, { fired: [] });
    arb.tick(store, { fired: ['iter-12'] });
    const r = store.readConstraints()[0];
    expect(r.cycles_idle).toBe(0);
    expect(r.last_fired).toMatch(/^\d{4}-/);
  });

  it('expiry archives the rule for re-validation rather than silently keeping it', () => {
    store.putConstraint(c({ ttl_cycles: 2 }));
    expect(arb.tick(store, { fired: [] })).toEqual([]);   // idle 1 of 2 — still trusted
    const expired = arb.tick(store, { fired: [] });        // idle reaches 2 — retire
    expect(expired.map((x: any) => x.id)).toContain('iter-12');
    expect(arb.tick(store, { fired: [] })).toEqual([]);     // already archived, not re-reported
    expect(store.lookup({ agent_role: 'typescript-engineer', signature: 'TS2532' })).toHaveLength(0);
    expect(store.readConstraints()[0].status).toBe('archived');
  });
});

describe('arbitration fails CLOSED', () => {
  it('rejects a rule that does not validate rather than storing it unreviewed', () => {
    // The `[unreviewed-fallback]` path in run_failure_analyst persists a note even
    // after three reviewer rejections. That is the behaviour being replaced.
    expect(() => arb.admit(store, c({ enforcement: { kind: 'note', text: 'be careful' } }))).toThrow();
    expect(store.readConstraints()).toHaveLength(0);
  });
});
