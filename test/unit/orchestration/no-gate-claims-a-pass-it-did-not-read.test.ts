/**
 * NO GATE CLAIMS A PASS IT DID NOT READ.
 *
 * Six QA gates read a verdict out of their own log. Five handled the un-parseable case honestly —
 * they emit a `warn` step naming the reason ("no parseable findings", "unverified findings
 * downgraded"). The sixth, qa-gate:e2e, reported:
 *
 *     else
 *         success "  Step 4.6: $route PASS for $story_id"
 *
 * Nobody wrote "pass"; it was inferred from the absence of "fail", and the operator was told the
 * same thing they would be told by a gate that ran and approved the work.
 *
 * The class is contained today. This keeps it contained: any gate that reads a verdict and then
 * announces SUCCESS on the fall-through fails here. The rule is not "warn instead of pass" — a
 * gate may fail, warn, or refuse on an unreadable verdict, and different gates reasonably differ.
 * The rule is that it may not report an APPROVAL it never received.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const ORCH = join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh');

/**
 * Every fall-through arm that follows a verdict read — an `else` closing an if/elif chain that
 * greps for a verdict, or a `*)` arm in a case over one.
 */
/**
 * The STATEMENTS of an arm, skipping its comments. A fixed line window silently mis-read an arm
 * the moment a comment was added above the report — the guard then flagged a line it had itself
 * pushed out of view, which is a guard measuring its own blind spot rather than the code.
 */
function armBody(lines: string[], from: number): string {
  const out: string[] = [];
  for (let i = from; i < Math.min(from + 20, lines.length); i += 1) {
    const t = lines[i].trim();
    if (/^(fi|esac|;;|else|elif|\*\))$/.test(t)) break;
    if (t.startsWith('#') || t === '') continue;
    out.push(lines[i]);
    if (out.length >= 6) break;
  }
  return out.join('\n');
}

function fallThroughsAfterAVerdictRead(): { line: number; body: string }[] {
  const lines = readFileSync(ORCH, 'utf8').split('\n');
  const out: { line: number; body: string }[] = [];
  lines.forEach((l, i) => {
    if (!/grep -q '"verdict"/.test(l)) return;
    if (/^\s*(#|elif)/.test(l.trim()) && /elif/.test(l)) return;
    // Walk forward to the chain's own else, stopping at its fi.
    for (let j = i + 1; j < Math.min(i + 60, lines.length); j += 1) {
      if (/^\s*fi\s*$/.test(lines[j])) break;
      if (/^\s*else\s*$/.test(lines[j])) {
        out.push({ line: j + 1, body: armBody(lines, j + 1) });
        break;
      }
    }
  });
  // And the case form, which is what e2e uses now.
  lines.forEach((l, i) => {
    if (!/case "\$\(qa_gate_verdict_of/.test(l)) return;
    for (let j = i + 1; j < Math.min(i + 40, lines.length); j += 1) {
      if (/^\s*esac\s*$/.test(lines[j])) break;
      if (/^\s*\*\)\s*$/.test(lines[j])) {
        out.push({ line: j + 1, body: armBody(lines, j + 1) });
        break;
      }
    }
  });
  return out;
}

describe('no gate claims a pass it did not read', () => {
  it('there are verdict reads to check — otherwise this proves nothing', () => {
    expect(fallThroughsAfterAVerdictRead().length,
      'no verdict fall-throughs found; the shape has changed and this guard is now blind')
      .toBeGreaterThan(3);
  });

  it('none of them announces success', () => {
    // `success` is the function that tells the operator the step passed. Reaching it because a
    // verdict could not be read is the defect: an approval nobody gave.
    const offenders = fallThroughsAfterAVerdictRead()
      .filter((f) => /\bsuccess\b/.test(f.body))
      .map((f) => `run-agent-orchestration.sh:${f.line}`);
    expect(offenders, 'these announce a PASS on the fall-through of a verdict read — the operator '
      + 'is told a gate approved the work when the gate said nothing readable').toEqual([]);
  });

  it('and each says something, rather than falling through in silence', () => {
    const silent = fallThroughsAfterAVerdictRead()
      .filter((f) => !/\b(step_emit|error|warning|log|success)\b/.test(f.body))
      .map((f) => `run-agent-orchestration.sh:${f.line}`);
    expect(silent, 'these reach the fall-through of a verdict read and report nothing at all')
      .toEqual([]);
  });
});
