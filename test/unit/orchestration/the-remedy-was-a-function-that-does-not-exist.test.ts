// THE GUARD DETECTED THE FAILURE, ANNOUNCED ITS REMEDY, AND CALLED A FUNCTION THAT DOES NOT EXIST.
//
// Live metrolinx AMSD-2041, run 2, 2026-08-20:
//
//   [ERROR] Step 3.6: review APPROVED after a blocker-level rejection, with the codeline UNCHANGED
//   [ERROR] Step 3.6: the verdict changed and the code did not — the blocker was never resolved.
//                     Escalating instead of approving.
//   run-agent-orchestration.sh: line 8051: _escalate_story_review: command not found
//
// The detection was right. The remedy was `_escalate_story_review`, which is defined NOWHERE in the
// engine — 156 underscore-prefixed functions are defined across the scripts and this is not one of
// them — and the call was wrapped in `|| true`, so its absence could not even fail the line. The
// story it was meant to escalate carried on with the approval standing.
//
// Two further signs it never worked: `_review_climbable_stories`, the array the loop iterates, is
// not assigned until line 8142 — AFTER the loop at 8061 that reads it. So on the pass where this
// fires the array is empty and the loop body never runs at all.
//
// THE GUARD ITSELF IS KEPT. Detecting an approval that follows an unresolved blocker is worth
// having, and the `break` that refuses the approval is the part that actually took effect. What is
// removed is a remedy that never existed — with the reviewer now receiving its own prior verdicts
// (1f24c70), the flip-flop this escalated should be prevented rather than compensated.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

/** Every underscore-prefixed shell function the engine defines. */
function definedFunctions(): Set<string> {
  const defined = new Set<string>();
  for (const d of ['orchestrations/scripts', 'orchestrations/scripts/lib']) {
    for (const f of readdirSync(join(ROOT, d)).filter((x) => x.endsWith('.sh'))) {
      const s = readFileSync(join(ROOT, d, f), 'utf8');
      for (const m of s.matchAll(/^\s*(_[a-z0-9_]+)\(\)\s*\{/gm)) defined.add(m[1]);
    }
  }
  return defined;
}

/**
 * Names invoked in COMMAND POSITION that no script defines.
 *
 * Deliberately narrow. A first pass counted 47 by matching any underscore name anywhere, which
 * swept in array expansions, a `__tests__` glob, and Python variables inside heredocs. Verified
 * down to the real ones: command position only, never a name assigned as a variable in the same
 * file, never an expansion on the same line.
 */
function undefinedCalls(): string[] {
  const defined = definedFunctions();
  const out: string[] = [];
  for (const d of ['orchestrations/scripts', 'orchestrations/scripts/lib']) {
    for (const f of readdirSync(join(ROOT, d)).filter((x) => x.endsWith('.sh'))) {
      const s = readFileSync(join(ROOT, d, f), 'utf8');
      // A heredoc can carry another language whose syntax looks like a shell call.
      const inHeredoc = /<<-?\s*['"]?[A-Z_]+['"]?/.test(s);
      s.split('\n').forEach((l, i) => {
        if (/^\s*#/.test(l)) return;
        const m = /^(?:\s*|.*?(?:;|&&|\|\||\bthen|\bdo|\bif|!)\s+)(_[a-z0-9_]{4,})(?:\s|$)/.exec(l);
        if (!m) return;
        const name = m[1];
        if (defined.has(name)) return;
        if (new RegExp(`(^|\\s|\\()${name}\\s*=`, 'm').test(s)) return;   // a variable
        if (new RegExp(`\\$\\{?${name}`).test(l)) return;                  // an expansion
        if (inHeredoc && /=\s|:\s|\(\)/.test(l) && !/^\s*_/.test(l)) return;
        out.push(`${f}:${i + 1}  ${name}`);
      });
    }
  }
  return out;
}

describe('the scan is real', () => {
  it('finds the engine functions that do exist', () => {
    expect(definedFunctions().size, 'the scan found nothing, so its silence proves nothing')
      .toBeGreaterThan(100);
  });
});

describe('no script calls a function nothing defines', () => {
  it('has no undefined invocations', () => {
    const bad = undefinedCalls();
    expect(bad, `a remedy that cannot run — the failure it handles will pass silently:\n${bad.join('\n')}`)
      .toEqual([]);
  });
});

describe('the guard that caught the flip-flop is kept', () => {
  const src = () => readFileSync(ORCH, 'utf8');

  it('still detects an approval that follows an unresolved blocker', () => {
    expect(src()).toMatch(/_review_approval_is_giveup/);
  });

  it('still refuses that approval', () => {
    // The `break` is the half that actually took effect: it leaves the review loop without
    // recording the approval. Removing the dead remedy must not remove the refusal.
    const i = src().indexOf('review APPROVED after a blocker-level rejection');
    expect(i, 'the detection is gone').toBeGreaterThan(-1);
    expect(src().slice(i, i + 2000)).toMatch(/\bbreak\b/);
  });

  it('and says so, so an operator sees it happened', () => {
    expect(src()).toMatch(/the verdict changed and the code did not/);
  });
});
