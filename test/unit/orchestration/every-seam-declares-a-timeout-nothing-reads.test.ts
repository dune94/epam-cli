/**
 * ALL 36 SEAMS DECLARE A TIMEOUT. NOTHING READS ONE.
 *
 * invocation-profiles.json gives every seam a timeoutSecs — 900 for the writer, the reviewer and
 * the repro-test writer, 600 for tc-writer and code-review-cycle, 300 for cpa-inference, 180 for
 * cpa-gate. seamInvocationEnv faithfully exports it as EPAM_TIMEOUT_SECS. No model-call site in
 * the pipeline reads that variable.
 *
 * What actually bounds a call is one of ~8 unrelated literals:
 *
 *     runClaude             360000   (RUNCLAUDE_TIMEOUT_MS)
 *     ac-gate x3            360000   (AC_GATE_TIMEOUT_MS)
 *     spec-mode-runner:745  180000
 *     kb-synthesizer        180000
 *     cpa-inference         120000
 *     mint-agents-step      120000
 *
 * Live 2026-08-17, run 20260817T185759Z: prompt-builder declares 900s, was bounded at 360s, and
 * died there — destroying the survey, the roster, the assignment and 12 already-generated prompts,
 * 30 minutes in. team-lead-review, repro-test-writer and story-writer all declare 900s and all get
 * 360s, which is a plausible source of writer timeouts nobody could explain.
 *
 * THE SAME CLASS, FOR THE THIRD TIME. The ladder was declared per seam and read by nothing until
 * it was wired; the tool grant was declared per seam and read by nothing until it was wired; the
 * timeout is the third and was never connected to either. A declaration nothing consumes is
 * documentation that reads as configuration, and the run pays for the difference.
 *
 * PRECEDENCE: an explicit operator override still wins — someone debugging must be able to force a
 * number — then the seam's own declaration, then the historical default for calls with no seam.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));

const registry = () => JSON.parse(readFileSync(REGISTRY, 'utf8'));

afterEach(() => {
  delete process.env.RUNCLAUDE_TIMEOUT_MS;
  delete process.env.EPAM_TIMEOUT_SECS;
});

describe('every seam declares a timeout nothing reads', () => {
  it('the resolver is reachable', () => {
    expect(typeof spec.runClaudeTimeoutMs,
      'how long a call may take is not resolvable, so it cannot be asserted').toBe('function');
  });

  it('EVERY seam declares one — so ignoring it discards the whole intent', () => {
    const P = registry().profiles || {};
    const declared = Object.entries<any>(P).filter(([, p]) => p.timeoutSecs);
    expect(declared.length, 'seams stopped declaring timeouts').toBe(Object.keys(P).length);
  });

  it('THE SEAM DECLARATION IS HONOURED — the live failure', () => {
    // prompt-builder asks for 900s and was bounded at 360s.
    const want = registry().profiles['prompt-builder'].timeoutSecs;
    expect(spec.runClaudeTimeoutMs({ EPAM_TIMEOUT_SECS: String(want) }),
      'a seam asking for a longer budget is still cut off at the old default')
      .toBe(want * 1000);
  });

  it('a seam asking for LESS is also honoured — this is not a floor', () => {
    // cpa-gate declares 180s. Granting it 360 would let a cheap gate hang for twice as long.
    expect(spec.runClaudeTimeoutMs({ EPAM_TIMEOUT_SECS: '180' })).toBe(180000);
  });

  it('AN OPERATOR OVERRIDE STILL WINS — someone debugging must be able to force a number', () => {
    process.env.RUNCLAUDE_TIMEOUT_MS = '42000';
    expect(spec.runClaudeTimeoutMs({ EPAM_TIMEOUT_SECS: '900' }),
      'the seam silently overrode an explicit operator instruction').toBe(42000);
  });

  it('a call with NO seam keeps the historical default', () => {
    // Not every call site runs at a seam; this must not become a hard failure or a new number.
    expect(spec.runClaudeTimeoutMs({})).toBe(360000);
    expect(spec.runClaudeTimeoutMs()).toBe(360000);
  });

  it('a nonsense declaration falls back rather than bounding a call at zero', () => {
    // A zero or negative budget would fail every call instantly, which is worse than too long.
    for (const bad of ['0', '-5', 'soon', '']) {
      expect(spec.runClaudeTimeoutMs({ EPAM_TIMEOUT_SECS: bad }),
        `EPAM_TIMEOUT_SECS='${bad}' produced a broken budget`).toBe(360000);
    }
  });

  it('the seam env actually carries it, or the resolver has nothing to read', () => {
    // Guards the join: seamInvocationEnv must still export what this now consumes.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { seamInvocationEnv } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));
    const env = seamInvocationEnv('prompt-builder');
    expect(env.EPAM_TIMEOUT_SECS, 'the seam no longer exports its declared timeout').toBeTruthy();
    expect(spec.runClaudeTimeoutMs(env)).toBe(registry().profiles['prompt-builder'].timeoutSecs * 1000);
  });
});
