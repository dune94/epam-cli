/**
 * PRE-FLIGHT REFUSED A RESUME FOR CARRYING THE SPEC PASS THE RESUME EXISTS TO SKIP.
 *
 * The gate: a PENDING story carrying a `specification` block means a prior run's data was baked
 * into the canonical, and the spec coordinator would read it and skip re-elaboration. Correct for
 * a fresh run — it has fired for real (2026-07-06).
 *
 * It cannot tell that case from a resume. On 2026-08-18 the resume of run 20260818T101809Z was
 * refused at launch:
 *
 *   ✗ Canonical PRD has pre-baked 'specification' blocks on base stories
 *     (must be lean/unelaborated): MOCK3-1,MOCK3-2
 *   ━━━ ✗ 1 check(s) FAILED — DO NOT run pipeline ━━━
 *
 * while prd.canonical.json was correctly lean and the RUNTIME PRD carried 6 and 3 verification
 * criteria, 2 fix sites each and both roles assigned — the entire output the resume was there to
 * reuse. The gate was reading "this run already elaborated its stories" as "a previous run
 * contaminated this file".
 *
 * The check already has one exception for the same reason — Jira ingest overwrites the file
 * before anything reads it, so stale data is deferred rather than fatal. A resume is the second:
 * the specification blocks belong to the run being resumed, and that run IS this run.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const PREFLIGHT = join(ROOT, 'orchestrations/scripts/preflight-check.sh');
const MSG = /pre-baked 'specification' blocks/;

/** A runtime PRD in the live shape: pending stories that already carry the spec pass's output. */
const ELABORATED = JSON.stringify({
  project: { name: 'mock3' },
  stories: [
    { id: 'MOCK3-1', title: 'a', completed: false, agentRole: 'r',
      specification: { status: 'completed' }, verificationCriteria: ['vc'], acceptanceCriteria: ['ac'] },
    { id: 'MOCK3-2', title: 'b', completed: false, agentRole: 'r',
      specification: { status: 'completed' }, verificationCriteria: ['vc'], acceptanceCriteria: ['ac'] },
  ],
});

function preflight(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, ELABORATED);
  const r = spawnSync('bash', [PREFLIGHT, '--runner', 'run-agent-orchestration.sh', '--prd', prd], {
    encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000,
  });
  rmSync(dir, { recursive: true, force: true });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

describe('pre-flight refused the run it was resuming', () => {
  it('A FRESH RUN IS STILL REFUSED — the contamination this gate exists for', () => {
    const out = preflight({ EPAM_RESUME_RUN: '' });
    expect(out, 'the gate no longer catches a prior run baked into the PRD').toMatch(MSG);
  });

  it('A RESUME IS NOT — the spec blocks belong to the run being resumed', () => {
    const out = preflight({ EPAM_RESUME_RUN: '20260818T101809Z' });
    expect(out, 'the resume is refused for carrying the spec pass it exists to skip')
      .not.toMatch(MSG);
  });

  it('and says why it was allowed, rather than passing silently', () => {
    const out = preflight({ EPAM_RESUME_RUN: '20260818T101809Z' });
    expect(out, 'nothing records that the spec data was accepted because this is a resume')
      .toMatch(/resum/i);
  });
});
