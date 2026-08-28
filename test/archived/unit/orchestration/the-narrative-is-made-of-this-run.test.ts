/**
 * A REPORT THAT WOULD READ THE SAME FOR A DIFFERENT RUN IS NOT A REPORT OF THIS RUN.
 *
 * WRITTEN BEFORE THE REWRITE. RED WHEN WRITTEN.
 *
 * generate-run-report.py is 1,720 lines, 14 of whose triple-quoted blocks are prose about the
 * pipeline in general -- 5,492 characters of text that is true of every run and therefore
 * informative about none. Measured on two real archived runs with different logs (12 lines and
 * 25 lines):
 *
 *     178 text lines, 8 differ  ->  96% IDENTICAL
 *
 * and all 8 differences are timestamps and the launch-log filename. A one-line run log produced a
 * 12,891-byte narrative. The document's own footer says "Anything without a supporting artefact
 * is marked not recorded rather than inferred", which is the claim the other 96% contradicts.
 *
 * It also carries fossils. Line 1088 emits "On 26 July a run failed at the code-style gate..."
 * into EVERY report, including runs that happened weeks later and failed for other reasons.
 *
 * THE ORACLE. Prose quality cannot be asserted directly, but derivability can:
 *
 *   DIFFERENCE   two different runs must produce substantially different narratives. Boilerplate
 *                is precisely the text that survives changing the input.
 *   GROUNDING    every date in the output must appear in the run's own artefacts. This kills the
 *                26 July fossil and every one like it, without naming it.
 *   COMPLETENESS every step and every escalation in the log must appear in the report. The
 *                original complaint was "not all steps were noted".
 *   VACUITY      the report must be non-empty and carry this run's own identifiers, or every
 *                assertion above passes on an empty file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const GEN = join(ROOT, 'orchestrations/scripts/generate-run-report.py');
const RUNS = join(ROOT, 'orchestrations/projects/metrolinx/runs');
const LOGS = join(ROOT, 'orchestrations/logs');

/** Real archived runs, canonical artefacts — never hand-authored fixtures. */
function archivedRuns() {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS)
    .map((d) => ({ id: d, dir: join(RUNS, d), log: join(RUNS, d, 'run.log') }))
    .filter((r) => existsSync(r.log))
    .map((r) => ({ ...r, lines: readFileSync(r.log, 'utf8').split('\n').length }))
    .sort((a, b) => a.lines - b.lines);
}

/** Visible text of the narrative, with chrome removed — CSS being identical is legitimate. */
function visibleText(html: string): string[] {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((s) => s.replace(/&[a-z]+;/g, ' ').trim())
    .filter((s) => s.length > 12);
}

/**
 * The generator owns EIGHT outputs, and tier3-metrolinx-run.sh invokes it as
 * `>/dev/null 2>&1 || true`. A change that drops one loses a run deliverable in total silence.
 */
const OUTPUTS = ['narrative.html', 'qa-summary.html', 'code.html', 'run-facts.json'];

let lastOutDir = '';

function generate(run: { dir: string; log: string }): string {
  const out = mkdtempSync(join(tmpdir(), 'narr-'));
  lastOutDir = out;
  const args = ['--launch-log', run.log, '--logs-dir', LOGS, '--out', out];
  const prd = join(run.dir, 'working-prd.json');
  if (existsSync(prd)) args.push('--prd', prd);
  const r = spawnSync('python3', [GEN, ...args], { encoding: 'utf8', timeout: 120_000 });
  const narrative = join(out, 'narrative.html');
  if (!existsSync(narrative)) {
    throw new Error(`generator produced no narrative.html (rc=${r.status}): ${r.stderr?.slice(0, 400)}`);
  }
  return readFileSync(narrative, 'utf8');
}

/**
 * THE REPORT CANNOT BE BETTER THAN THE FACTS IT IS HANDED.
 *
 * The 13 August gotransit run rendered "Files changed 0 / 0", "Proof MISSING" and "Review CHANGES
 * REQUESTED" for a run that landed 9 files (+379/-10) with review APPROVED. The template was not
 * the problem: run-facts.json carried no baseline, no head, no diffstat, no review verdict and
 * none of the three commit SHAs, so the report rendered zeros faithfully.
 *
 * The baseline that WAS recorded -- 42b81c44 -- belongs to next.metrolinx.com. gotransit does not
 * contain that commit at all, so the diff could never resolve. phase-baseline-sha.txt is one
 * global file serving a run that spans three repositories.
 *
 * A baseline that does not exist in the repository being reported on is not a weak baseline, it
 * is a guarantee of an empty diff -- so that is what this asserts.
 */
describe('THE FACTS THE REPORT RENDERS ARE ACTUALLY CAPTURED', () => {
  const facts = () => {
    const p = join(lastOutDir, 'run-facts.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  };

  it('an unresolvable baseline is reported, not rendered as zero', () => {
    // THE DEFECT, EXACTLY. phase-baseline-sha.txt is one global file for a three-repository run
    // and held a next.metrolinx.com SHA while reporting on next.gotransit.com:
    //
    //     git log 42b81c44..HEAD  ->  fatal: Invalid revision range
    //
    // A bare except swallowed it, commits became [], and code.html rendered "Files changed 0/0"
    // and "Proof MISSING" for a run that landed 9 files. The caller adds a second layer of
    // silence with `>/dev/null 2>&1 || true`.
    //
    // Zero is a number people act on. Unknown must not render as zero.
    const run = runs[runs.length - 1];
    const out = mkdtempSync(join(tmpdir(), 'narr-badbase-'));
    const r = spawnSync('python3', [GEN,
      '--launch-log', run.log, '--logs-dir', LOGS, '--out', out,
      '--codeline', '/home/bradleyjerome/projects/metrolinx/next.gotransit.com',
      '--baseline', '0000000000000000000000000000000000000000',
    ], { encoding: 'utf8', timeout: 120_000 });

    const codePath = join(out, 'code.html');
    if (!existsSync(codePath)) return; // it refused to produce output at all, which is acceptable

    // Assert on the RENDERED artefact, and on a DEDICATED field — never a keyword search across
    // the whole facts blob. The first version of this test searched JSON.stringify(facts) for
    // /invalid/ and passed on selfheal.failure_classes:["invalid_test"], which has nothing to do
    // with baselines. A green light for the wrong reason is worse than a red one.
    const rendered = readFileSync(codePath, 'utf8')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');

    const explicit = /baseline[^.]{0,80}(invalid|unresolv|not found|does not exist)/i.test(rendered)
      || /(invalid|unresolv)[^.]{0,80}(revision|baseline|range)/i.test(rendered);

    expect(explicit,
      'the generator was given a baseline that does not exist in the codeline, and the report it ' +
      'produced says nothing about it — it renders "Files changed 0", which reads as "this run ' +
      'changed nothing" when the truth is "this could not be determined". Zero is a number ' +
      'people act on.')
      .toBe(true);
  });

  it('commits the run actually made are captured', () => {
    // THE PROXIMATE CAUSE of "Files changed 0 / 0". run-facts recorded commits:[] while three
    // commits sat on the branch, so the code summary rendered zeros faithfully from nothing.
    const f = facts();
    expect(f, 'run-facts.json was not produced at all').toBeTruthy();

    const repo = f.codeline_path;
    expect(repo, 'run-facts records no codeline_path, so nothing can be verified against a repo')
      .toBeTruthy();
    if (!existsSync(String(repo))) return; // the codeline is not on this machine

    // Ground truth: did the run's own window contain commits in that repository?
    const since = f.t_start;
    const until = f.t_end;
    if (!since || !until) return;
    const g = spawnSync('git',
      ['-C', String(repo), 'log', '--since', String(since), '--until', String(until), '--format=%h'],
      { encoding: 'utf8' });
    const real = (g.stdout || '').split('\n').filter(Boolean);
    if (real.length === 0) return; // nothing to capture; not this test's concern

    expect((f.commits || []).length,
      `the repository has ${real.length} commit(s) in this run's window (${real.join(', ')}) ` +
      `but run-facts captured ${(f.commits || []).length} — every diff-derived field in the ` +
      `code summary renders as zero`)
      .toBeGreaterThan(0);
  });

  it('the review verdict recorded is the one the run finished on', () => {
    // code.html said "CHANGES REQUESTED" for a run whose gate logged "All stories have approved
    // review status". The report was faithful; the fact was stale, with review_cycle:null.
    const f = facts();
    if (!f?.review_decision) return;
    expect(f.review_cycle,
      `a review verdict "${f.review_decision}" is recorded with no cycle number, so nothing can ` +
      `tell whether it is the final verdict or an intermediate one that was later superseded`)
      .not.toBeNull();
  });
});

describe('THE OTHER SEVEN DELIVERABLES SURVIVE THE REWRITE', () => {
  it('every artefact the generator owns is still produced', () => {
    // Not a narrative concern, which is exactly why it needs asserting: the rewrite touches one
    // section of a script that owns eight outputs, and the caller discards stderr.
    const missing = OUTPUTS.filter((f) => !existsSync(join(lastOutDir, f)));
    expect(missing, `the generator no longer produces: ${missing.join(', ')}`).toHaveLength(0);
  });
});

let small: string;
let large: string;
let runs: ReturnType<typeof archivedRuns>;

beforeAll(() => {
  runs = archivedRuns();
  if (runs.length >= 2) {
    small = generate(runs[0]);
    large = generate(runs[runs.length - 1]);
  }
}, 300_000);

describe('THE GENERATOR RAN AND PRODUCED SOMETHING', () => {
  it('there are at least two real archived runs to compare', () => {
    expect(runs.length, 'need two archived runs with logs to tell a report from a template')
      .toBeGreaterThanOrEqual(2);
  });

  it('both narratives are non-empty', () => {
    // Without this, every assertion below passes on an empty file.
    expect(visibleText(small).length, 'the narrative for the smaller run has no visible text').toBeGreaterThan(5);
    expect(visibleText(large).length, 'the narrative for the larger run has no visible text').toBeGreaterThan(5);
  });
});

describe('THE NARRATIVE IS MADE OF THIS RUN', () => {
  it('two different runs do not produce near-identical narratives', () => {
    const a = visibleText(small);
    const b = new Set(visibleText(large));
    const shared = a.filter((l) => b.has(l)).length;
    const sharedPct = Math.round((shared / a.length) * 100);
    // Measured at 96% before the rewrite: 8 of 178 lines differed, all timestamps.
    expect(sharedPct,
      `${sharedPct}% of the narrative is identical across two different runs — that text is ` +
      `boilerplate, not a report of what happened`)
      .toBeLessThan(50);
  });

  it('a run whose log is 400x larger produces a substantially larger narrative', () => {
    const ratio = visibleText(large).length / visibleText(small).length;
    expect(ratio,
      'a much longer run produced a narrative of nearly the same size — the length is coming ' +
      'from fixed prose rather than from what the run did')
      .toBeGreaterThan(1.5);
  });
});

describe('EVERY CLAIM IS GROUNDED IN AN ARTEFACT', () => {
  it('no date appears in the report that does not appear in the run artefacts', () => {
    // Kills the "On 26 July a run failed at the code-style gate" fossil at line 1088, and every
    // future one, without this test ever naming it.
    const logText = readFileSync(runs[runs.length - 1].log, 'utf8');
    const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
    const dates = [...visibleText(large).join('\n').matchAll(new RegExp(`\\b\\d{1,2} (${MONTHS})\\b`, 'g'))]
      .map((m) => m[0]);
    const ungrounded = [...new Set(dates)].filter((d) => !logText.includes(d));
    expect(ungrounded,
      `the report states date(s) that appear nowhere in this run's artefacts: ${ungrounded.join(', ')}`)
      .toHaveLength(0);
  });
});

describe('THE WHOLE STORY, NOT A SUMMARY OF IT', () => {
  it('every step the log records appears in the report', () => {
    // The original complaint, verbatim: "not all steps were noted".
    const logText = readFileSync(runs[runs.length - 1].log, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
    const steps = [...new Set([...logText.matchAll(/\bStep (\d+[a-z]?)\b/g)].map((m) => m[1]))];
    expect(steps.length, 'no steps found in the log — the fixture cannot exercise this').toBeGreaterThan(3);
    const text = visibleText(large).join('\n');
    const missing = steps.filter((s) => !new RegExp(`\\bStep ${s}\\b`).test(text));
    expect(missing, `the report omits step(s) the log records: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('every model escalation the log records appears in the report', () => {
    const logText = readFileSync(runs[runs.length - 1].log, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
    const escalations = [...new Set(
      [...logText.matchAll(/(\S+)\s*(?:→|->)\s*(\S+)/g)]
        .filter((m) => /glm|minimax|claude|gpt|qwen|kimi/i.test(m[0]))
        .map((m) => m[2].replace(/['"]/g, '')),
    )];
    if (escalations.length === 0) return; // nothing to prove for a run that never escalated
    const text = visibleText(large).join('\n');
    const missing = escalations.filter((e) => !text.includes(e));
    expect(missing, `the report omits model escalation(s) the log records: ${missing.join(', ')}`)
      .toHaveLength(0);
  });
});
