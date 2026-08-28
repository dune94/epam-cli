/**
 * A RESUME KEEPS THE RUN STATE ITS DOWNSTREAM AGENTS ARE WAITING FOR.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * Pause 1 is a HUMAN REVIEW POINT INSIDE A RUN, not a destination: the run stops, a person looks
 * at what the survey and the roster produced, and the run RESUMES. That only means anything if
 * resuming preserves what the earlier stages produced.
 *
 * It did not. pre-run-reset.sh deletes estate-survey.json (with referenced-docs.json and
 * ticket-documents.json) at line ~386, and works out whether this is a resume at line ~571 — 190
 * lines LATER. So the deletion could never see it, and every resume destroyed the survey before
 * the run continued. surveyHypothesisBlock then finds no file, returns '', and
 * code-graph-detective — the survey's one real consumer — resumes blind, rediscovering an estate
 * that was already surveyed and paid for.
 *
 * The deletion is RIGHT for a fresh run: a stale survey from another project, matched by codeline
 * name (api, web, src), feeds one project's evidence into another's prompts. That is a different
 * run. On a resume the artefact is THIS run's own output.
 *
 * The distinction that matters, and the reason this cannot simply read _IS_RESUME: that flag is
 * also set by EPAM_SKIP_AGENT_MINT=1, which is a FRESH run that happens not to mint. Its
 * artefacts belong to a PREVIOUS run and must still be cleared. Only EPAM_RESUME_RUN is a genuine
 * continuation.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');

/** The artefacts a later step reads back out of LOG_DIR. */
const CARRIED = ['estate-survey.json', 'referenced-docs.json', 'ticket-documents.json'];

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Run the REAL reset with the carried artefacts present. Returns which ones survived. */
function reset(env: Record<string, string>): { survived: string[]; out: string } {
  const d = mkdtempSync(join(tmpdir(), 'resume-state-')); dirs.push(d);
  const agents = join(d, 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'profiles.json'), '{"profiles":[]}\n');
  writeFileSync(join(agents, 'profiles.json.original'), '{"profiles":[]}\n');

  const logDir = join(d, 'logs');
  mkdirSync(logDir, { recursive: true });
  for (const f of CARRIED) {
    writeFileSync(join(logDir, f), JSON.stringify({ ran: true, note: 'this run produced this' }));
  }

  const r = spawnSync('bash', [RESET, '--prd', join(d, 'no-such-prd.json'), '--log-dir', logDir], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      EPAM_AGENTS_DIR: agents,
      COMPOSE_OVERRIDE: join(d, 'compose-override.yml'),
      DASHBOARD_STATE_DIR: d,
      ...env,
    },
  });
  return {
    survived: CARRIED.filter((f) => existsSync(join(logDir, f))),
    out: (r.stdout || '') + (r.stderr || ''),
  };
}

describe('the harness is real — a fresh run STILL clears carried run state', () => {
  it('without EPAM_RESUME_RUN every carried artefact is deleted, exactly as before', () => {
    // If this went green by accident the case below would prove nothing: it would assert that a
    // deletion which never runs did not run.
    const { survived } = reset({});
    expect(survived, 'the contamination rule is broken — a fresh run must clear these')
      .toEqual([]);
  });

  it('a fresh run that merely SKIPS THE MINT still clears them', () => {
    // EPAM_SKIP_AGENT_MINT=1 sets _IS_RESUME, but it is not a resume: these artefacts are a
    // PREVIOUS run's, and keeping them is the cross-project leak this deletion exists to stop.
    const { survived } = reset({ EPAM_SKIP_AGENT_MINT: '1' });
    expect(survived, 'a skip-mint run kept another run\'s survey — the leak is back').toEqual([]);
  });
});

describe('THE DEFECT: RESUMING DESTROYED WHAT THE RUN HAD ALREADY PRODUCED', () => {
  it('EPAM_RESUME_RUN preserves the estate survey the detective consumes', () => {
    const { survived } = reset({ EPAM_RESUME_RUN: '20260827T213033Z' });
    expect(survived,
      'the resume deleted this run\'s own survey, so code-graph-detective resumes blind and '
      + 'rediscovers an estate that was already surveyed and paid for')
      .toContain('estate-survey.json');
  });

  it('and the documents the earlier stages fetched survive it too', () => {
    const { survived } = reset({ EPAM_RESUME_RUN: '20260827T213033Z' });
    expect(survived).toEqual(expect.arrayContaining(CARRIED));
  });

  it('the resume decision is still made ONCE, not re-derived per block', () => {
    // Single point of maintenance, and the existing rule for this file: two blocks each testing
    // EPAM_RESUME_RUN independently is the shape that produced the roster defect.
    const src = require('node:fs').readFileSync(RESET, 'utf8') as string;
    const code = src.split('\n').filter((l: string) => !/^\s*#/.test(l)).join('\n');
    const tests = code.match(/\[ -n "\$\{EPAM_RESUME_RUN:-\}" \]/g) || [];
    expect(tests.length, 'EPAM_RESUME_RUN is tested in several places instead of once')
      .toBeLessThanOrEqual(1);
  });
});
