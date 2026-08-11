/**
 * THE LADDER'S DECISION, TESTED DIRECTLY.
 *
 * I wrote the ladder as four inlined `case` arms tangled with logging, rung snapshots, monitor
 * updates and budget checks, reading ~20 variables from the enclosing scope. Nothing could call
 * it, so nothing tested it, so every defect in it was found by paying for a live run:
 *
 *   - rung 1 held the model FIXED and only raised effort — a story that failed twice retried on
 *     the same model. That is not a ladder.
 *   - a rung transition ASSIGNED effort, so rung 1 set `medium` over the `max` a retry had just
 *     escalated to. A retry made the model try less hard.
 *   - the escalated model and the iteration bump did not survive re-invocation.
 *
 * Then I added five more things to that same block and blamed the block. `next_ladder_step` is
 * the decision extracted as a pure function: same inputs, same tuple, no side effects. These
 * tests state inputs and check outputs — no lifted block, no simulated retry loop, no ambient
 * state, no API calls.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
const CFG = JSON.parse(readFileSync(join(ROOT, 'orchestrations/projects/metrolinx/llm-settings.json'), 'utf8'));

const LADDER: string[] = CFG.effortLadder;
const rank = (e: string) => LADDER.indexOf(e);
const CHAIN = CFG.ladders.high.modelLadder as Array<{ from: string; to: string }>;
const START = 'MiniMax-M3';

function lift(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{$`, 'm').exec(SRC);
  expect(m, `no definition for ${name}()`).toBeTruthy();
  const i = (m as RegExpExecArray).index;
  return SRC.slice(i, SRC.indexOf('\n}\n', i) + 3);
}

const PRELUDE = [
  `export EPAM_EFFORT_LADDER=${JSON.stringify(LADDER.join('|'))}`,
  `export EPAM_MODEL_LADDER_HIGH=${JSON.stringify(CHAIN.map((e) => `${e.from}=${e.to}`).join('|'))}`,
  ...[0, 1, 2, 3].map((r) => {
    const c = CFG.rungs.find((x: { rung: number }) => x.rung === r);
    return `export EPAM_RUNG${r}_REASONING_EFFORT=${JSON.stringify(c.reasoningEffort)}\n` +
           `export EPAM_RUNG${r}_TEMPERATURE=${JSON.stringify(String(c.temperature))}`;
  }),
  'warning() { :; }',
  lift('effort_rank'), lift('max_effort'), lift('next_effort'),
  lift('get_model_ladder_step'), lift('next_ladder_step'),
].join('\n');

type Step = { model: string; effort: string; temp: string };

/** Calls the real function. One process, no loop reconstruction. */
function step(rung: number, model: string, effort: string, tier = 'high'): Step {
  const out = execFileSync('bash', ['-c',
    `${PRELUDE}\nnext_ladder_step ${rung} ${JSON.stringify(model)} ${JSON.stringify(effort)} ${JSON.stringify(tier)}`],
    { encoding: 'utf8' }).trim();
  const [m, e, t] = out.split('|');
  return { model: m, effort: e, temp: t };
}

/** The configured chain, walked. */
function chainFrom(start: string): string[] {
  const edges = new Map(CHAIN.map((e) => [e.from, e.to] as const));
  const out = [start];
  for (let m = start; edges.get(m) && edges.get(m) !== m; m = edges.get(m) as string) {
    out.push(edges.get(m) as string);
  }
  return out;
}

describe('EVERY rung steps the model — that is what a ladder IS', () => {
  for (const rung of [0, 1, 2, 3]) {
    it(`rung ${rung} advances off ${START}`, () => {
      expect(
        step(rung, START, 'medium').model,
        `rung ${rung} kept the model on ${START} — a story failing here retries on the same model`,
      ).not.toBe(START);
    });
  }

  it('it advances along the CONFIGURED chain, not an invented one', () => {
    const chain = chainFrom(START);
    expect(step(1, START, 'medium').model).toBe(chain[1]);
    expect(step(1, chain[1], 'medium').model).toBe(chain[2]);
  });

  it('at the top of the chain the model stays put', () => {
    const chain = chainFrom(START);
    const top = chain[chain.length - 1];
    expect(step(3, top, 'high').model).toBe(top);
  });
});

describe('effort NEVER decreases', () => {
  it('a rung whose configured effort is LOWER does not pull it down', () => {
    // Live: rung 1 (config: medium) assigned over the `max` a retry had escalated to.
    const top = LADDER[LADDER.length - 1];
    expect(
      rank(step(1, START, top).effort),
      `rung 1 dropped '${top}' to '${step(1, START, top).effort}'`,
    ).toBeGreaterThanOrEqual(rank(top));
  });

  it('for every rung and every starting effort, the result is never lower', () => {
    for (const rung of [0, 1, 2, 3]) {
      for (const e of LADDER) {
        expect(
          rank(step(rung, START, e).effort),
          `rung ${rung} lowered '${e}'`,
        ).toBeGreaterThanOrEqual(rank(e));
      }
    }
  });

  it("a rung's configured effort still RAISES a lower one", () => {
    const r2 = CFG.rungs.find((x: { rung: number }) => x.rung === 2).reasoningEffort;
    expect(rank(step(2, START, 'low').effort)).toBeGreaterThanOrEqual(rank(r2));
  });
});

describe('when the model cannot move, effort becomes the lever', () => {
  it('at the chain top, effort rises rather than repeating the attempt unchanged', () => {
    // Starts AT the rung's own configured effort, so the rung floor cannot raise it and only
    // the cannot-move bump can. An earlier version of this test started below the floor, so it
    // passed via the floor and a mutation removing the bump survived — the assertion was true
    // for the wrong reason.
    const chain = chainFrom(START);
    const top = chain[chain.length - 1];
    const rungEffort = CFG.rungs.find((x: { rung: number }) => x.rung === 2).reasoningEffort;
    const r = step(2, top, rungEffort);
    expect(r.model, 'the fixture is not at the chain top').toBe(top);
    expect(
      rank(r.effort),
      `the model could not move and effort stayed at '${rungEffort}' — the next attempt is ` +
      'byte-for-byte identical to the one that just failed',
    ).toBeGreaterThan(rank(rungEffort));
  });

  it('but it saturates at the top of the effort ladder', () => {
    const chain = chainFrom(START);
    const top = chain[chain.length - 1];
    const maxEffort = LADDER[LADDER.length - 1];
    expect(step(3, top, maxEffort).effort).toBe(maxEffort);
  });
});

describe('temperature follows the rung', () => {
  it('never decreases as rungs climb', () => {
    const temps = [0, 1, 2, 3].map((r) => Number(step(r, START, 'medium').temp));
    for (let i = 1; i < temps.length; i++) {
      expect(temps[i], `rung ${i} lowered temperature`).toBeGreaterThanOrEqual(temps[i - 1]);
    }
  });
});

describe('a full climb, attempt by attempt', () => {
  it('the model advances and effort never drops across all four rungs', () => {
    let model = START;
    let effort = CFG.rungs.find((x: { rung: number }) => x.rung === 0).reasoningEffort;
    const seen: Step[] = [];
    for (const rung of [0, 1, 2, 3]) {
      const r = step(rung, model, effort);
      seen.push(r); model = r.model; effort = r.effort;
    }
    expect(seen[seen.length - 1].model, 'the ladder never left its starting model').not.toBe(START);
    for (let i = 1; i < seen.length; i++) {
      expect(rank(seen[i].effort)).toBeGreaterThanOrEqual(rank(seen[i - 1].effort));
    }
  });
});

describe('the tier selects the chain', () => {
  it('an unconfigured tier does not silently borrow another one', () => {
    // `highest` fell through a catch-all onto the MEDIUM ladder in production.
    const viaHigh = step(1, START, 'medium', 'high').model;
    const viaBogus = step(1, START, 'medium', 'not-a-tier').model;
    expect(viaHigh).not.toBe(START);
    expect(viaBogus === viaHigh && viaHigh !== START).toBe(false);
  });
});

describe('the production path USES this function — no arm keeps its own copy', () => {
  it('every escalating rung delegates to next_ladder_step', () => {
    // COUNTED, not just present. Rung 2 has two legitimate call sites (its own arm and the
    // forced healing-failure escalation), so a `toContain` check stayed green when the arm's
    // call was deleted — the healing one satisfied it. Verified by mutation.
    const code = SRC.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    const expected: Record<number, number> = { 1: 1, 2: 2, 3: 1 };
    for (const rung of [1, 2, 3]) {
      const n = code.split(`next_ladder_step ${rung} `).length - 1;
      expect(
        n,
        `rung ${rung} has ${n} delegating call site(s), expected ${expected[rung]} — an arm is ` +
        'carrying its own copy of the escalation rules, so these tests say nothing about it',
      ).toBe(expected[rung]);
    }
  });

  it('no arm resolves the model behind the function\'s back', () => {
    // A direct get_model_ladder_step inside a rung arm means that arm bypasses the floor and
    // cannot-move rules the function enforces. Only next_ladder_step itself may call it.
    const fn = lift('next_ladder_step');
    const outside = SRC.replace(fn, '');
    const armCalls = outside.split('\n').filter((l) =>
      l.includes('get_model_ladder_step') && !l.trim().startsWith('#') &&
      /ladder_step_r|escalated_model|_step=/.test(l));
    expect(armCalls, `these lines bypass next_ladder_step: ${armCalls.join(' | ')}`).toEqual([]);
  });

  it('the forced healing-failure escalation also goes through the function', () => {
    // This path escalates to the HIGH tier when self-healing is confirmed broken. It used to
    // call get_model_ladder_step directly, bypassing the effort floor and the cannot-move rule,
    // so a story in its worst state got the one escalation that ignored the invariants.
    const i = SRC.indexOf('_high_step=');
    expect(i, 'the healing-failure escalation moved').toBeGreaterThan(-1);
    expect(SRC.slice(i, i + 400)).toContain('next_ladder_step');
  });

  it('every next_ladder_step call passes a rung the function understands', () => {
    // Comment lines excluded: the function's own docstring reads `next_ladder_step <rung> ...`
    // and matched as a call site with the literal argument '<rung>'.
    const calls = SRC.split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .flatMap((l) => [...l.matchAll(/next_ladder_step (\S+) /g)].map((m) => m[1]));
    expect(calls.length, 'no call sites found').toBeGreaterThan(2);
    for (const c of calls) {
      expect(['0', '1', '2', '3'], `called with rung '${c}'`).toContain(c);
    }
  });


});
