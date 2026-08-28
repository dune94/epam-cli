/**
 * A BUILT CAPABILITY IS WIRED OR IT IS NOT BUILT.
 *
 * invoke.py has carried `--cache-system` — "mark system prompt block with cache_control
 * ephemeral" — plumbed through build_messages, and NO caller has ever passed it. So every SDK
 * invocation paid full price for a prefix that was identical each time.
 *
 * The flag being present is what makes this dangerous rather than merely wasteful: a reader
 * sees the capability and assumes the path caches. That is the same shape as the plan-fidelity
 * gate with a test and no caller, and the ladder pins that outranked declarations.
 *
 * Asserted at the CALL SITE, not by the flag existing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const claudeSrc = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
const invokePy = readFileSync(join(ROOT, 'orchestrations/scripts/invoke.py'), 'utf8');

/** Every line that invokes invoke.py. */
const callSites = claudeSrc.split('\n').filter((l) => /"\$INVOKE_PY"/.test(l));

describe('the SDK path caches its prefix', () => {
  it('invoke.py still offers the flag — otherwise there is nothing to wire', () => {
    expect(invokePy).toMatch(/--cache-system/);
    expect(invokePy, 'the flag must still reach the message builder').toMatch(/cache_system/);
  });

  it('finds the call sites — otherwise this test asserts nothing', () => {
    expect(callSites.length, 'no invoke.py call sites found').toBeGreaterThan(0);
  });

  it('EVERY invoke.py call site passes --cache-system', () => {
    // Every site, not one: a path that caches on the planning call and not the execution call
    // pays full price for the larger of the two, and nothing would report it.
    const blocks = claudeSrc.split('\n');
    const missing: string[] = [];
    let generating = 0;
    blocks.forEach((l, i) => {
      if (!/"\$INVOKE_PY"/.test(l)) return;
      // NOT the `[ -f "$INVOKE_PY" ]` guards — they invoke nothing.
      if (/\[\s*-f\s/.test(l)) return;
      // the invocation spans continuation lines — look ahead until the line without a backslash
      let chunk = l; let j = i;
      while (/\\\s*$/.test(blocks[j]) && j + 1 < blocks.length) { j += 1; chunk += '\n' + blocks[j]; }
      // NOT the token-count probes: --count-tokens-only generates nothing, so there is no
      // prefix to cache and no cost to save. Caching there would change the request shape for
      // a measurement whose whole purpose is to predict the real one.
      if (/--count-tokens-only/.test(chunk)) return;
      generating += 1;
      if (!/--cache-system/.test(chunk)) missing.push(`line ${i + 1}: ${l.trim().slice(0, 70)}`);
    });
    expect(generating, 'no GENERATING invocations found — this would pass vacuously').toBeGreaterThan(0);
    expect(missing, 'these SDK invocations pay full price for an identical prefix').toEqual([]);
  });
});
