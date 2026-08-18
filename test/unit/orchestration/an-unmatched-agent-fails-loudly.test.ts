/**
 * AN UNMATCHED AGENT FAILS LOUDLY.
 *
 * The registry used to declare `defaultSeam: cpa-inference`, so resolveSeam could not fail.
 * Every agent no rule matched silently became a planning agent and inherited cpa-inference's
 * ladder, reasoning effort and tool grants.
 *
 * The cost was not hypothetical. Seven gate-path agents were found running the wrong ladder for
 * exactly this reason, and nothing had reported anything — the mint's own guard, "fails if any
 * minted agent resolves to nothing", could essentially never fire, because nothing ever resolved
 * to nothing. A safety net that catches everything catches nothing.
 *
 * Measured before removing it: all 59 agents in the live roster and cross-reference resolve
 * through a name, an agentSeams entry or a pattern. The default was absorbing nothing real; it
 * was only standing by to absorb the next mistake in silence.
 *
 * A project that genuinely wants unmatched agents pooled at one seam still can — it declares
 * EPAM_DEFAULT_SEAM in its own config. The ENGINE declares none, which is the one-generic-
 * pipeline rule applied to this decision: the policy is data the project supplies, not a
 * constant the engine holds.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { resolveSeam } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));

const registry = () => JSON.parse(readFileSync(REGISTRY, 'utf8'));

/** Resolve with NO ambient project config, so process.env cannot mask the behaviour. */
const resolve = (agent: string, env: Record<string, string> = {}) =>
  resolveSeam(agent, REGISTRY, { env });

describe('the engine holds no default seam', () => {
  it('the registry declares none', () => {
    expect(registry().defaultSeam,
      'the engine is deciding a policy that belongs to the project, and doing it silently',
    ).toBeUndefined();
  });

  it('an agent no rule matches is an ERROR, not a planning agent', () => {
    expect(() => resolve('kramble-widget-flanger'))
      .toThrow(/resolves to no seam/);
  });

  it('the error says how to fix it — all three ways', () => {
    // An error that states the problem and not the remedy sends the reader to the source. The
    // three mechanisms differ in scope and the right one depends on the case, so name them all.
    let msg = '';
    try { resolve('kramble-widget-flanger'); } catch (e) { msg = String((e as Error).message); }
    expect(msg).toMatch(/seamPattern/);
    expect(msg).toMatch(/agentSeams/);
    expect(msg).toMatch(/EPAM_DEFAULT_SEAM/);
  });
});

describe('a project may still opt in', () => {
  it('EPAM_DEFAULT_SEAM absorbs unmatched agents when the project asks for it', () => {
    expect(resolve('kramble-widget-flanger', { EPAM_DEFAULT_SEAM: 'cpa-inference' }))
      .toBe('cpa-inference');
  });

  it('a default naming a seam that does not exist is refused, not used', () => {
    // Otherwise the opt-in reintroduces the silence it replaced: every unmatched agent pooled at
    // a profile the registry cannot supply, which resolves to {}.
    expect(() => resolve('kramble-widget-flanger', { EPAM_DEFAULT_SEAM: 'no-such-seam' }))
      .toThrow(/does not define/);
  });
});

describe('nothing real depended on the default', () => {
  it('every agent the registry knows about resolves without one', () => {
    // The measurement that made removal safe, kept so it stays true. If a future pattern change
    // orphans an agent, this fails here rather than at mint time on somebody's run.
    const reg = registry();
    const names = Object.keys(reg.agentSeams || {});
    expect(names.length, 'no cross-referenced agents — this would pass vacuously').toBeGreaterThan(10);
    const unresolved: string[] = [];
    for (const n of names) {
      try { resolve(n); } catch { unresolved.push(n); }
    }
    expect(unresolved, `these agents now resolve to nothing:\n  ${unresolved.join('\n  ')}`).toEqual([]);
  });

  it('a BARE role name resolves — patterns are not suffix-only', () => {
    // Every rule was written as -word$, so an agent named for its role alone matched nothing.
    // While the engine carried a default that was invisible: "generator" silently became a
    // planning agent, and the recorded cross-reference still held that answer months later.
    // Minting models produce bare role names routinely, so a suffix-only rule set made seam
    // resolution depend on a naming habit nothing enforces.
    expect(resolve('generator')).toBe('tc-writer');
    expect(resolve('reviewer')).toBe('code-review-cycle');
    expect(resolve('analyst')).toBe('impl-failure-analyst');
    // And the suffix form still works, which is what the bare form was added beside.
    expect(resolve('gotransit-investigator')).toBe('code-graph-detective');
  });

  it('the recorded cross-reference agrees with the rules', () => {
    // agentSeams is DERIVED state: the mint re-derives it from the rules every run. When the two
    // disagree, the recorded answer is one a rule no longer produces — which is how "generator"
    // kept pointing at the seam the removed default had given it. Drift here means the next mint
    // will silently change an agent's ladder, and nobody asked for that.
    const reg = registry();
    const drift: string[] = [];
    for (const [agent, recorded] of Object.entries(reg.agentSeams || {})) {
      let fromRules = '(no rule matches)';
      try { fromRules = resolveSeam(agent, REGISTRY, { ignoreXref: true, env: {} }); } catch { /* keep */ }
      if (fromRules !== recorded) drift.push(`${agent}: recorded=${recorded} rules=${fromRules}`);
    }
    expect(drift, `the cross-reference disagrees with the rules that produce it:\n  ${drift.join('\n  ')}`)
      .toEqual([]);
  });

  it('lint-fixer resolves — it was invoked with no seam at all', () => {
    // Found by the seam audit: run-agent-orchestration.sh invokes it by name, and it was not a
    // profile, not cross-referenced and matched no pattern. It edits files in place to a minimal
    // idiomatic change, so it is an instance of the writer archetype.
    expect(resolve('lint-fixer')).toBe('story-writer');
  });
});
