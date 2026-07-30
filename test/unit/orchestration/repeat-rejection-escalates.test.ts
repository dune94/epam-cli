/**
 * Re-asking a model that already refused is a no-op with a price tag.
 *
 * Live AMSD-2041 2026-07-30, run 4. The metrolinx lane produced the IDENTICAL
 * rejection on attempts 2, 3 and 4:
 *
 *   the prescribed helper `Stack.livePreviewQuery` EXISTS in this repository
 *   but does NOT appear in the change. The agent hand-rolled the logic
 *   instead of reusing it [attempt 2/8 — will retry]
 *
 * The corrective was reaching the agent — the retry prompt named the helper 21
 * times and explained why re-implementing it fails. The model read it and did
 * not comply. Nothing about the next attempt differed, so nothing about the
 * outcome could: $2.29 across three lanes, no lane delivered.
 *
 * The ladder cannot help here on its own, because it only steps when ENTERING a
 * rung — `_entering_rung=$(( retry_count % 2 == 0 ))` — so a story gets two
 * attempts per model. The second is a re-ask of a model whose answer is already
 * known.
 *
 * THE RULE: an identical rejection twice is evidence about the MODEL, not about
 * the prompt. Repeating it must change something. Escalating early costs one
 * rung; re-asking costs a full attempt and buys a copy of the last answer.
 *
 * This does not make a model comply — that is IMPL-PROSE's job (make the
 * requirement structural rather than advisory). This stops paying for the same
 * refusal, and gets a stronger model onto the problem sooner.
 *
 * Deliberately keyed on a STABLE rejection key, not the warning text: the text
 * carries the attempt number ("[attempt 2/8]"), so comparing messages would
 * never match and the whole mechanism would silently never fire.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fnText(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() not found in claude.sh`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

/**
 * Feed a sequence of rejection keys through the REAL helper, one per attempt,
 * and report which attempts were judged repeats.
 */
function sequence(keys: string[]) {
  const d = mkdtempSync(join(tmpdir(), 'reject-'));
  dirs.push(d);
  const script = join(d, 'run.sh');
  const calls = keys
    .map((k) => `if _rejection_repeat_check S-1 ${JSON.stringify(k)}; then echo "REPEAT"; else echo "NEW"; fi`)
    .join('\n');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
LOG_DIR=${JSON.stringify(d)}
log(){ :; }; warning(){ :; }; error(){ :; }
${fnText('_rejection_repeat_check')}
${calls}
`);
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
  const out = (r.stdout || '') + (r.stderr || '');
  return out.split('\n').filter((l) => l === 'REPEAT' || l === 'NEW');
}

describe('an identical rejection twice is recognised', () => {
  it('the first rejection is not a repeat', () => {
    expect(sequence(['helper:Stack.livePreviewQuery'])).toEqual(['NEW']);
  });

  it('the same rejection again is a repeat — the live case', () => {
    const k = 'helper:Stack.livePreviewQuery';
    expect(sequence([k, k]),
      'attempts 2, 3 and 4 produced the identical rejection and nothing changed')
      .toEqual(['NEW', 'REPEAT']);
  });

  it('a DIFFERENT rejection is not a repeat', () => {
    // Progress: the agent fixed the first problem and hit a second one. That
    // deserves another attempt on the same model, not an escalation.
    expect(sequence(['helper:A', 'unchanged:2'])).toEqual(['NEW', 'NEW']);
  });

  it('alternating rejections never count as repeats', () => {
    expect(sequence(['a', 'b', 'a', 'b'])).toEqual(['NEW', 'NEW', 'NEW', 'NEW']);
  });

  it('a run of three identical rejections repeats each time after the first', () => {
    const k = 'helper:X';
    expect(sequence([k, k, k])).toEqual(['NEW', 'REPEAT', 'REPEAT']);
  });

  it('an empty key is never a repeat', () => {
    // No rejection recorded (e.g. the attempt failed for another reason) must
    // not read as "the same as last time" and trigger a spurious escalation.
    expect(sequence(['', ''])).toEqual(['NEW', 'NEW']);
  });

  it('keeps separate state per story', () => {
    const d = mkdtempSync(join(tmpdir(), 'reject2-'));
    dirs.push(d);
    const script = join(d, 'run.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
LOG_DIR=${JSON.stringify(d)}
log(){ :; }; warning(){ :; }; error(){ :; }
${fnText('_rejection_repeat_check')}
_rejection_repeat_check S-1 "same" >/dev/null; echo "s1a=$?"
_rejection_repeat_check S-2 "same" >/dev/null; echo "s2a=$?"
_rejection_repeat_check S-1 "same" >/dev/null; echo "s1b=$?"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    const out = r.stdout || '';
    // S-2's first sighting must not be read as a repeat of S-1's.
    expect(out, 'one story\'s rejection leaked into another\'s history').toMatch(/s2a=1/);
    expect(out, 'the story\'s own repeat was missed').toMatch(/s1b=0/);
  });
});

describe('the verifier records a stable key for every rejection', () => {
  const verifier = fnText('verify_story_deliverables');

  it('sets a rejection key on the prescribed-helper path', () => {
    // The live rejection. Without a key here, the repeat check can never fire
    // for the exact case it was built for.
    expect(fnText('verify_prescribed_helper_used') + verifier,
      'the helper-reuse rejection records no key — repeats are invisible')
      .toMatch(/STORY_REJECTION_KEY=/);
  });

  it('sets a key on every failing branch', () => {
    // A branch that returns 1 without setting a key silently disables the
    // mechanism for that failure mode — and inherits the PREVIOUS key, which
    // would be worse than nothing: a spurious repeat.
    const returns = (verifier.match(/^\s*return 1\s*$/gm) || []).length;
    const keys = (verifier.match(/STORY_REJECTION_KEY=/g) || []).length;
    expect(keys, `${returns} failing return(s) but only ${keys} rejection key(s) set`)
      .toBeGreaterThanOrEqual(returns);
  });

  it('the key excludes the attempt number', () => {
    // "[attempt 2/8 — will retry]" is part of the warning TEXT. A key built
    // from that text would differ every attempt and never match.
    const assignments = verifier.match(/STORY_REJECTION_KEY="[^"]*"/g) || [];
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) {
      expect(a, `rejection key varies per attempt, so it can never repeat: ${a}`)
        .not.toMatch(/retry_count|attempt/);
    }
  });
});

describe('the ladder consumes it', () => {
  it('a repeat forces the rung to advance', () => {
    // The behavioural tests above prove the detector. This proves it is wired
    // into the decision it exists to change — a correct detector nobody
    // consults leaves the loop exactly as it was.
    const i = SRC.indexOf('_entering_rung=');
    expect(i, 'the rung-entry decision is gone — this is anchored to nothing').toBeGreaterThan(-1);
    // Wide enough to clear the rationale comment between the declaration and
    // the check — the first draft used 900 and failed against correct code.
    const block = SRC.slice(i, i + 2000);
    expect(block, 'the rung decision ignores a repeated rejection: the model that ' +
      'already refused gets re-asked with the same prompt')
      .toMatch(/_rejection_repeat_check/);
  });
});
