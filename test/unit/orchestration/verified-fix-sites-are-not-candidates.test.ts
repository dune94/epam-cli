/**
 * A VERIFIED FIX SITE IS NOT A GUESS, AND THE GATE TREATED THEM THE SAME.
 *
 * Live 2026-08-09. The spec produced four fix sites for gotransit, every one fixVerified:true
 * with a named helper. The writer changed ONE of them — 12 lines — and the story was committed
 * and reported complete, unable to satisfy its own criterion ("the rendered page displays the
 * DRAFT content values") because the fetch path and the context were never touched.
 *
 * verify_story_deliverables passed it by design:
 *
 *     "3 declared, only 1 changed + 2 unchanged: still PASSES — one real change is sufficient,
 *      not a majority requirement"
 *
 * That rule was added for a real defect (AMSD-1820: openspec named 3 CANDIDATE paths, the agent
 * correctly edited 2, and requiring all three would have false-failed a correct story). It is
 * right for candidates and wrong for verified sites — and the gate cannot tell them apart,
 * because it reads technicalNotes.files, a flat list of paths with no verification status.
 *
 * The distinction already exists in the data. fixSiteAnalysis carries fixVerified:true plus the
 * helper that owns the site — the spec did not guess, it confirmed. The pipeline throws that
 * signal away at the one moment it decides whether the work is done.
 *
 * WHY THESE TESTS LOOK LIKE THIS. Asked to review every gate, I ran a mutation sweep asking
 * "does removing this gate's rejection break a test?". Every gate passed. That question finds a
 * gate whose rejection is untested; it cannot find a gate that rejects correctly on the WRONG
 * SET. So each test below enumerates the full set of verified sites and asserts the gate covers
 * all of them, with the candidate cases kept green so the AMSD-1820 fix is not undone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const lift = (n: string) => {
  const i = SRC.indexOf(`${n}() {`);
  expect(i, `${n} not found`).toBeGreaterThan(-1);
  return SRC.slice(i, SRC.indexOf('\n}\n', i) + 3);
};

/**
 * A brownfield repo with N declared files, a chosen subset changed, and a chosen subset marked
 * fixVerified in fixSiteAnalysis.
 */
function scenario(opts: { files: string[]; changed: string[]; verified: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), 'verified-')); dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  mkdirSync(join(dir, 'src'), { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  for (const f of opts.files) writeFileSync(join(dir, f), `export const v = 1; // ${f}\n`);
  git('add', '.'); git('commit', '-qm', 'baseline');
  git('remote', 'add', 'origin', dir);
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  for (const f of opts.changed) writeFileSync(join(dir, f), `export const v = 2; // ${f} CHANGED\n`);

  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    stories: [{
      id: 'S1',
      technicalNotes: { files: opts.files },
      fixSiteAnalysis: opts.files.map(f => ({
        file: f,
        fixVerified: opts.verified.includes(f),
        helper: opts.verified.includes(f) ? `helperFor_${f.replace(/\W/g, '_')}` : '',
      })),
    }],
  }));
  return { dir, prd };
}

function runGate(opts: { files: string[]; changed: string[]; verified: string[] }) {
  const { dir, prd } = scenario(opts);
  const out = execFileSync('bash', ['-c',
    `set +e
     EPAM_BROWNFIELD=1
     PROJECT_ROOT=${JSON.stringify(dir)}
     MAIN_PRD_FILE=${JSON.stringify(prd)} PRD_FILE=${JSON.stringify(prd)} LOG_DIR=${JSON.stringify(dir)}
     JIRA_BASELINE_BRANCH=develop
     VERIFICATION_FAILURE="" DETERMINISTIC_CHECK_FAILURE=0
     warning() { echo "WARN:$*"; }; error() { echo "ERR:$*"; }; success() { :; }; log() { :; }; info() { :; }
     is_truthy() { case "\${1:-}" in true|1|yes) return 0 ;; *) return 1 ;; esac; }
     record_story_outputs() { :; }
     verify_prescribed_helper_used() { return 0; }
     _rejection_repeat_check() { return 1; }
     _get_vendor_dirs() { echo ""; }
${lift('_resolve_deliverable_path')}
${lift('verify_story_deliverables')}
     verify_story_deliverables S1 /dev/null; echo "RC=$?"
     echo "__VF__"; printf '%s' "$VERIFICATION_FAILURE"`,
  ], { encoding: 'utf8' });
  return {
    rc: Number((out.match(/RC=(\d+)/) || [])[1]),
    vf: (out.split('__VF__')[1] ?? '').trim(),
    out,
  };
}

const FOUR = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];

describe('the fixture reproduces the live shape', () => {
  it('four declared files, all verified, one changed', () => {
    const { prd } = scenario({ files: FOUR, changed: [FOUR[0]], verified: FOUR });
    const sites = JSON.parse(readFileSync(prd, 'utf8')).stories[0].fixSiteAnalysis;
    expect(sites.filter((s: { fixVerified: boolean }) => s.fixVerified)).toHaveLength(4);
  });
});

describe('THE DEFECT: every VERIFIED fix site must be addressed', () => {
  it('1 of 4 verified sites changed is rejected — the exact live case', () => {
    expect(
      runGate({ files: FOUR, changed: [FOUR[0]], verified: FOUR }).rc,
      'the story shipped one of four CONFIRMED fix sites and was reported complete',
    ).not.toBe(0);
  });

  it('3 of 4 verified sites changed is still rejected', () => {
    expect(runGate({ files: FOUR, changed: FOUR.slice(0, 3), verified: FOUR }).rc).not.toBe(0);
  });

  it('the message names the verified sites left untouched', () => {
    const { vf } = runGate({ files: FOUR, changed: [FOUR[0]], verified: FOUR });
    for (const f of FOUR.slice(1)) expect(vf, `${f} not named`).toMatch(f);
  });

  it('all 4 verified sites changed passes', () => {
    expect(runGate({ files: FOUR, changed: FOUR, verified: FOUR }).rc).toBe(0);
  });
});

describe('CANDIDATES stay optional — the AMSD-1820 fix is not undone', () => {
  it('3 declared as candidates, only 1 changed: still PASSES', () => {
    // The original rule, preserved exactly: an unverified path is a guess, and demanding it
    // would false-fail a story whose agent correctly ignored it.
    expect(runGate({ files: FOUR.slice(0, 3), changed: [FOUR[0]], verified: [] }).rc).toBe(0);
  });

  it('a mix: all verified sites changed, candidates untouched: PASSES', () => {
    expect(runGate({
      files: FOUR, changed: [FOUR[0], FOUR[1]], verified: [FOUR[0], FOUR[1]],
    }).rc).toBe(0);
  });

  it('a mix: a verified site untouched while candidates changed: FAILS', () => {
    expect(runGate({
      files: FOUR, changed: [FOUR[2], FOUR[3]], verified: [FOUR[0], FOUR[1]],
    }).rc).not.toBe(0);
  });

  it('no fixSiteAnalysis at all falls back to the old rule — one change suffices', () => {
    // Older stories carry no fix-site analysis; they must keep working.
    const { dir, prd } = scenario({ files: FOUR, changed: [FOUR[0]], verified: [] });
    const cfg = JSON.parse(readFileSync(prd, 'utf8'));
    delete cfg.stories[0].fixSiteAnalysis;
    writeFileSync(prd, JSON.stringify(cfg));
    const out = execFileSync('bash', ['-c',
      `set +e
       EPAM_BROWNFIELD=1 PROJECT_ROOT=${JSON.stringify(dir)}
       MAIN_PRD_FILE=${JSON.stringify(prd)} PRD_FILE=${JSON.stringify(prd)} LOG_DIR=${JSON.stringify(dir)}
       JIRA_BASELINE_BRANCH=develop VERIFICATION_FAILURE="" DETERMINISTIC_CHECK_FAILURE=0
       warning() { :; }; error() { :; }; success() { :; }; log() { :; }; info() { :; }
       is_truthy() { case "\${1:-}" in true|1|yes) return 0 ;; *) return 1 ;; esac; }
       record_story_outputs() { :; }; verify_prescribed_helper_used() { return 0; }
       _rejection_repeat_check() { return 1; }; _get_vendor_dirs() { echo ""; }
${lift('_resolve_deliverable_path')}
${lift('verify_story_deliverables')}
       verify_story_deliverables S1 /dev/null; echo "RC=$?"`,
    ], { encoding: 'utf8' });
    expect(Number((out.match(/RC=(\d+)/) || [])[1])).toBe(0);
  });

  it('greenfield is unaffected — existence still suffices', () => {
    const { dir, prd } = scenario({ files: FOUR, changed: [], verified: FOUR });
    const out = execFileSync('bash', ['-c',
      `set +e
       EPAM_BROWNFIELD=0 PROJECT_ROOT=${JSON.stringify(dir)}
       MAIN_PRD_FILE=${JSON.stringify(prd)} PRD_FILE=${JSON.stringify(prd)} LOG_DIR=${JSON.stringify(dir)}
       VERIFICATION_FAILURE="" DETERMINISTIC_CHECK_FAILURE=0
       warning() { :; }; error() { :; }; success() { :; }; log() { :; }; info() { :; }
       is_truthy() { return 1; }
       record_story_outputs() { :; }; verify_prescribed_helper_used() { return 0; }
       _rejection_repeat_check() { return 1; }; _get_vendor_dirs() { echo ""; }
${lift('_resolve_deliverable_path')}
${lift('verify_story_deliverables')}
       verify_story_deliverables S1 /dev/null; echo "RC=$?"`,
    ], { encoding: 'utf8' });
    expect(Number((out.match(/RC=(\d+)/) || [])[1])).toBe(0);
  });
});

describe('determinism', () => {
  it('10x: 1 of 4 verified always fails', () => {
    for (let i = 0; i < 10; i++) {
      expect(runGate({ files: FOUR, changed: [FOUR[0]], verified: FOUR }).rc).not.toBe(0);
    }
  });

  it('10x: 4 of 4 verified always passes', () => {
    for (let i = 0; i < 10; i++) {
      expect(runGate({ files: FOUR, changed: FOUR, verified: FOUR }).rc).toBe(0);
    }
  });
});
