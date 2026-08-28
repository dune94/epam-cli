/**
 * A REJECTION THE NEXT ATTEMPT NEVER SEES IS NOT FEEDBACK.
 *
 * Live 2026-08-09, attempts 2 and 5 of one story, byte-identical:
 *
 *     Story AMSD-2041: the prescribed helper `options` EXISTS in this repository but does NOT
 *     appear in the change. [attempt 2/8 — will retry]
 *     ... [attempt 5/8 — will retry]
 *
 * That morning I "fixed" this guard by making it set VERIFICATION_FAILURE, and I proved the
 * variable was ASSIGNED. It was — and the text still never reached the model. Checked in the
 * live log: the attempt-3 prompt contains ZERO occurrences of "prescribed helper".
 *
 * VERIFICATION_FAILURE alone goes nowhere. claude.sh routes it into
 * COORDINATOR_PROMPT_AMENDMENT — the text the next attempt actually reads — only when
 * DETERMINISTIC_CHECK_FAILURE=1 (the branch at claude.sh:9268). Five deterministic checks set
 * that flag. verify_prescribed_helper_used and verify_story_deliverables set it zero times, so
 * their findings were assigned to a variable and dropped.
 *
 * THIS FILE ASSERTS DELIVERY, NOT ASSIGNMENT. Every test below follows the text to the amendment
 * the next attempt receives. Asserting "the variable is set" is exactly the check that passed
 * this morning while the defect shipped, and it is the reason attempts 2, 3, 4 and 5 were lost
 * to an identical rejection the writer was never told about.
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

const lift = (name: string) => {
  const i = SRC.indexOf(`${name}() {`);
  expect(i, `${name} not found`).toBeGreaterThan(-1);
  return SRC.slice(i, SRC.indexOf('\n}\n', i) + 3);
};

/** A brownfield repo whose change hand-rolls logic instead of using the prescribed helper. */
function repoWithHandRolledChange(useHelper = false) {
  const dir = mkdtempSync(join(tmpdir(), 'guardfb-')); dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  mkdirSync(join(dir, 'src'), { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(dir, 'src', 'helpers.ts'), 'export const buildKey = (a: string) => a;\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  git('remote', 'add', 'origin', dir);
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  writeFileSync(join(dir, 'src', 'a.ts'),
    useHelper ? 'import { buildKey } from "./helpers";\nexport const a = buildKey("x");\n'
              : 'export const a = "x" + "#" + "y";\n');
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    stories: [{ id: 'S1', fixSiteAnalysis: [{ file: 'src/a.ts', fixVerified: true, helper: 'buildKey' }] }],
  }));
  return { dir, prd };
}

/**
 * Runs the guard AND the retry-loop branch that decides what the next attempt is told, then
 * returns the amendment the next prompt would carry.
 */
function feedbackForNextAttempt(useHelper = false) {
  const { dir, prd } = repoWithHandRolledChange(useHelper);
  const out = execFileSync('bash', ['-c',
    `set +e
     EPAM_BROWNFIELD=1
     PROJECT_ROOT=${JSON.stringify(dir)}
     MAIN_PRD_FILE=${JSON.stringify(prd)}
     PRD_FILE=${JSON.stringify(prd)}
     LOG_DIR=${JSON.stringify(dir)}
     VERIFICATION_FAILURE=""
     DETERMINISTIC_CHECK_FAILURE=0
     COORDINATOR_PROMPT_AMENDMENT=""
     warning() { :; }; error() { :; }; log() { :; }; info() { :; }; success() { :; }
     is_truthy() { case "\${1:-}" in true|1|yes) return 0 ;; *) return 1 ;; esac; }
${lift('verify_prescribed_helper_used')}
     verify_prescribed_helper_used S1
     rc=$?

     # The routing the retry loop performs: only a DETERMINISTIC_CHECK_FAILURE reaches the next
     # attempt's prompt (claude.sh:9268). Modelled here so the test follows the text all the way
     # to what the model reads, instead of stopping at the variable.
     if [ "\${DETERMINISTIC_CHECK_FAILURE:-0}" -eq 1 ]; then
       COORDINATOR_PROMPT_AMENDMENT="## Deterministic Check Failure
\${VERIFICATION_FAILURE}"
     fi
     echo "RC=$rc"
     echo "__AMENDMENT__"
     printf '%s' "$COORDINATOR_PROMPT_AMENDMENT"`,
  ], { encoding: 'utf8' });
  return {
    rc: Number((out.match(/RC=(\d+)/) || [])[1]),
    amendment: (out.split('__AMENDMENT__')[1] ?? '').trim(),
  };
}

describe('the fixture really trips the guard', () => {
  it('the change hand-rolls instead of using the helper, and is rejected', () => {
    expect(feedbackForNextAttempt(false).rc).not.toBe(0);
  });

  it('a change that uses the helper is accepted', () => {
    expect(feedbackForNextAttempt(true).rc).toBe(0);
  });
});

describe('THE DEFECT: the rejection reaches the next attempt', () => {
  it('the next attempt is told something at all', () => {
    expect(
      feedbackForNextAttempt(false).amendment,
      'the writer is rejected and the next prompt is unchanged — attempts 2 and 5 were ' +
      'byte-identical live for exactly this reason',
    ).not.toBe('');
  });

  it('and is told WHICH helper to use', () => {
    expect(feedbackForNextAttempt(false).amendment).toMatch(/buildKey/);
  });

  it('the message explains what to do, not merely that it failed', () => {
    expect(feedbackForNextAttempt(false).amendment).toMatch(/import|use/i);
  });

  it('a passing change leaves the next attempt uncontaminated', () => {
    // Stale rejection text is worse than none: it is what the next diagnosis is built from.
    expect(feedbackForNextAttempt(true).amendment).toBe('');
  });
});

describe('the guard sets the flag that does the routing', () => {
  const body = () => lift('verify_prescribed_helper_used');

  it('verify_prescribed_helper_used raises DETERMINISTIC_CHECK_FAILURE', () => {
    // Without this flag VERIFICATION_FAILURE is assigned and dropped — the whole defect.
    expect(body()).toMatch(/DETERMINISTIC_CHECK_FAILURE=1/);
  });

  it('verify_story_deliverables does too', () => {
    expect(lift('verify_story_deliverables')).toMatch(/DETERMINISTIC_CHECK_FAILURE=1/);
  });

  it('and exports it, so the retry loop in the same shell sees it', () => {
    expect(body()).toMatch(/export DETERMINISTIC_CHECK_FAILURE/);
  });
});

/**
 * The block above models the routing. This runs the REAL one, lifted from claude.sh, so the test
 * cannot pass against a model of the pipeline that has drifted from the pipeline.
 */
describe('through the SHIPPED routing branch, not a model of it', () => {
  /** Lifts the actual `if [ "${DETERMINISTIC_CHECK_FAILURE:-0}" -eq 1 ]` block. */
  function shippedRouting(): string {
    const marker = 'if [ "${DETERMINISTIC_CHECK_FAILURE:-0}" -eq 1 ]; then';
    const i = SRC.indexOf(marker);
    expect(i, 'the routing branch was not found — pinned to stale text').toBeGreaterThan(-1);
    const endMark = '## Deterministic Check Failure';
    const j = SRC.indexOf(endMark, i);
    expect(j, 'the amendment assignment moved').toBeGreaterThan(i);
    // Take through the end of the amendment assignment.
    const close = SRC.indexOf('}"', j);
    return SRC.slice(i, close + 2) + '\nfi\n';
  }

  function routeThroughShipped(verificationFailure: string, flag: 0 | 1) {
    const dir = mkdtempSync(join(tmpdir(), 'shiproute-')); dirs.push(dir);
    const out = execFileSync('bash', ['-c',
      `set +e
       DETERMINISTIC_CHECK_FAILURE=${flag}
       # Passed through the ENVIRONMENT, not interpolated: the guard's real message contains
       # backticks around the helper name, and inside a double-quoted bash assignment those are
       # command substitution — bash ran \`buildKey\` and substituted nothing, so the test
       # reported the shipped branch had dropped the finding when the harness had eaten it.
       VERIFICATION_FAILURE="$VF_IN"
       COORDINATOR_PROMPT_AMENDMENT=""
       _existing_amendment=""
       _last_fa_diagnosis="(none)"
       _prev_deterministic_violation=""
       story_id=S1
       LOG_DIR=${JSON.stringify(dir)}
       _heal_log=${JSON.stringify(join(dir, 'heal.jsonl'))}
       same_root_cause_diagnoses() { echo false; }
       error() { :; }; warning() { :; }; log() { :; }
${shippedRouting()}
       echo "__AMENDMENT__"
       printf '%s' "$COORDINATOR_PROMPT_AMENDMENT"`,
    ], { encoding: 'utf8', env: { ...process.env, VF_IN: verificationFailure } });
    return (out.split('__AMENDMENT__')[1] ?? '').trim();
  }

  it('a flagged failure reaches the amendment verbatim', () => {
    const text = '\n## Verification Failure\n\nThe prescribed helper `buildKey` EXISTS...';
    const amendment = routeThroughShipped(text, 1);
    expect(amendment, 'the shipped branch dropped the finding').toMatch(/buildKey/);
    expect(amendment).toMatch(/Deterministic Check Failure/);
  });

  it('an UNflagged failure reaches nothing — which is the whole defect', () => {
    const text = '\n## Verification Failure\n\nThe prescribed helper `buildKey` EXISTS...';
    expect(
      routeThroughShipped(text, 0),
      'this is the state the guards were in all day: text assigned, flag unset, nothing delivered',
    ).toBe('');
  });

  it('the routing tells the writer the check ran before the tests', () => {
    expect(routeThroughShipped('\n## Verification Failure\n\nx', 1)).toMatch(/before the test suite/i);
  });
});
