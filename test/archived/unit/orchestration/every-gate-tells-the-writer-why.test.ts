/**
 * A GATE THAT REJECTS THE WRITER MUST TELL IT WHY.
 *
 * Three times in one day a gate blocked the writer and never said what to fix:
 *
 *   - the coverage gate, which logged a block it never enforced
 *   - run_repo_lint_verification, which wrote to the agent's OUTPUT log instead of the prompt
 *   - verify_prescribed_helper_used, live 2026-08-09: attempts 1 and 2 produced the IDENTICAL
 *     violation, because the rejection reached the log and the model ladder but never the model
 *
 * Each was found by watching a live run fail, one at a time, which is the wrong instrument. They
 * are one class, and the class is testable: VERIFICATION_FAILURE is the variable the failure
 * analyst reads and turns into COORDINATOR_PROMPT_AMENDMENT — the text the next attempt actually
 * sees. A gate that returns non-zero without setting it is inert no matter how correct its
 * detection is, and inert is the DEFAULT state, so it has to be asserted rather than assumed.
 *
 * STORY_REJECTION_KEY is not a substitute. _rejection_repeat_check reads it to notice an
 * identical rejection twice and advance the model ladder — so the loop escalates to a stronger
 * model and asks it to guess again, with the reason still withheld. That is what burned attempts
 * 1 and 2 live, and would have burned all eight.
 *
 * Two layers here, deliberately:
 *
 *   1. BEHAVIOURAL — each gate is executed against a repository shaped to trip it, and the
 *      variable is read back out of the shell it ran in. That is the only thing that proves a
 *      real rejection produces real feedback.
 *   2. STRUCTURAL — a sweep asserting no NEW gate joins the class. It cannot replace layer 1
 *      (text in a file proves nothing about behaviour), but it catches the next gate someone
 *      adds before a live run does. The predicates that legitimately return non-zero without
 *      rejecting anything are named explicitly, with the reason each is exempt.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function lift(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  expect(start, `${name} not found in claude.sh`).toBeGreaterThan(-1);
  return SRC.slice(start, SRC.indexOf('\n}\n', start) + 3);
}

/** A brownfield repo with a baseline commit and a change that does NOT use the helper. */
function repoWithChange(opts: { useHelper?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gatefb-')); dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  mkdirSync(join(dir, 'src'), { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  // The helper exists in the repository — that is what makes hand-rolling a defect.
  writeFileSync(join(dir, 'src', 'helpers.ts'), 'export const buildKey = (a: string) => a;\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  git('branch', '-f', 'develop');
  git('remote', 'add', 'origin', dir);
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  writeFileSync(join(dir, 'src', 'a.ts'),
    opts.useHelper
      ? 'import { buildKey } from "./helpers";\nexport const a = buildKey("x");\n'
      : 'export const a = "x" + "#" + "y";\n');   // hand-rolled instead of reusing buildKey
  return dir;
}

/** PRD declaring a verified fix site whose helper is `buildKey`. */
function prdWithHelper(dir: string, files: string[] = []) {
  const p = join(dir, 'prd.json');
  writeFileSync(p, JSON.stringify({
    stories: [{
      id: 'S1',
      fixSiteAnalysis: [{ file: 'src/a.ts', fixVerified: true, helper: 'buildKey' }],
      technicalNotes: { files },
    }],
  }, null, 2));
  return p;
}

/** Runs a gate and reports its exit code plus whatever it left in VERIFICATION_FAILURE. */
function runGate(fnNames: string[], call: string, env: Record<string, string>, cwd?: string) {
  const res = execFileSync('bash', ['-c',
    `set -u
     log() { :; }; info() { :; }; success() { :; }
     warning() { echo "WARN:$*"; }; error() { echo "ERR:$*"; }
     is_truthy() { case "\${1:-}" in true|1|yes) return 0 ;; *) return 1 ;; esac; }
     VERIFICATION_FAILURE=""
     ${Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n     ')}
${fnNames.map(lift).join('\n')}
     ${call}; echo "RC=$?"
     echo "__VF__"; printf '%s' "$VERIFICATION_FAILURE"`,
  ], { encoding: 'utf8', cwd: cwd ?? process.cwd() });
  return {
    rc: Number((res.match(/RC=(\d+)/) || [])[1]),
    vf: (res.split('__VF__')[1] ?? '').trim(),
    out: res,
  };
}

describe('the fixtures really do trip the gates', () => {
  it('the helper exists in the repo and the change does not use it', () => {
    const dir = repoWithChange();
    expect(readFileSync(join(dir, 'src', 'helpers.ts'), 'utf8')).toContain('buildKey');
    expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).not.toContain('buildKey');
  });

  it('and the gate does reject it — otherwise every assertion below is vacuous', () => {
    const dir = repoWithChange();
    const r = runGate(['verify_prescribed_helper_used'], 'verify_prescribed_helper_used S1',
      { EPAM_BROWNFIELD: '1', PROJECT_ROOT: dir, MAIN_PRD_FILE: prdWithHelper(dir), LOG_DIR: dir });
    expect(r.rc).not.toBe(0);
  });
});

describe('verify_prescribed_helper_used', () => {
  const trip = () => {
    const dir = repoWithChange();
    return runGate(['verify_prescribed_helper_used'], 'verify_prescribed_helper_used S1',
      { EPAM_BROWNFIELD: '1', PROJECT_ROOT: dir, MAIN_PRD_FILE: prdWithHelper(dir), LOG_DIR: dir });
  };

  it('sets VERIFICATION_FAILURE when it rejects', () => {
    expect(
      trip().vf,
      'live 2026-08-09: attempts 1 and 2 produced the identical violation because of this',
    ).not.toBe('');
  });

  it('names the helper the writer is supposed to use', () => {
    expect(trip().vf).toContain('buildKey');
  });

  it('uses the heading the failure analyst parses', () => {
    expect(trip().vf).toContain('## Verification Failure');
  });

  it('leaves it empty when the change DOES use the helper', () => {
    const dir = repoWithChange({ useHelper: true });
    const r = runGate(['verify_prescribed_helper_used'], 'verify_prescribed_helper_used S1',
      { EPAM_BROWNFIELD: '1', PROJECT_ROOT: dir, MAIN_PRD_FILE: prdWithHelper(dir), LOG_DIR: dir });
    expect(r.rc).toBe(0);
    expect(r.vf, 'stale failure text is what the analyst then diagnoses from').toBe('');
  });
});

describe('verify_story_deliverables', () => {
  const trip = () => {
    const dir = repoWithChange({ useHelper: true });   // helper guard must not fire
    const prd = prdWithHelper(dir, ['src/does-not-exist.ts']);
    return runGate(
      ['verify_story_deliverables', 'verify_prescribed_helper_used', '_resolve_deliverable_path',
       '_get_vendor_dirs', 'record_story_outputs', '_rejection_repeat_check'],
      'verify_story_deliverables S1 /dev/null',
      { EPAM_BROWNFIELD: '1', PROJECT_ROOT: dir, MAIN_PRD_FILE: prd, PRD_FILE: prd, LOG_DIR: dir });
  };

  it('rejects a story whose declared deliverable does not exist', () => {
    expect(trip().rc, 'the fixture does not trip the gate').not.toBe(0);
  });

  it('sets VERIFICATION_FAILURE naming the missing file', () => {
    const { vf } = trip();
    expect(vf, 'the writer is rejected without being told which file is missing').not.toBe('');
    expect(vf).toContain('src/does-not-exist.ts');
  });

  it('uses the heading the failure analyst parses', () => {
    expect(trip().vf).toContain('## Verification Failure');
  });
});

describe('STRUCTURAL: no new gate joins the inert class', () => {
  /**
   * Exempt by inspection, each for a stated reason. A predicate answering a question is not a
   * gate rejecting work, and a phase-level aggregate is not per-attempt feedback.
   */
  const EXEMPT: Record<string, string> = {
    check_plan_mode_required: 'a PREDICATE: returns 1 to mean "plan mode is not required"',
    run_implementation: 'phase-level aggregate over all stories, not a per-attempt rejection',
    run_change_with_reviewer_retry: 'reviews a proposed skill-note/KB change, not writer output',
    run_failure_analyst:
      'DIAGNOSES a failure, never rejects the writer. Returns 1 when it cannot build its own ' +
      'project-authority prompt — the same "proceed without analyst guidance" posture it already ' +
      'takes when all 3 response attempts are unparseable. VERIFICATION_FAILURE is its INPUT, ' +
      'not its output; setting it here would overwrite the very failure being diagnosed.',
  };

  function rejectingGates(): string[] {
    const out: string[] = [];
    const re = /^([a-z_][a-z0-9_]*)\(\) \{\n/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(SRC))) {
      const name = m[1];
      if (!/^(run_|verify_|check_)/.test(name)) continue;
      const body = SRC.slice(m.index, SRC.indexOf('\n}\n', m.index));
      if (!/^\s*return 1\b/m.test(body)) continue;
      out.push(name);
    }
    return out;
  }

  it('every rejecting gate either sets VERIFICATION_FAILURE or is explicitly exempt', () => {
    const offenders = rejectingGates().filter((name) => {
      if (name in EXEMPT) return false;
      const i = SRC.indexOf(`${name}() {`);
      return !SRC.slice(i, SRC.indexOf('\n}\n', i)).includes('VERIFICATION_FAILURE=');
    });
    expect(
      offenders,
      'these reject the writer without telling it why — add the feedback, or add an exemption ' +
      'with a reason if the non-zero return is not a rejection',
    ).toEqual([]);
  });

  it('the exemption list has not gone stale', () => {
    // An exemption for a function that no longer exists hides the next real offender.
    const all = new Set(rejectingGates());
    for (const name of Object.keys(EXEMPT)) {
      expect(all.has(name), `${name} is exempted but no longer a rejecting gate`).toBe(true);
    }
  });

  it('the sweep actually finds gates — a broken regex would pass everything', () => {
    const found = rejectingGates();
    expect(found.length).toBeGreaterThan(5);
    expect(found).toContain('run_tsc_verification');
    expect(found).toContain('verify_prescribed_helper_used');
  });
});
