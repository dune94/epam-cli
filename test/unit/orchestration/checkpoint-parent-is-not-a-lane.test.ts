/**
 * THE PARENT'S CHECKPOINT MUST BE WHERE THE PARENT LOOKS FOR IT.
 *
 * _checkpoint_lane() decides whether a checkpoint belongs to the run or to one lane. It
 * inferred that from the PRD: the codeline whose outputDirs[].path matches project.outputDir.
 * The synthesizer sets project.outputDir = outputDirs[0].path, so the PARENT resolved to
 * codeline[0]. The post-roster checkpoint — saved by the parent, before any lane exists — was
 * written to runs/<id>/lanes/<first-codeline>/checkpoint, and the parent's resume looked in
 * runs/<id>/checkpoint, found nothing, and refused to continue. Live 2026-08-08.
 *
 * This EXECUTES the real function under both roles. The previous generation of tests around
 * this area asserted on source structure and could not have caught it: the function is
 * correct in a lane and wrong in the parent, and both look identical in the source.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = join(__dirname, '../../../');
const CKPT = readFileSync(join(REPO, 'orchestrations/scripts/lib/run-checkpoint.sh'), 'utf8');
const ORCH = readFileSync(join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const CODELINES = [
  { codeline: 'alpha', path: '/estate/alpha' },
  { codeline: 'beta', path: '/estate/beta' },
  { codeline: 'gamma', path: '/estate/gamma' },
];

/** The role helpers, from the orchestrator — the single place the role is derived. */
function roleHelpers(): string {
  const start = ORCH.indexOf('orch_role() {');
  const endMark = "is_lane() { [ \"$(orch_role)\" = 'lane' ]; }";
  const end = ORCH.indexOf(endMark);
  expect(start, 'the role helpers are gone').toBeGreaterThan(-1);
  return ORCH.slice(start, end + endMark.length);
}

function fn(): string {
  const start = CKPT.indexOf('_checkpoint_lane() {');
  expect(start, '_checkpoint_lane is gone').toBeGreaterThan(-1);
  return CKPT.slice(start, CKPT.indexOf('\n}', start) + 2);
}

/** Runs the REAL resolver with a PRD shaped exactly as the synthesizer writes one. */
function lane(env: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ckpt-lane-')); dirs.push(dir);
  const prd = join(dir, 'prd.json');
  // outputDir = outputDirs[0].path — what synthesize-prd-from-jira.js produces.
  writeFileSync(prd, JSON.stringify({
    project: { outputDir: CODELINES[0].path, outputDirs: CODELINES }, stories: [],
  }));
  const sh = join(dir, 'run.sh');
  writeFileSync(sh, `#!/usr/bin/env bash\nset -u\n${roleHelpers()}\n${fn()}\n_checkpoint_lane\n`);
  return execFileSync('bash', [sh], {
    encoding: 'utf8', env: { ...process.env, PRD_FILE: prd, CODELINE_NAME: '', ...env },
  });
}

describe('the fixture reproduces the real PRD shape', () => {
  it('the synthesizer really does point outputDir at the first codeline', () => {
    const syn = readFileSync(join(REPO, 'orchestrations/scripts/synthesize-prd-from-jira.js'), 'utf8');
    expect(syn).toMatch(/project\.outputDir\s*=\s*outputDirs\[0\]\.path/);
  });
});

describe('THE DEFECT: the parent is not a lane', () => {
  it('the parent resolves to NO lane, even though outputDir matches codeline[0]', () => {
    expect(
      lane({ JIRA_CODELINE_RUN: '' }),
      'the parent resolved to a codeline, so its checkpoint lands in a lane directory and ' +
      'resume looks in the wrong place',
    ).toBe('');
  });

  it('a lane still resolves to its own codeline', () => {
    expect(lane({ JIRA_CODELINE_RUN: '1', EPAM_CODELINE: 'beta' })).toBe('beta');
  });

  it('a lane that is NOT codeline[0] is not mistaken for codeline[0]', () => {
    expect(lane({ JIRA_CODELINE_RUN: '1', EPAM_CODELINE: 'gamma' })).toBe('gamma');
  });

  it('CODELINE_NAME still wins when explicitly set — the documented override', () => {
    expect(lane({ JIRA_CODELINE_RUN: '1', CODELINE_NAME: 'alpha', EPAM_CODELINE: 'beta' })).toBe('alpha');
  });

  it('a lane with no codeline exported falls back to the PRD rather than failing', () => {
    // Not ideal, but it is a LANE, so inferring is at least the right question to ask.
    expect(lane({ JIRA_CODELINE_RUN: '1' })).toBe(CODELINES[0].codeline);
  });
});
