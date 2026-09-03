/**
 * EVERY model call gets retry, ladder escalation and self-heal. No exceptions.
 *
 * Live AMSD-2041 run 9: discovery's call returned an empty response, there was
 * no retry, and the fallback answered a three-codeline ticket with one
 * repository — silently. Six earlier runs had hidden that it was always one bad
 * response away from running a third of the work and reporting success.
 *
 * The audit that followed found the split is structural, not incidental:
 *
 *   retry      hand-rolled per site        6 of 20 call sites
 *   ladder     _ladder_next_model()        copy-pasted into 3 files, 6 sites
 *   self-heal  lib/kb-apply.sh (a library) called from claude.sh ONLY
 *
 * Everything inside the orchestrator phase has resilience. The ingest and helper
 * layer has none — and it holds the two most consequential calls in the run:
 * ac-gate.js, which writes the acceptance criteria everything is judged
 * against, and codeline-discovery.js, which chooses the repositories the run
 * modifies. Both single-shot.
 *
 * Per-site patches would leave the same hole open for the next call site added,
 * exactly as the last one did. So the guarantee lives at the ONE seam every call
 * already passes through — ai-run.sh — where a caller cannot omit it, cannot
 * hand-roll a different version of it, and a new call site inherits it by
 * construction.
 *
 * The three are deliberately different in kind:
 *   RETRY absorbs a transport-level transient (empty or unusable output).
 *   LADDER changes the model between attempts so a retry is not a coin flip
 *          re-flipped — the escalation the codebase already defines.
 *   SELF-HEAL records what failed and applies learned constraints, so the
 *          knowledge is not confined to story agents.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../orchestrations/scripts');
const SEAM = readFileSync(join(ROOT, 'llm-handler.sh'), 'utf8');

describe('the seam retries a transport-level failure', () => {
  it('does not accept an empty response on the first attempt', () => {
    // Discovery's live failure: "Empty response from ai-run.sh". One shot.
    expect(SEAM, 'a single empty response still ends the call')
      .toMatch(/EPAM_CALL_MAX_ATTEMPTS|_call_attempt/);
  });

  it('reports each attempt rather than only the outcome', () => {
    const i = SEAM.search(/EPAM_CALL_MAX_ATTEMPTS|_call_attempt/);
    expect(i, 'no retry mechanism found').toBeGreaterThan(-1);
    expect(SEAM.slice(i, i + 2500), 'a retried failure leaves no trace')
      .toMatch(/>&2|echo/);
  });

  it('still fails when every attempt fails', () => {
    // Retry must not convert a real failure into a silent success.
    expect(SEAM).toMatch(/exit 1/);
  });
});

describe('the seam escalates the model between attempts', () => {
  it('consults the ladder the codebase already defines', () => {
    // Retrying the same model on the same prompt is the same coin flip again.
    expect(SEAM, 'retries repeat on the same model')
      .toMatch(/EPAM_MODEL_LADDER|_ladder/);
  });

  it('does not hardcode any model name', () => {
    // The ladder is configuration; the next project's rungs are its own.
    const code = SEAM.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const named = ['glm-5.1', 'glm-5.2', 'kimi-k3', 'MiniMax-M3'].filter((m) => code.includes(m));
    expect(named, `model names hardcoded at the seam: ${named.join(', ')}`).toEqual([]);
  });
});

describe('the seam applies self-heal to every call, not just story agents', () => {
  it('sources the self-heal library', () => {
    // kb-apply.sh is a library; only claude.sh ever called it, so the detective,
    // the AC gate, discovery and CPA never learned from a failure.
    expect(SEAM, 'self-heal is still confined to story agents')
      .toMatch(/kb-apply\.sh|kb_apply_constraints/);
  });

  it('records what failed so the knowledge is not lost', () => {
    expect(SEAM, 'a failed call teaches nothing').toMatch(/kb_record_episode/);
  });

  it('degrades safely when the KB is unavailable', () => {
    // A missing or broken KB must never take a call down with it.
    const i = SEAM.search(/kb-apply\.sh|kb_apply_constraints/);
    expect(SEAM.slice(Math.max(0, i - 400), i + 900),
      'a KB problem can now break every model call in the pipeline')
      .toMatch(/\|\| true|2>\/dev\/null|-f /);
  });
});

describe('the guarantee cannot be bypassed by a new call site', () => {
  it('every call site still goes through the seam', () => {
    // The point of fixing it here: a site added tomorrow inherits it.
    for (const f of ['lib/codeline-discovery.js', 'lib/ac-gate.js', 'lib/cpa-inference.js']) {
      const p = join(ROOT, f);
      if (!existsSync(p)) continue;
      expect(readFileSync(p, 'utf8'), `${f} bypasses the seam`).toMatch(/ai-run\.sh/);
    }
  });

  it('the plan pass does not recurse through the retry', () => {
    // ai-run.sh re-invokes itself for the plan pass; retry must not multiply.
    expect(SEAM, 'the in-plan-pass guard is missing').toMatch(/_EPAM_IN_PLAN_PASS/);
  });
});
