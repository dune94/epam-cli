/**
 * A ROSTER REVIEW THAT FAULTS ONE BRIEF MUST NOT COST A REGENERATION OF ALL FIFTY.
 *
 * Live 2026-09-04, pipeline-tests-19. The review found ONE real defect — checkout-form-engineer's
 * brief claimed @hookform/error-message was "already used" in CheckoutForm.tsx, and it is used
 * elsewhere in the repo but not in that file. A correct, evidence-backed finding about one agent.
 *
 * The whole 50-agent roster was then regenerated from scratch:
 *
 *     attempt 1  sonnet-5     24,562 out   1.51M cache read    4.4 min   $0.95
 *     attempt 2  opus-4-8     57,560 out   1.02M cache read   12.5 min   $3.63
 *
 * $4.58 and 17 minutes on the roster alone, of a run that had spent $7.51 total at that point —
 * 61% of the spend, for one wrong sentence. Three multipliers compound it: the roster is
 * all-or-nothing, `attempt` drives the ladder rung so the retry escalates (sonnet -> opus-4-8, a
 * 3.8x unit cost), and it lands on the largest call in the run. 57,560 output tokens is also
 * within 10% of the 64,000 ceiling, so a third attempt risks a TRUNCATED roster rather than
 * merely an expensive one. Worst case at EPAM_ROSTER_ATTEMPTS=3 is roughly $8-12 and 30 minutes,
 * before any prompt work begins.
 *
 * THE EXISTING INVARIANT IS DELIBERATE AND IS NOT BEING DISCARDED. project-roster.js says, at the
 * top of the attempt loop:
 *
 *     "A fresh start each attempt: a retry must not inherit half of the previous answer, or a
 *      roster that failed once can pass by accumulation."
 *
 * That guard is about UNJUDGED partial state — a fragment surviving into a result nothing
 * re-examines. Repair does not weaken it, PROVIDED the full contract check and the full review
 * both run again on the complete roster. Every agent is re-judged every attempt either way; what
 * changes is only how many the model must WRITE. So the rule this file adds is: repair in place,
 * re-judge in full, and fall back to a full rewrite the moment the findings do not name who is at
 * fault.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { buildProjectRoster, personaDigest, agentKinds } =
  require('../../../orchestrations/scripts/lib/project-roster.js');

/**
 * A canonical roster and a contract-satisfying derived roster, in the shapes the library actually
 * requires — canonical is a flat `name -> persona text` map, and a roster is
 * `{ agents: { name: {persona, kind, ancestor, derivedFromSha256} } }` covering EVERY canonical
 * name. Nothing here is invented: the digest convention and the kind vocabulary are read from the
 * library itself, so a change there fails this file rather than drifting from it.
 */
function fixture(n = 4) {
  const dir = mkdtempSync(join(tmpdir(), 'roster-repair-'));
  const logDir = join(dir, 'logs');
  const cfgDir = join(dir, 'cfg');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(cfgDir, { recursive: true });

  const canonical: Record<string, string> = {};
  for (let i = 1; i <= n; i++) canonical[`agent-${i}`] = `canonical persona for agent-${i}`;
  const canonicalPath = join(dir, 'canonical.json');
  writeFileSync(canonicalPath, JSON.stringify(canonical, null, 2));

  const kind = agentKinds()[0];          // the library's own vocabulary, not a literal
  const roster = () => ({
    agents: Object.fromEntries(Object.keys(canonical).map((name) => [name, {
      persona: `specialised persona for ${name}`,
      kind,
      ancestor: name,
      derivedFromSha256: personaDigest(canonical[name]),
    }])),
  });

  return { dir, logDir, cfgDir, canonicalPath, canonical, roster };
}

describe('a rejected roster is REPAIRED, not rewritten from scratch', () => {
  it('when the review names the agent at fault, produce is asked to repair only that one', async () => {
    const f = fixture(4);
    const calls: Array<Record<string, unknown>> = [];
    let reviewed = 0;

    const produce = async (opts: any) => {
      calls.push(opts);
      writeFileSync(opts.outPath, JSON.stringify(f.roster()));
    };
    const review = async () => {
      reviewed += 1;
      // First look: one agent is at fault, and the review says WHICH. Second look: clean.
      return reviewed === 1
        ? { verdict: 'defects_found',
            findings: [{ agent: 'agent-2', severity: 'blocking', claim: 'brief 2 is wrong' }] }
        : { verdict: 'approved' };
    };

    try {
      await buildProjectRoster({
        canonicalPath: f.canonicalPath, logDir: f.logDir, projectConfigDir: f.cfgDir,
        produce, review, attempts: 3, log: () => {},
      });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }

    expect(calls.length, 'the roster was not retried at all').toBeGreaterThan(1);
    const retry = calls[1];
    expect(retry.repairOnly,
      'the retry rewrote all 50 briefs to fix one — that is the $3.63 opus call this exists to stop')
      .toEqual(['agent-2']);
    expect(retry.previousRosterPath,
      'the retry was given nothing to repair FROM, so it can only rewrite')
      .toBeTruthy();
  });

  it('the previous roster survives the retry, so there is something to repair', async () => {
    const f = fixture(3);
    let seenOnRetry: string | null = null;
    let reviewed = 0;

    const produce = async (opts: any) => {
      if (opts.repairOnly) {
        seenOnRetry = existsSync(opts.previousRosterPath as string)
          ? readFileSync(opts.previousRosterPath as string, 'utf8') : null;
      }
      writeFileSync(opts.outPath, JSON.stringify(f.roster()));
    };
    const review = async () => (++reviewed === 1
      ? { verdict: 'defects_found', findings: [{ agent: 'agent-1', severity: 'blocking', claim: 'x' }] }
      : { verdict: 'approved' });

    try {
      await buildProjectRoster({
        canonicalPath: f.canonicalPath, logDir: f.logDir, projectConfigDir: f.cfgDir,
        produce, review, attempts: 3, log: () => {},
      });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }

    expect(seenOnRetry, 'the roster was unlinked before the retry — nothing left to repair').toBeTruthy();
    expect(JSON.parse(seenOnRetry!).agents, 'the previous roster reached the retry incomplete')
      .toHaveProperty('agent-1');
  });

  it('findings that name NO agent still force a full rewrite — repair needs a target', async () => {
    // A finding about the roster as a whole ("two agents own the same file") cannot be repaired
    // agent-by-agent. Falling back is what keeps this an optimisation rather than a new way to
    // pass a roster nobody could fix.
    const f = fixture(3);
    const calls: Array<Record<string, unknown>> = [];
    let reviewed = 0;
    const produce = async (opts: any) => {
      calls.push(opts);
      writeFileSync(opts.outPath, JSON.stringify(f.roster()));
    };
    const review = async () => (++reviewed === 1
      ? { verdict: 'defects_found', findings: [{ severity: 'blocking', claim: 'two agents own the same file' }] }
      : { verdict: 'approved' });

    try {
      await buildProjectRoster({
        canonicalPath: f.canonicalPath, logDir: f.logDir, projectConfigDir: f.cfgDir,
        produce, review, attempts: 3, log: () => {},
      });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }

    expect(calls[1].repairOnly, 'a finding with no agent was turned into a targeted repair with no target')
      .toBeFalsy();
  });

  it('THE INVARIANT HOLDS: a repaired roster is still contract-checked and reviewed IN FULL', async () => {
    // "a retry must not inherit half of the previous answer, or a roster that failed once can pass
    // by accumulation" — the guard is about UNJUDGED state. Repair keeps every agent under
    // judgement; it only changes how many the model must write.
    const f = fixture(4);
    let reviewed = 0;
    const seenByReview: number[] = [];
    const produce = async (opts: any) => writeFileSync(opts.outPath, JSON.stringify(f.roster()));
    const review = async ({ roster }: any) => {
      reviewed += 1;
      seenByReview.push(Object.keys(roster.agents).length);
      return reviewed === 1
        ? { verdict: 'defects_found', findings: [{ agent: 'agent-3', severity: 'blocking', claim: 'x' }] }
        : { verdict: 'approved' };
    };

    try {
      await buildProjectRoster({
        canonicalPath: f.canonicalPath, logDir: f.logDir, projectConfigDir: f.cfgDir,
        produce, review, attempts: 3, log: () => {},
      });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }

    expect(seenByReview.length, 'the repaired roster was not re-reviewed').toBeGreaterThan(1);
    expect(seenByReview[seenByReview.length - 1],
      'the review saw only the repaired subset — that is how a defect passes by accumulation')
      .toBe(4);
  });
});
