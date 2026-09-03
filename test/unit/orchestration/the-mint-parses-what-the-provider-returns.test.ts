/**
 * THE MINT: RED THEN GREEN.
 *
 * metrolinx AMSD-1919 died three times in the agent-mint, on the shape its own provider returned.
 * v1.5 worked; v1.5 passed --json-schema ZERO times. Wiring EPAM_RESPONSE_SCHEMA into the claude
 * arm changed what comes back, and nothing tested the two ends against each other.
 *
 * This is that test. It drives the REAL chain the mint uses — extractTaggedJson, then the parse
 * that decides accept-or-retry — against every shape a provider can hand it. No model call, no
 * spend, deterministic.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const { unwrapEnvelope } = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
const runner = require_(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'));

/** The mint's answer, as the schema declares it. */
const ANSWER = {
  proposedAgents: [
    { name: 'gotransit-checkout-investigator', kind: 'investigator', codeline: 'gotransit' },
  ],
};

/** The real accept-or-retry decision, exactly as the mint makes it. */
function mintAccepts(reply: string): { ok: boolean; reason?: string } {
  // THE REAL PATH HAS TWO STEPS, AND THIS USED TO SKIP ONE. The mint extracts and THEN calls
  // unwrapEnvelope(payload, 'proposedAgents'). Asserting on extraction alone made this test demand
  // that the extractor strip envelopes blindly — which it cannot do, because at that point nothing
  // knows which key the caller wants, and stripping broke a seam whose answer IS a list.
  const extracted = runner.extractTaggedJson(reply, 'PROJECT_AGENTS');
  if (!extracted) return { ok: false, reason: 'the response could not be parsed as JSON at all' };
  const payload = unwrapEnvelope(extracted, 'proposedAgents');
  if (!Array.isArray((payload as { proposedAgents?: unknown[] }).proposedAgents)) {
    return { ok: false, reason: 'the response had no "proposedAgents" array' };
  }
  return { ok: true };
}

describe('THE MINT PARSES WHAT ITS PROVIDER ACTUALLY RETURNS', () => {
  it('a tagged block — the contract the prompt states', () => {
    expect(mintAccepts(`<PROJECT_AGENTS>${JSON.stringify(ANSWER)}</PROJECT_AGENTS>`).ok).toBe(true);
  });

  it('a BARE object — what --json-schema returns, which v1.5 never had to handle', () => {
    expect(mintAccepts(JSON.stringify(ANSWER)).ok).toBe(true);
  });

  it('THE FAILURE: a single-element array envelope', () => {
    // The literal shape from the run log of 2026-08-29:
    //   [{"proposedAgents":[{"name":"gotransit-checkout-investigator", ...}]}]
    // Rejected three times as "no proposedAgents array", three paid runs dead.
    const r = mintAccepts(JSON.stringify([ANSWER]));
    expect(r.ok, `the mint still rejects its own correct answer: ${r.reason}`).toBe(true);
  });

  it('a tagged block whose contents are wrapped in an array', () => {
    expect(mintAccepts(`<PROJECT_AGENTS>${JSON.stringify([ANSWER])}</PROJECT_AGENTS>`).ok).toBe(true);
  });

  it('and it still REFUSES what is genuinely not an answer', () => {
    // Widening must not become "accept anything": a retry exists for replies that are wrong.
    expect(mintAccepts('I could not determine which agents are needed.').ok).toBe(false);
    expect(mintAccepts(JSON.stringify({ somethingElse: [] })).ok).toBe(false);
    expect(mintAccepts(JSON.stringify([ANSWER, ANSWER])).ok,
      'two answers means the model replied twice and there is no way to know which it meant')
      .toBe(false);
  });
});
