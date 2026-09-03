/**
 * WHAT THE SPEC-REVIEW GATE BLOCKS ON.
 *
 * THE DEFECT, live run 20260804T145419Z. The gate fired for the first time and halted all
 * three lanes before the writer. The verdicts it halted on:
 *
 *   gotransit  needs_review  q=0.78  flags: blind_authoring, unverified_cx_shared_assumptions
 *   upexpress  needs_review  q=0.72  flags: api_shape_uncertainty
 *   metrolinx  needs_review  q=0.65  flags: speckit_derived_vcs_without_code_access,
 *                                            human_review_recommended_by_agent
 *
 * Two of the three scored ABOVE the 0.7 bar. Their review notes were positive — "all four
 * manifest paths verified as EXISTS", "both agents added meaningful, non-overlapping
 * value". They were blocked solely because verdict != "approved".
 *
 * Not one of those flags says the spec is wrong. They say speckit could not read the source
 * files, so a human might want to check. On a brownfield ticket that residual uncertainty
 * is ALWAYS present, so the reviewer effectively never returns "approved" — and a gate that
 * demands it blocks 100% of runs. That contradicts this pipeline's own design, where the VC
 * loop is explicitly "AUTONOMOUS (no human)". A gate that requires human sign-off cannot
 * run unattended, which is the entire point.
 *
 * The condition actually worth stopping for is the one that cost a 120-iteration, ~2M-token
 * loop: a manifest naming a file that does not exist.
 *
 * THAT CONDITION IS COMPUTED, NOT ASKED FOR. It first arrived as a reviewer FLAG
 * (missing_manifest_path), and blocking on it was wrong: sampling the real model four
 * times against an evidence block listing EXISTS for every path, one sample returned the
 * flag anyway. spec-mode-runner.js now stats every declared path with fs.existsSync and
 * records specification.manifestCheck.missing; the gate blocks on that, and the flag is
 * corroboration only.
 *
 * SO: block on (a) a computed missing manifest path, (b) qualityScore below the bar, or
 * (c) a flag a PROJECT declared blocking. A bare needs_review at good quality is
 * advisory — surfaced loudly, not fatal.
 *
 * CONFIGURABLE, never hardcoded:
 *   SPEC_REVIEW_BLOCKING_FLAGS=""                      (comma-separated; default EMPTY)
 *   SPEC_REVIEW_MIN_QUALITY=0.7
 *   SPEC_REVIEW_ENFORCE=0
 *
 * Fixtures below are the REAL verdicts above, not invented ones — the previous version of
 * this gate was specified against verdicts I imagined rather than the ones the reviewer
 * emits. Costs no LLM tokens: the real gate is executed under bash.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const GUARDS = join(REPO_ROOT, 'orchestrations/scripts/lib/story-guards.sh');
const RUNNER_SRC = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');

/** The producer's path, derived — never restated. See gate-reads-what-the-producer-writes. */
function producerVerdictPath(): string[] {
  const m = RUNNER_SRC.match(
    /^\s*(?:const\s+\w+\s*=\s*)?story\.((?:\w+\.)*\w*[Rr]eview\w*)\s*=\s*\{/m,
  );
  expect(m, 'the producer assignment moved').toBeTruthy();
  return (m as RegExpMatchArray)[1].split('.');
}

function nest(path: string[], value: unknown): Record<string, unknown> {
  return path.reduceRight((acc, k) => ({ [k]: acc }), value) as Record<string, unknown>;
}

interface Review {
  verdict?: string;
  qualityScore?: number | null;
  flags?: string[];
  reviewNotes?: string;
}

function story(id: string, r: Review | null, status = 'pending', missing: unknown[] = []) {
  const base = { id, status, ...(r ? nest(producerVerdictPath(), { reviewNotes: '', ...r }) : {}) };
  if (!missing.length) return base;
  // The COMPUTED manifest check, written where spec-mode-runner.js writes it.
  const b = base as Record<string, Record<string, unknown>>;
  b.specification = { ...(b.specification || {}), manifestCheck: { missing, checkedAt: 'x' } };
  return b;
}

const MISSING_ONE = [{ storyId: 'S1', file: 'src/not-there.ts' }];

function runGate(stories: unknown[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-policy-'));
  try {
    const prdFile = join(dir, 'prd.json');
    writeFileSync(prdFile, JSON.stringify({ stories }, null, 2));
    const script = join(dir, 'run.sh');
    writeFileSync(
      script,
      [
        'set -uo pipefail',
        'log(){ echo "$*"; }; info(){ echo "$*"; }',
        'warning(){ echo "WARN: $*"; }; error(){ echo "ERROR: $*" >&2; }',
        'success(){ echo "OK: $*"; }',
        `source ${JSON.stringify(GUARDS)}`,
        `spec_review_gate ${JSON.stringify(prdFile)}`,
        'echo "EXIT:$?"',
      ].join('\n'),
    );
    const r = spawnSync('bash', [script], {
      encoding: 'utf8', timeout: 20000, env: { ...process.env, ...env },
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    return { code: Number((out.match(/EXIT:(\d+)/) || [])[1] ?? -1), out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── The three verdicts that actually halted run 20260804T145419Z ────────────────
const GOTRANSIT: Review = {
  verdict: 'needs_review', qualityScore: 0.78,
  flags: ['blind_authoring', 'unverified_cx_shared_assumptions'],
};
const UPEXPRESS: Review = {
  verdict: 'needs_review', qualityScore: 0.72, flags: ['api_shape_uncertainty'],
};
const METROLINX: Review = {
  verdict: 'needs_review', qualityScore: 0.65,
  flags: ['speckit_derived_vcs_without_code_access', 'human_review_recommended_by_agent'],
};

describe('advisory uncertainty does not block an autonomous pipeline', () => {
  it('THE LIVE HALT: gotransit at 0.78 with advisory flags PASSES', () => {
    const { code, out } = runGate([story('AMSD-2041', GOTRANSIT)]);
    expect(
      code,
      'blocked a spec the reviewer scored 0.78 and described as "meaningful, non-overlapping ' +
        'value" with all manifest paths verified. The reviewer never returns "approved" on a ' +
        'brownfield ticket, so this gate blocks every run.\n' + out,
    ).toBe(0);
  });

  it('THE LIVE HALT: upexpress at 0.72 with an advisory flag PASSES', () => {
    expect(runGate([story('AMSD-2041', UPEXPRESS)]).code).toBe(0);
  });

  it('but it is SURFACED, never silently dropped', () => {
    const { out } = runGate([story('AMSD-2041', GOTRANSIT)]);
    expect(
      out,
      'a needs_review that passes must still be visible — an unreported advisory is a ' +
        'silent failure',
    ).toMatch(/AMSD-2041/);
    expect(out).toMatch(/needs_review/);
  });
});

  // POLICY CHANGE 2026-08-07 (operator decision, after this file's own evidence).
  //
  // Blocking now requires a needs_review verdict AND a flag the reviewer marked
  // severity=blocking. qualityScore is telemetry and never gates.
  //
  // Three rules were tried and each failed against real output: the verdict alone blocks
  // every run (this reviewer never returns "approved" on brownfield); flag presence
  // blocks every run (every flag it has emitted is an uncertainty disclosure —
  // api_shape_uncertainty, human_review_recommended_by_agent); and the score is a number
  // nobody can interrogate, which halted a lane on a 0.02 margin while two cleared.
  // Severity is the distinction that was missing — the reviewer can now say "this is a
  // defect" as distinct from "I could not see this".

describe('a blocking flag stops the run whatever the score says', () => {
  /**
   * THE FLAG IS NOT THE FACT — measured 2026-08-04.
   *
   * This used to block on the reviewer's missing_manifest_path flag. Sampling the real
   * model four times against an evidence block listing EXISTS for every path, one sample
   * returned that flag anyway. A hallucination would then halt a run with a perfectly
   * valid manifest, indistinguishable from a real defect.
   *
   * spec-mode-runner.js now stats every declared path and records the result to
   * specification.manifestCheck.missing. THAT blocks. The flag is corroboration.
   */
  it('THE ~2M-TOKEN CONDITION: a COMPUTED missing path blocks even at a high score', () => {
    const { code, out } = runGate([
      story('S1', { verdict: 'needs_review', qualityScore: 0.95, flags: [] }, 'pending', MISSING_ONE),
    ]);
    expect(
      code,
      'a manifest naming a file that is not on disk reached the writer. That is the ' +
        `condition that cost a 120-iteration, ~2M-token loop.\n${out}`,
    ).not.toBe(0);
  });

  it('it blocks on an APPROVED verdict too — the filesystem outranks the verdict', () => {
    const { code } = runGate([
      story('S1', { verdict: 'approved', qualityScore: 0.99, flags: [] }, 'pending', MISSING_ONE),
    ]);
    expect(code).not.toBe(0);
  });

  it('THE HALLUCINATION: the flag WITHOUT a computed missing path does NOT block', () => {
    const { code, out } = runGate([
      story('S1', { verdict: 'needs_review', qualityScore: 0.95, flags: [{ flag: 'missing_manifest_path', severity: 'blocking' }] }),
    ]);
    expect(
      code,
      'the model contradicted the filesystem and halted a valid run. Measured 1 in 4 ' +
        `samples.\n${out}`,
    ).toBe(0);
  });

  it('the halt NAMES the missing path, so it is actionable', () => {
    const { out } = runGate([
      story('S1', { verdict: 'needs_review', qualityScore: 0.95, flags: [] }, 'pending', MISSING_ONE),
    ]);
    expect(out).toMatch(/src\/not-there\.ts/);
  });

  it('the blocking set is CONFIGURABLE — a project adds its own without touching the engine', () => {
    const s = [story('S1', { verdict: 'needs_review', qualityScore: 0.9, flags: ['api_shape_uncertainty'] })];
    expect(runGate(s).code, 'advisory by default — the default blocking list is empty').toBe(0);
    expect(
      runGate(s, { SPEC_REVIEW_BLOCKING_FLAGS: 'missing_manifest_path,api_shape_uncertainty' }).code,
      'once declared blocking, it must block',
    ).not.toBe(0);
  });


  it('flag matching is case-insensitive and tolerates spacing in the config', () => {
    const s = [story('S1', { verdict: 'needs_review', qualityScore: 0.9, flags: ['Project_Blocker'] })];
    expect(runGate(s, { SPEC_REVIEW_BLOCKING_FLAGS: ' project_blocker , other ' }).code)
      .not.toBe(0);
  });
});

describe('the surrounding contract is unchanged', () => {
  it('a story with NO review does not block — a resumed run skips the spec pass', () => {
    expect(runGate([story('S1', null)]).code).toBe(0);
  });

  it('a null qualityScore with no blocking flag does not block — absent is not zero', () => {
    expect(runGate([story('S1', { verdict: 'needs_review', qualityScore: null, flags: [] })]).code)
      .toBe(0);
  });

  it('a null qualityScore WITH a DECLARED blocking flag still blocks', () => {
    expect(runGate(
      [story('S1', { verdict: 'needs_review', qualityScore: null, flags: ['project_specific_blocker'] })],
      { SPEC_REVIEW_BLOCKING_FLAGS: 'project_specific_blocker' },
    ).code).not.toBe(0);
  });

  it('a null qualityScore WITH a computed missing path still blocks', () => {
    expect(runGate([
      story('S1', { verdict: 'needs_review', qualityScore: null, flags: [] }, 'pending', MISSING_ONE),
    ]).code).not.toBe(0);
  });

  it('a deprecated story is ignored even when it would block', () => {
    expect(runGate([story('S1', { ...METROLINX, flags: [{ flag: 'missing_manifest_path', severity: 'blocking' }] }, 'deprecated')]).code)
      .toBe(0);
  });

  it('SPEC_REVIEW_ENFORCE=0 turns the whole gate off deliberately', () => {
    expect(runGate([story('S1', { verdict: 'needs_review', qualityScore: 0.1, flags: [{ flag: 'missing_manifest_path', severity: 'blocking' }] })],
      { SPEC_REVIEW_ENFORCE: '0' }).code).toBe(0);
  });

  it('ONE blocking story halts the phase even when others are clean', () => {
    const { code, out } = runGate([
      story('S1', GOTRANSIT),
      story('S2', { verdict: 'approved', qualityScore: 0.9, flags: [] }, 'pending',
        [{ storyId: 'S2', file: 'src/not-there.ts' }]),
      story('S3', UPEXPRESS),
    ]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/S2/);
  });

  // SUPERSEDED 2026-08-07: metrolinx blocked here because its score was below the bar.
  // The score is telemetry now — all three lanes carry uncertainty flags only, none declared
  // blocking by the project, so none halts. That is the intended outcome: an autonomous run
  // is not stopped by a reviewer's uncertainty about what it could not see.
  it.skip('all three REAL lane verdicts together: only metrolinx blocks', () => {
    const { code, out } = runGate([
      story('GO', GOTRANSIT), story('UP', UPEXPRESS), story('MX', METROLINX),
    ]);
    expect(code).not.toBe(0);        // metrolinx is genuinely below the bar
    expect(out).toMatch(/MX/);
    expect(out, 'gotransit at 0.78 must not be named as a blocker').not.toMatch(/ERROR.*\bGO\b/);
  });

  it('a malformed PRD is refused, not passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-bad-'));
    try {
      const p = join(dir, 'prd.json');
      writeFileSync(p, '{not json');
      const s = join(dir, 'r.sh');
      writeFileSync(s, [
        'set -uo pipefail',
        'log(){ echo "$*"; }; info(){ echo "$*"; }; warning(){ echo "$*"; }',
        'error(){ echo "ERROR: $*" >&2; }; success(){ echo "$*"; }',
        `source ${JSON.stringify(GUARDS)}`,
        `spec_review_gate ${JSON.stringify(p)}`, 'echo "EXIT:$?"',
      ].join('\n'));
      const r = spawnSync('bash', [s], { encoding: 'utf8', timeout: 20000 });
      const out = `${r.stdout}${r.stderr}`;
      expect(Number((out.match(/EXIT:(\d+)/) || [])[1])).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
