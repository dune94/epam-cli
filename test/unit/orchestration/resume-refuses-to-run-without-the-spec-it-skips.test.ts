/**
 * A RESUME THAT SKIPS THE SPEC PASS MUST VERIFY THE SPEC IS STILL THERE.
 *
 * Live, 2026-08-10. A run was launched WITHOUT EPAM_RESUME_RUN, so it took the fresh path,
 * re-ingested Jira, and overwrote orchestrations/projects/metrolinx/prd.json with a newly
 * synthesized one. That cost the story everything the spec pass had produced:
 *
 *     fixSiteAnalysis        13 -> 0
 *     verificationCriteria   14 -> 0
 *     technicalNotes.files   13 -> 0
 *     specification          present -> absent      (1,047 lines)
 *
 * The next launch resumed correctly, and resume_skip_env duly exported EPAM_SPEC_MODE=0 —
 * "the spec pass already ran, skip it". It had run. Its output no longer existed. The writer
 * was handed a story with no fix sites, no declared files and no verification criteria, and
 * told to implement it.
 *
 * It cost $11.76 of OpenRouter spend across 23 writer invocations, 10 of them killed by the
 * 30-minute watchdog, 1,725 file reads of which 84% were re-reads of files already in context.
 * The signature is unmistakable in hindsight: the earlier, spec-carrying run rejected attempts
 * with "2 VERIFIED fix site(s) left unchanged", while the blind run could only ever produce the
 * generic "deliverables are incomplete" — it had no fix sites to name.
 *
 * The engine already refuses to guess in the two neighbouring cases. restore_run_checkpoint
 * failing is fatal; resume_skip_env failing is fatal. "The thing I am skipping past produced
 * output that has since vanished" was the third case, and it was silent — because skipping a
 * phase and verifying that phase's output still exists were never the same question.
 *
 * The check is deliberately about PRESENCE, not content: any of the spec pass's own output
 * fields being populated proves it ran and survived. It names no story, no file and no
 * codeline — a PRD for any project passes it the moment its spec pass has left anything behind.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function lift(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{$`, 'm').exec(SRC);
  expect(m, `no definition for ${name}()`).toBeTruthy();
  const i = (m as RegExpExecArray).index;
  const end = SRC.indexOf('\n}\n', i);
  expect(end, `unterminated ${name}()`).toBeGreaterThan(-1);
  return SRC.slice(i, end + 3);
}

/** A PRD carrying whatever spec-pass output the case wants to model. */
function prd(story: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'resumespec-')); dirs.push(dir);
  const p = join(dir, 'prd.json');
  writeFileSync(p, JSON.stringify({ stories: [{ id: 'S1', title: 't', ...story }] }, null, 2));
  return p;
}

/** Runs the real guard against a PRD and reports whether it refused. */
function guard(prdPath: string, env: Record<string, string> = {}) {
  const res = execFileSync('bash', ['-c',
    `set -u
     error() { echo "ERR:$*"; }; info() { echo "INFO:$*"; }
     warning() { echo "WARN:$*"; }; success() { echo "OK:$*"; }
     NODE_BIN=${JSON.stringify(process.execPath)}
     PRD_FILE=${JSON.stringify(prdPath)}
     EPAM_RESUME_RUN=20260809T045158Z
     ${Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n     ')}
${lift('resume_spec_output_present')}
     if resume_spec_output_present "$PRD_FILE"; then echo "VERDICT=present"; else echo "VERDICT=missing"; fi`,
  ], { encoding: 'utf8' });
  return { present: /VERDICT=present/.test(res), out: res };
}

describe('the guard recognises surviving spec output', () => {
  it('fixSiteAnalysis alone is proof the spec pass survived', () => {
    expect(guard(prd({ fixSiteAnalysis: [{ file: 'a.ts', fixVerified: true }] })).present).toBe(true);
  });

  it('verificationCriteria alone is proof', () => {
    expect(guard(prd({ verificationCriteria: [{ id: 'VC1', text: 'x' }] })).present).toBe(true);
  });

  it('declared files alone are proof', () => {
    expect(guard(prd({ technicalNotes: { files: ['src/a.ts'] } })).present).toBe(true);
  });

  it('a specification block alone is proof', () => {
    expect(guard(prd({ specification: { summary: 'anything' } })).present).toBe(true);
  });
});

describe('THE DEFECT: an emptied PRD is detected instead of implemented against', () => {
  it('the exact shape the overwrite produced is refused', () => {
    // Every spec-pass field emptied, everything else intact — the PRD read as valid to every
    // other check in the pipeline, which is why nothing noticed.
    const p = prd({
      acceptanceCriteria: ['works'],
      agentRole: 'contentstack-live-preview-integration-engineer',
      fixSiteAnalysis: [], verificationCriteria: [], technicalNotes: { files: [] },
    });
    expect(
      guard(p).present,
      'this is the PRD that produced 23 invocations and $11.76 of spend with nothing to aim at',
    ).toBe(false);
  });

  it('a PRD with no spec fields at all is refused', () => {
    expect(guard(prd({ acceptanceCriteria: ['works'] })).present).toBe(false);
  });

  it('an unreadable or absent PRD is refused, not assumed fine', () => {
    expect(guard('/nonexistent/prd.json').present).toBe(false);
  });

  it('malformed JSON is refused rather than throwing the guard open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resumespec-bad-')); dirs.push(dir);
    const p = join(dir, 'prd.json');
    writeFileSync(p, '{ not json');
    expect(guard(p).present).toBe(false);
  });
});

describe('the guard is wired into the resume path, and only fires when the spec is skipped', () => {
  it('the resume block calls it', () => {
    const i = SRC.indexOf('if is_parent && [ -n "${EPAM_RESUME_RUN:-}" ]; then');
    expect(i, 'the resume block moved').toBeGreaterThan(-1);
    const block = SRC.slice(i, SRC.indexOf('\nfi\n', i));
    expect(
      block,
      'the resume proceeds without checking that the spec it skips past still exists',
    ).toContain('resume_spec_output_present');
  });

  it('it refuses — exits non-zero — rather than warning and continuing', () => {
    const i = SRC.indexOf('resume_spec_output_present "$PRD_FILE"');
    expect(i).toBeGreaterThan(-1);
    expect(SRC.slice(i, i + 1400)).toMatch(/exit 1/);
  });

  it('it is gated on the spec pass actually being skipped', () => {
    // A resume that is going to RUN the spec pass has nothing to protect — the pass is about
    // to produce the output. Firing there would refuse a perfectly good resume.
    const i = SRC.indexOf('resume_spec_output_present "$PRD_FILE"');
    expect(SRC.slice(Math.max(0, i - 600), i)).toMatch(/EPAM_SPEC_MODE/);
  });

  it('the message names the recovery, not just the failure', () => {
    const i = SRC.indexOf('resume_spec_output_present "$PRD_FILE"');
    const block = SRC.slice(i, i + 1400);
    expect(block).toMatch(/EPAM_SPEC_MODE=1|re-run the spec|without --resume|fresh run/i);
  });
});
