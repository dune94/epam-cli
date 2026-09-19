/**
 * A REFUSED SPEC ANSWER IS RETRIED WITH A CORRECTION, ON THE NEXT RUNG.
 *
 * regintel 20260919T224649Z, core spec pass: openspec echoed the prompt example for REGI-005
 * three times on z-ai/glm-5.3, each correctly refused ("copied back, not answered") — and each
 * retry was the identical prompt on the identical model. The loop classified the refused answer
 * as "empty — retrying transient failure" (no note), and its escalation read
 * SPEC_MODE_OPENSPEC_MODEL_HIGH, an env no set declares, so it never climbed. The pass aborted.
 *
 * The engine's own rule (runSeamUntilAccepted): a refused answer is asked again with the refusal
 * as the correction, at the next rung of the seam's declared ladder. The spec agent's retry now
 * obeys it: (1) a refused echo classifies as `placeholder` with a corrective note; (2) attempt N
 * resolves the spec-agent seam's environment at rung N — the model the ladder declares there.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
let spec: any;
beforeAll(() => {
  process.env.SPEC_MODE_NO_MAIN = '1';
  process.env.EPAM_BROWNFIELD = '';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
});

const ECHO_REASON = 'SPEC_AGENT: list "acceptanceCriteria" holds only the prompt example\'s placeholder — the example was copied back, not answered';

describe('classification: a refused echo is not a transient', () => {
  it('a null payload whose refusal named the placeholder classifies as placeholder', () => {
    expect(spec.classifySpecRefusal({ payload: null, refusal: ECHO_REASON })).toBe('placeholder');
  });

  it('a null payload with no refusal is still a transient (empty)', () => {
    expect(spec.classifySpecRefusal({ payload: null, refusal: '' })).toBe('empty');
  });

  it('the placeholder correction tells the model the example is the shape, not the answer', () => {
    const note = spec.specCorrectiveNote('placeholder');
    expect(note).toMatch(/REJECTED/);
    expect(note).toMatch(/example/i);
    expect(note).toMatch(/shape/i);
  });
});

describe('the climb: attempt N runs at rung N of the spec-agent ladder', () => {
  it('the rung-resolved environment differs from rung 0 once the ladder has a second rung', () => {
    const logDir = join(ROOT, 'orchestrations/logs');
    const r0 = spec.seamInvocationEnvAtRung('spec-agent', logDir, 0) || {};
    const r1 = spec.seamInvocationEnvAtRung('spec-agent', logDir, 1) || {};
    expect(r0.EPAM_MODEL, 'rung 0 resolves no model — the seam has no ladder to climb').toBeTruthy();
    expect(r1.EPAM_MODEL, 'rung 1 resolves no model').toBeTruthy();
    expect(r1.EPAM_MODEL, 'rung 1 is the same model as rung 0 — the retry would not climb').not.toBe(r0.EPAM_MODEL);
  });

  it('runSpecAgent accepts the attempt and resolves its environment at that rung', () => {
    // The receiver's signature is the contract: the loop passes `attempt`, runSpecAgent asks the
    // ladder at that rung. Asserted on the function's own parameter list and its resolver call.
    const src = String(spec.runSpecAgent);
    expect(src).toMatch(/attempt/);
    expect(src).toMatch(/seamInvocationEnvAtRung\('spec-agent'/);
  });
});
