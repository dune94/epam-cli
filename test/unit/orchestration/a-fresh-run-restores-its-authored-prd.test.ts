/**
 * A RUN THAT SKIPS THE MINT IS STILL A FRESH RUN, AND A FRESH RUN STARTS FROM ITS AUTHORED PRD.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * pre-run-reset restores the runtime PRD from the project's authored input, so a run does not
 * inherit the previous run's conclusions. It skips that restore for a resume — correctly, since a
 * resume is the continuation of a run that already did it.
 *
 * But the flag it reads, _IS_RESUME, is ALSO set by EPAM_SKIP_AGENT_MINT=1. That exemption exists
 * for the ROSTER, where it is right: nothing rebuilds a roster the mint did not mint. The PRD is
 * rebuilt from an authored file that is always there, so the exemption does not apply to it — and
 * borrowing it means a fresh skip-mint run silently inherits whatever the last run wrote.
 *
 * Live 2026-08-27, the first mock3 launch. pre-run-reset printed "Resume — keeping the runtime PRD
 * as the run left it" on a FRESH run, and scope resolution then printed "2 codeline(s) already
 * declared in the PRD — nothing to resolve". The authored PRD declares NONE. So codeline-discovery
 * — one of the two agents the run existed to exercise — never ran, because a previous run's
 * codelines were still sitting in the runtime PRD.
 *
 * Same shape as the survey deletion: one flag answering two different questions.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');

/** What the project authored, and what a previous run left behind. */
const AUTHORED = { stories: [{ id: 'S-1' }], codelines: [] };
const LEFTOVER = { stories: [{ id: 'S-1', testCriteria: { facts: ['from the previous run'] } }],
                   codelines: [{ name: 'left-over-from-last-run' }] };

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Run the REAL reset over a runtime PRD that a previous run mutated. */
function reset(env: Record<string, string>): { prd: any; out: string } {
  const d = mkdtempSync(join(tmpdir(), 'prd-restore-')); dirs.push(d);
  const agents = join(d, 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'profiles.json'), '{"profiles":[]}\n');
  writeFileSync(join(agents, 'profiles.json.original'), '{"profiles":[]}\n');
  const logDir = join(d, 'logs'); mkdirSync(logDir, { recursive: true });

  const project = join(d, 'project'); mkdirSync(project, { recursive: true });
  const prd = join(project, 'prd.json');
  writeFileSync(join(project, 'prd.authored.json'), JSON.stringify(AUTHORED));
  writeFileSync(prd, JSON.stringify(LEFTOVER));

  const r = spawnSync('bash', [RESET, '--prd', prd, '--log-dir', logDir], {
    encoding: 'utf8', timeout: 120000,
    env: {
      ...process.env,
      EPAM_AGENTS_DIR: agents,
      COMPOSE_OVERRIDE: join(d, 'compose-override.yml'),
      DASHBOARD_STATE_DIR: d,
      JIRA_PIPELINE: '0',
      ...env,
    },
  });
  return { prd: JSON.parse(readFileSync(prd, 'utf8')), out: (r.stdout || '') + (r.stderr || '') };
}

describe('the harness is real — an ordinary fresh run restores its PRD', () => {
  it('a previous run\'s codelines and testCriteria are gone', () => {
    const { prd } = reset({});
    expect(prd.codelines, 'the authored PRD declares no codelines').toEqual([]);
    expect(prd.stories[0].testCriteria, 'a previous run\'s testCriteria survived').toBeUndefined();
  });
});

describe('THE DEFECT: SKIPPING THE MINT MADE A FRESH RUN INHERIT THE LAST ONE\'S PRD', () => {
  it('EPAM_SKIP_AGENT_MINT=1 still restores the authored PRD', () => {
    const { prd } = reset({ EPAM_SKIP_AGENT_MINT: '1' });
    expect(prd.codelines,
      'a fresh run inherited the previous run\'s codelines, so scope resolution reports them as '
      + 'already declared and codeline-discovery never runs')
      .toEqual([]);
  });

  it('and it does not announce itself as a resume', () => {
    const { out } = reset({ EPAM_SKIP_AGENT_MINT: '1' });
    expect(out, 'a fresh run told the operator it was resuming')
      .not.toMatch(/Resume — keeping the runtime PRD/);
  });
});

describe('a GENUINE resume still keeps the PRD the run was left with', () => {
  it('EPAM_RESUME_RUN preserves what the paused run had written', () => {
    const { prd } = reset({ EPAM_RESUME_RUN: '20260827T213033Z' });
    expect(prd.codelines, 'the resume discarded the scope the paused run had resolved')
      .toHaveLength(1);
    expect(prd.stories[0].testCriteria,
      'the resume discarded testCriteria the run had already produced — they live in the PRD, '
      + 'not in LOG_DIR, so nothing else would carry them across the pause')
      .toBeDefined();
  });
});
