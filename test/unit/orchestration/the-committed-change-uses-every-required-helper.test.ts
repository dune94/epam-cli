/**
 * THE COMMITTED CHANGE USES EVERY REQUIRED HELPER.
 *
 * verify_prescribed_helper_used checks `git diff <baseline>` — the WORKING TREE. That is
 * not the artifact. A story's attempts share one tree, partial work is deliberately
 * carried between them ("WorktreeReset: skipped — partial work preserved"), and the
 * commit is assembled at the end. So a helper can be present when the guard looks and
 * absent from what actually ships.
 *
 * Live, run 20260815T142007Z (metrolinx, AMSD-2041). The plan named five files and four
 * verified helpers. The guard did not fire, the story was marked complete, and the commit
 * contains:
 *
 *     ContentstackContext   0 occurrences
 *     getContentByKey       0
 *     useContent            0
 *     Stack                 7
 *
 * The rescued previous pass (epam-rescue/AMSD-2041-8341407b) used all four — 27/5/5/9 —
 * and touched src/context/contentstackContext.tsx, which is where the plan said the
 * reactivity had to live. The shipped implementation configures the SDK and subscribes to
 * entry changes, but nothing re-queries, so draft content never reaches the page.
 *
 * I could not determine from the logs WHY the working-tree guard stayed silent — the lane
 * PRD yields all four helpers, the baseline ref resolves, and the "declared candidate
 * file(s) were unchanged" branch does not return early. This check does not depend on
 * knowing: it measures the COMMIT, which is the only thing that ships.
 *
 * NOTHING IS HARDCODED. Helpers come from the story's own fixSiteAnalysis, using the same
 * filter the write-time guard uses. No symbol, path or project word appears here or in the
 * function under test.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');

/** Extract the function under test and run it against a real git fixture. */
function runCheck(opts: {
  helpers: Array<{ helper: string; fixVerified: boolean | null }>;
  committedBody: string;
  /** Left in the WORKING TREE, never committed — residue from an earlier attempt. */
  uncommittedBody?: string;
}) {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('_committed_change_uses_helpers() {');
  expect(start, '_committed_change_uses_helpers not found in claude.sh').toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', start);
  const fn = src.slice(start, end + 3);

  const dir = mkdtempSync(join(tmpdir(), 'helper-commit-'));
  try {
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    const git = (args: string) =>
      spawnSync('bash', ['-c', `git -C ${JSON.stringify(repo)} ${args}`], { encoding: 'utf8' });
    git('init -q -b develop .');
    git('config user.email t@t'); git('config user.name t');
    writeFileSync(join(repo, 'src.ts'), 'export const base = 1;\n');
    git('add -A'); git('commit -qm base');
    const baseline = spawnSync('bash', ['-c', `git -C ${JSON.stringify(repo)} rev-parse HEAD`], {
      encoding: 'utf8',
    }).stdout.trim();
    // The COMMITTED change — what actually ships.
    writeFileSync(join(repo, 'src.ts'), `export const base = 1;\n${opts.committedBody}\n`);
    git('add -A'); git('commit -qm change');
    // Residue an earlier attempt left behind: present in the tree, absent from the commit.
    // It must be an uncommitted modification to a TRACKED file — `git diff` never shows
    // untracked files, so a new file would be invisible to both readings and prove nothing.
    if (opts.uncommittedBody) {
      writeFileSync(
        join(repo, 'src.ts'),
        `export const base = 1;\n${opts.committedBody}\n${opts.uncommittedBody}\n`,
      );
    }

    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({
      stories: [{ id: 'S-1', fixSiteAnalysis: opts.helpers.map((h, i) => ({
        file: `f${i}.ts`, helper: h.helper, fixVerified: h.fixVerified,
      })) }],
    }));

    const res = spawnSync('bash', ['-c', `
      set -uo pipefail
      log()     { echo "$*"; }
      warning() { echo "WARN: $*"; }
      error()   { echo "ERR: $*"; }
      PROJECT_ROOT=${JSON.stringify(repo)}
      MAIN_PRD_FILE=${JSON.stringify(prd)}
      JIRA_BASELINE_BRANCH=develop
      LOG_DIR=${JSON.stringify(dir)}
      echo ${JSON.stringify(baseline)} > ${JSON.stringify(join(dir, 'phase-baseline-sha.txt'))}
      VERIFICATION_FAILURE=""
      ${fn}
      _committed_change_uses_helpers "S-1"
      echo "RC=$?"
      echo "VF_SET=\${VERIFICATION_FAILURE:+yes}"
    `], { encoding: 'utf8' });
    return (res.stdout || '') + (res.stderr || '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the committed change is measured, not the working tree', () => {
  it('PASSES when the commit uses every verified helper', () => {
    const out = runCheck({
      helpers: [{ helper: 'alpha', fixVerified: true }, { helper: 'beta', fixVerified: true }],
      committedBody: 'import { alpha } from "a"; import { beta } from "b";',
    });
    expect(out).toContain('RC=0');
  });

  it('FAILS when the commit omits one — the live AMSD-2041 shape', () => {
    // Shipped: one of four. The others were in an earlier pass that the retry discarded.
    const out = runCheck({
      helpers: [
        { helper: 'alpha', fixVerified: true },
        { helper: 'beta', fixVerified: true },
        { helper: 'gamma', fixVerified: true },
      ],
      committedBody: 'import { alpha } from "a";',
    });
    expect(out).not.toContain('RC=0');
    expect(out, 'every missing helper must be named, not just the first').toContain('beta');
    expect(out).toContain('gamma');
    expect(out, 'the writer must receive it as a verification failure').toContain('VF_SET=yes');
  });

  it('ignores helpers whose file is not fixVerified', () => {
    // Unverified entries are guesses; demanding them would fail stories over a candidate
    // the agent correctly ignored. Same filter as the write-time guard.
    const out = runCheck({
      helpers: [{ helper: 'alpha', fixVerified: true }, { helper: 'guess', fixVerified: null }],
      committedBody: 'import { alpha } from "a";',
    });
    expect(out).toContain('RC=0');
  });

  it('passes silently when the story prescribes no verified helper', () => {
    const out = runCheck({
      helpers: [{ helper: '', fixVerified: true }],
      committedBody: 'nothing relevant',
    });
    expect(out).toContain('RC=0');
  });

  it('THE POINT: residue in the tree does not satisfy it — only the commit counts', () => {
    // The live shape. An earlier attempt's work sits in the working tree and contains the
    // helper; the commit does not. A guard reading `git diff <baseline>` sees it and stays
    // silent. This must still fail, because the tree is not what ships.
    const out = runCheck({
      helpers: [{ helper: 'alpha', fixVerified: true }, { helper: 'beta', fixVerified: true }],
      committedBody: 'import { alpha } from "a";',
      uncommittedBody: 'import { beta } from "b";',
    });
    expect(out, 'residue in the working tree satisfied a check that must measure the commit')
      .not.toContain('RC=0');
    expect(out).toContain('beta');
  });

  it('names no symbol of its own', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const start = src.indexOf('_committed_change_uses_helpers() {');
    const fn = src.slice(start, src.indexOf('\n}\n', start)).replace(/^\s*#.*$/gm, '');
    for (const lit of ['Contentstack', 'useContent', 'getContentByKey', 'Stack']) {
      expect(fn, `the check hardcodes '${lit}'`).not.toContain(lit);
    }
  });
});
