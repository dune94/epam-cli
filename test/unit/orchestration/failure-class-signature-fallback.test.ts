/**
 * A failure with no tool-derived signature must still be keyable.
 *
 * Live metrolinx, 2026-07-25 — the first time self-heal fired in a real run:
 *
 *   attempt 1 failed (class=max_iterations) — invoking self-heal analyst
 *   episode: { signature: null, diagnosis: "You have already spent all 15
 *              iterations exploring without writing anything..." }
 *
 * The analyst produced a good, specific diagnosis. But a max_iterations failure
 * emits no compiler code and no runner error, so fromToolOutput() found nothing,
 * the episode was recorded UNKEYED, and synthesis correctly refused to build a
 * rule it could never look up. Result: constraints=0, quarantine=0 — self-heal
 * did nothing at all for the failure class that actually occurred.
 *
 * Before the prose channel was removed that diagnosis would have been prepended to
 * the retry and likely helped. So this gap is a live regression, not a theoretical
 * one; the ladder escalation to kimi-k3 carried the run instead.
 *
 * The fix: when tool output yields no key, fall back to the FAILURE CLASS, which
 * the analyst already knows. `max_iterations` is a perfectly good lookup key —
 * "this role keeps exhausting its budget" is exactly the pattern a param
 * constraint (raise EPAM_MAX_ITERATIONS) is designed to fix.
 *
 * signature_source stays distinct ('failure_class' vs 'tsc'/'vitest') so an audit
 * can still tell a precise key from a coarse one. A tool-derived signature must
 * always win: TS2532 is far more specific than "the agent ran out of turns".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const { buildEpisode } = require(join(LIB, 'failure-signature.js'));

const TSC_ERROR = "src/a.ts(12,5): error TS2532: Object is possibly 'undefined'.";
const NO_SIGNAL = 'I explored the repository but never wrote the file.';

describe('failure-class signature fallback', () => {
  it('keys an unkeyable failure on its CLASS instead of dropping it', () => {
    const ep = buildEpisode({ id: 'e1', toolOutput: NO_SIGNAL, failure_class: 'max_iterations' });
    expect(ep.signature,
      'a max_iterations failure is still unkeyed — synthesis can never look it up, ' +
      'so self-heal does nothing for the class that actually occurs')
      .toBe('class:max_iterations');
    expect(ep.signature_source,
      'a coarse class key must be distinguishable from a precise tool-derived one')
      .toBe('failure_class');
  });

  it('a TOOL-DERIVED signature always wins over the class', () => {
    const ep = buildEpisode({ id: 'e2', toolOutput: TSC_ERROR, failure_class: 'max_iterations' });
    expect(ep.signature, 'the coarse key displaced a precise one').toBe('TS2532');
    expect(ep.signature_source).toBe('tsc');
  });

  it('stays null when there is neither a signal nor a class', () => {
    const ep = buildEpisode({ id: 'e3', toolOutput: NO_SIGNAL });
    expect(ep.signature).toBeNull();
    expect(ep.signature_source).toBeNull();
  });

  it('does not invent a key from an empty class', () => {
    const ep = buildEpisode({ id: 'e4', toolOutput: NO_SIGNAL, failure_class: '' });
    expect(ep.signature).toBeNull();
  });
});

describe('the class reaches the episode through the real plumbing', () => {
  it('kb-cli record accepts a failure class', () => {
    const src = readFileSync(join(LIB, 'kb-cli.js'), 'utf8');
    expect(src, 'no --failure-class argument — the class cannot reach buildEpisode')
      .toMatch(/failure-class/);
  });

  it('kb_record_episode forwards it', () => {
    const src = readFileSync(join(LIB, 'kb-apply.sh'), 'utf8');
    expect(src, 'the shell seam drops the failure class').toMatch(/failure-class/);
  });

  it('the analyst passes the class it already knows', () => {
    const src = readFileSync(join(LIB, '..', 'agent-attempt-analyst.sh'), 'utf8');
    const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
    expect(code,
      'the analyst knows FAILURE_CLASS but does not pass it, so every unkeyable ' +
      'failure stays unkeyable')
      .toMatch(/kb_record_episode[\s\S]{0,200}FAILURE_CLASS|FAILURE_CLASS[\s\S]{0,200}kb_record_episode/);
  });
});
