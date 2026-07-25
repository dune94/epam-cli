/**
 * A schema-valid constraint can still be self-defeating. Admission must check
 * DIRECTION, not just shape.
 *
 * Live metrolinx, 2026-07-25. The repro-test-writer failed by EXHAUSTING its 15
 * iterations. Self-heal synthesised, admitted and applied this:
 *
 *   { enforcement: { kind: "param", name: "EPAM_MAX_ITERATIONS", value: "14" },
 *     reason: "Prevents exceeding the 15-iteration limit by setting a hard cap
 *              at 14 iterations." }
 *
 * The model reasoned backwards: told the agent hit a limit, it LOWERED the limit.
 * Result — "Agent reached maximum iterations (14) without completing" on all three
 * attempts, no test written, repro-gate blocked. The previous run, with no
 * self-heal, had succeeded on attempt 2. Self-heal caused the regression.
 *
 * Every pillar passed it, correctly and uselessly:
 *   - Pydantic validated it: kind/name/value are all structurally perfect.
 *     A schema checks SHAPE, and "raise the budget" and "lower the budget" have
 *     identical shape.
 *   - Arbitration admitted it: no contradicting rule existed to conflict with.
 *   - The state digest verified it: it was applied faithfully, which IS the bug.
 *
 * This is the over-correction failure mode the memory-drift design warns about,
 * and the enforcement vocabulary can express a harmful rule as easily as a helpful
 * one. Schema validation cannot close that; a semantic guard can.
 *
 * THE RULE: budget parameters are INCREASE-ONLY. A rule that fires because a
 * budget was exhausted must never shrink that budget. Compared against the value
 * actually in force, so it is a real comparison rather than a guess.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function freshStore() {
  const root = mkdtempSync(join(tmpdir(), 'sanity-')); dirs.push(root);
  for (const m of ['kb-store.js', 'kb-arbitration.js']) {
    delete require.cache[require.resolve(join(LIB, m))];
  }
  const store = require(join(LIB, 'kb-store.js'));
  store.configure({ root });
  const arb = require(join(LIB, 'kb-arbitration.js'));
  return { root, store, arb };
}

const candidate = (value: string) => ({
  id: 'repro-test-writer-class-max-iterations',
  scope: { agent_role: 'repro-test-writer' },
  trigger: { signature: 'class:max_iterations' },
  enforcement: { kind: 'param', name: 'EPAM_MAX_ITERATIONS', value },
  reason: 'agent exhausted its iteration budget',
  origin_episodes: [],
});

describe('admission rejects a self-defeating constraint', () => {
  it('REFUSES to lower a budget that was just exhausted', () => {
    const { store, arb } = freshStore();
    const prev = process.env.EPAM_MAX_ITERATIONS;
    process.env.EPAM_MAX_ITERATIONS = '15';
    try {
      expect(() => arb.admit(store, candidate('14')),
        'the exact live rule — "you ran out at 15, so use 14" — was admitted and applied')
        .toThrow(/increase|lower|sanity/i);
      expect(store.readConstraints().length, 'a harmful rule reached the store').toBe(0);
    } finally {
      if (prev === undefined) delete process.env.EPAM_MAX_ITERATIONS;
      else process.env.EPAM_MAX_ITERATIONS = prev;
    }
  });

  it('ADMITS a rule that raises the budget', () => {
    const { store, arb } = freshStore();
    const prev = process.env.EPAM_MAX_ITERATIONS;
    process.env.EPAM_MAX_ITERATIONS = '15';
    try {
      arb.admit(store, candidate('40'));
      expect(store.readConstraints().length, 'the correct fix was rejected').toBe(1);
    } finally {
      if (prev === undefined) delete process.env.EPAM_MAX_ITERATIONS;
      else process.env.EPAM_MAX_ITERATIONS = prev;
    }
  });

  it('does not block params that are not budgets', () => {
    const { store, arb } = freshStore();
    arb.admit(store, {
      ...candidate('1'),
      enforcement: { kind: 'param', name: 'EPAM_REASONING_EFFORT', value: 'high' },
    });
    expect(store.readConstraints().length).toBe(1);
  });

  it('rejects a non-numeric value for a numeric budget', () => {
    const { store, arb } = freshStore();
    expect(() => arb.admit(store, candidate('lots'))).toThrow();
  });
});

describe('a synthesised rule carries a TTL so pillar 2 can age it', () => {
  it('defaults ttl_cycles instead of leaving it null', () => {
    const { store, arb } = freshStore();
    const prev = process.env.EPAM_MAX_ITERATIONS;
    process.env.EPAM_MAX_ITERATIONS = '15';
    try {
      arb.admit(store, candidate('40'));
      const stored = store.readConstraints()[0];
      expect(stored.ttl_cycles,
        'ttl_cycles came back null — kb-synthesizer builds its candidate directly ' +
        'and bypasses store.synthesize(), where the default lives, so the rule ' +
        'never ages out for re-validation')
        .toBeGreaterThan(0);
      expect(stored.cycles_idle).toBe(0);
      // Same missing-default class as ttl_cycles: a directly-built candidate
      // reached the store with status null, which only worked because
      // null !== 'archived'.
      expect(stored.status, 'a stored rule has no status — lookup works by accident')
        .toBe('active');
    } finally {
      if (prev === undefined) delete process.env.EPAM_MAX_ITERATIONS;
      else process.env.EPAM_MAX_ITERATIONS = prev;
    }
  });
});

describe('a refused rule is quarantined, not silently dropped', () => {
  it('kb-synthesizer records the sanity refusal with its reason', () => {
    const src = readFileSync(join(LIB, 'kb-synthesizer.js'), 'utf8');
    // The existing catch around admit() must keep capturing the reason.
    expect(src).toMatch(/unmapped_rule/);
    expect(src).toMatch(/refused by schema\/arbitration|detail:/);
  });
});

/**
 * SECOND ATTEMPT AT THIS GUARD. The first compared the proposed value against
 * process.env[name] and skipped when it was absent:
 *
 *   const current = Number(source[e.name]);
 *   if (!Number.isFinite(current)) return;    // <- skipped in production
 *
 * In a real run EPAM_MAX_ITERATIONS is NOT in the shell where synthesis happens —
 * the writer passes it as a per-command prefix, not an export. So `current` was
 * NaN, the guard returned early, and the identical harmful rule (value 14 after
 * exhausting 15) was admitted a SECOND time on the very next run. Quarantine was
 * empty; nothing was rejected.
 *
 * I built a guard that fails open silently — the exact defect class this whole
 * effort exists to remove. It passed its tests only because the tests set the env
 * var that production does not.
 *
 * The fix keys on EVIDENCE, not ambient state: "Agent reached maximum iterations
 * (15)" is in the tool output the episode already captures, so the observed limit
 * is a fact, not a guess. And when no baseline can be established at all, an
 * exhaustion-triggered budget rule now FAILS CLOSED — such a rule is only
 * meaningful as an increase, and admitting one we cannot verify is what caused the
 * damage twice.
 */
describe('the guard works without any environment help', () => {
  const EXHAUSTED = 'Agent reached maximum iterations (15) without completing.';

  it('extracts the observed limit from tool output', () => {
    const { buildEpisode } = require(join(LIB, 'failure-signature.js'));
    const ep = buildEpisode({ id: 'e1', toolOutput: EXHAUSTED, failure_class: 'max_iterations' });
    expect(ep.observed_limit,
      'the limit is right there in the tool output but is not captured, so the ' +
      'guard has no fact to compare against').toBe(15);
  });

  it('REJECTS a decrease using the observed limit, with NO env var set', () => {
    const { store, arb } = freshStore();
    const prev = process.env.EPAM_MAX_ITERATIONS;
    delete process.env.EPAM_MAX_ITERATIONS;          // production conditions
    try {
      expect(() => arb.admit(store, candidate('14'), { observedLimit: 15 }),
        'without an env var the guard went inert and admitted the harmful rule again')
        .toThrow(/increase|observed|sanity/i);
      expect(store.readConstraints().length).toBe(0);
    } finally {
      if (prev !== undefined) process.env.EPAM_MAX_ITERATIONS = prev;
    }
  });

  it('ADMITS an increase above the observed limit, with no env var set', () => {
    const { store, arb } = freshStore();
    const prev = process.env.EPAM_MAX_ITERATIONS;
    delete process.env.EPAM_MAX_ITERATIONS;
    try {
      arb.admit(store, candidate('40'), { observedLimit: 15 });
      expect(store.readConstraints().length, 'the correct fix was rejected').toBe(1);
    } finally {
      if (prev !== undefined) process.env.EPAM_MAX_ITERATIONS = prev;
    }
  });

  it('FAILS CLOSED when no baseline can be established at all', () => {
    const { store, arb } = freshStore();
    const prev = process.env.EPAM_MAX_ITERATIONS;
    delete process.env.EPAM_MAX_ITERATIONS;
    try {
      // Exhaustion trigger + budget param + nothing to compare against. Admitting
      // an unverifiable rule here is precisely what caused the damage, twice.
      expect(() => arb.admit(store, candidate('14')),
        'an unverifiable exhaustion rule was admitted — fail closed, not open')
        .toThrow();
    } finally {
      if (prev !== undefined) process.env.EPAM_MAX_ITERATIONS = prev;
    }
  });
});
