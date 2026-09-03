/**
 * A GUARD THAT RUNS, BECAUSE REMEMBERING DOES NOT WORK.
 *
 * On 2026-07-12 a session wrote orchestrations/scripts/tools/bash-coverage.js — a real bash
 * line-coverage tool — and wired it to nothing. `git log -S` finds exactly ONE commit mentioning
 * it: the one that created it. It sat dead for seven weeks.
 *
 * On 2026-08-31 another session (this one) searched for whether a shell coverage tool was
 * INSTALLED — kcov, bashcov, shellspec — found none, declared "62% of the engine has no
 * instrument", and built a second one. It never searched the repository for whether one had been
 * WRITTEN.
 *
 * Both halves are the same defect this codebase keeps producing: something is built, nothing calls
 * it, and nobody finds out. The operator's response was the right one — "maybe have a reference
 * mechanism that works? memory does not, you never use it."
 *
 * So this is not a note. It is a test that fails the moment a file has no caller, and it would have
 * failed on 2026-07-12.
 *
 * AN EXCEPTION NEEDS A WRITTEN REASON. An entry point invoked by a human or a scheduler is
 * legitimately unreferenced by code; a bare allowlist would let the next dead tool hide behind that
 * fact.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const REPO = join(__dirname, '../../..');
const SCRIPTS = join(REPO, 'orchestrations/scripts');

/**
 * Files with no caller in code, each with the reason that is acceptable. A bare name is rejected:
 * the point of the list is that somebody decided, and said why.
 */
const REVIEWED: Record<string, string> = {
  'run-bounded.sh':
    'operator entry point — a bounding wrapper a human puts IN FRONT of a command, so being '
    + 'uncalled by other code is what it is for',
  'tools/groundedness-impact-report.sh':
    'operator-run report — produces a readout a person reads on demand; it is not part of any '
    + 'pipeline path and nothing should call it automatically',
};

function scriptFiles(): string[] {
  const out: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (!/node_modules|archived|\.parked/.test(p)) walk(p); continue; }
      if (/\.(js|sh)$/.test(p)) out.push(p);
    }
  })(SCRIPTS);
  return out;
}

/** Files nothing else in the repository names. */
function unreferenced(): string[] {
  const out: string[] = [];
  for (const f of scriptFiles()) {
    const stem = basename(f).replace(/\.(js|sh)$/, '');
    // A MENTION IS NOT A CALL, AND A PATTERN LIST IS NOT A PARSER.
    //
    // The first version matched the bare filename anywhere, so this test's own header — which
    // names the dead tool while explaining it — counted as a reference and excused it. A guard a
    // comment can switch off is not a guard.
    //
    // The second version matched only literal `node x.js` / `. x.sh` shapes and flagged a dozen
    // files that ARE invoked, through `"${NODE_BIN:-node}" "$SCRIPT_DIR/..."`. Enumerating the
    // ways bash can name a file is a losing game.
    //
    // So: the name appearing on any line that is not a COMMENT. Prose cannot excuse a dead file,
    // and no invocation shape has to be anticipated.
    const name = basename(f);
    let hits = '';
    try {
      hits = execSync(
        `grep -rn --exclude-dir=node_modules --exclude-dir=archived --exclude-dir=.parked `
            // package.json IS a call site: an npm script ("coverage:shell": "bash .../x.sh") is as
            // real an invocation as a line in another shell script. Leaving it out of the corpus
            // reported a wired, working tool as an orphan — the guard inventing dead code.
        + `-F -- ${JSON.stringify(name)} orchestrations src test scripts package.json 2>/dev/null || true`,
        { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
    } catch { /* grep found nothing */ }
    const others = hits.split('\n').filter(Boolean)
      .filter((line) => {
        const file = line.slice(0, line.indexOf(':'));
        if (!file || resolve(REPO, file) === resolve(f)) return false;
        const text = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1).trim();
        return !(text.startsWith('#') || text.startsWith('//') || text.startsWith('*'));
      });
    if (others.length === 0) out.push(f.replace(`${SCRIPTS}/`, ''));
  }
  return out;
}

describe('nothing is built and left unwired', () => {
  it('there are scripts to check — otherwise this guard is blind', () => {
    expect(scriptFiles().length, 'no scripts found; the scan proves nothing').toBeGreaterThan(100);
  }, 180_000);

  it('every file has a caller, or a written reason why it does not', () => {
    const undecided = unreferenced().filter((f) => !REVIEWED[f]);
    expect(undecided, 'these are referenced by nothing in the repository. Something built and left '
      + 'unwired is invisible: it rots, it is rebuilt by the next session that needs it, and the '
      + 'duplicate is discovered by accident. Wire it, delete it, or record why it stands alone')
      .toEqual([]);
  }, 180_000);

  it('and no reason is a placeholder', () => {
    const thin = Object.entries(REVIEWED).filter(([, why]) => !why || why.trim().length < 30);
    expect(thin.map(([k]) => k), 'these are excused without a real reason').toEqual([]);
  });
});
