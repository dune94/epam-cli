/**
 * THE PRD IS THE THIRD PLACE AN ASSIGNMENT LIVES, AND THE ONLY ONE NOTHING RESET.
 *
 * pre-run-reset clears the two roster registries and role-assignments.json, because a roster is
 * ephemeral and an assignment that outlives it names an agent with no brief. Each story in the PRD
 * carries an agentRole too, written during the run — and nothing ever cleared it.
 *
 * Live 2026-08-17, mock3 run 20260817T152632Z. The reset ran, the roster was restored to canonical,
 * the mint drew a FRESH roster (typescript-logic-engineer, mocka-fares-investigator,
 * mockb-schedule-investigator), the roster review passed — and assignment then read the PRD, found
 * "transit-fare-engineer" left there by the run before, and refused:
 *
 *   [assign] MOCK3-1 was assigned "transit-fare-engineer", which is not in the roster — it has no
 *   profile entry, so the writer would run with an empty system prompt.
 *
 * The guard was right. Minted names are a fresh draw every run, so a persisted assignment is stale
 * BY CONSTRUCTION — it can only be right by coincidence.
 *
 * The per-project launchers this repo replaced each restored the PRD themselves. Generalising them
 * into tier3-run.sh dropped the restore along with the project names, and no launcher has done it
 * since. It belongs in the reset, next to the roster and KB restores, so every launcher inherits it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');

let work: string;
let projectDir: string;
let logDir: string;

const CANONICAL = {
  title: 'test', project: { name: 'test' }, currentIteration: 1,
  implementationOrder: { core: ['S-1'] },
  stories: [{ id: 'S-1', title: 't', status: 'pending', codelines: ['a'] }],
};
/** The same PRD after a run: an agent assigned, a codeline resolved, a phase injected. */
const AFTER_A_RUN = {
  ...CANONICAL,
  implementationOrder: { scaffold: [], core: ['S-1'] },
  stories: [{ ...CANONICAL.stories[0], agentRole: 'transit-fare-engineer', codeline: 'a' }],
};

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'prd-reset-'));
  projectDir = join(work, 'project');
  logDir = join(work, 'logs');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
});
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function runReset(extraEnv: Record<string, string> = {}) {
  const r = spawnSync('bash', [RESET, '--prd', join(projectDir, 'prd.json')], {
    encoding: 'utf8',
    timeout: 180000,
    env: {
      ...process.env,
      LOG_DIR: logDir,
      EPAM_PROJECT_CONFIG_DIR: projectDir,
      // Keep the destructive, docker-touching parts of the reset out of a unit test.
      EPAM_SKIP_DASHBOARD: '1',
      ...extraEnv,
    },
  });
  return { out: r.stdout + r.stderr, rc: r.status };
}

function prd() {
  return JSON.parse(readFileSync(join(projectDir, 'prd.json'), 'utf8'));
}

describe('the PRD kept the previous run\'s assignments', () => {
  it('a fresh run starts with NO agent assigned', () => {
    writeFileSync(join(projectDir, 'prd.json'), JSON.stringify(AFTER_A_RUN));
    writeFileSync(join(projectDir, 'prd.canonical.json'), JSON.stringify(CANONICAL));

    runReset();
    expect(prd().stories[0].agentRole,
      'the run inherited the previous run\'s agent — assignment will refuse, or worse, run a stale name')
      .toBeUndefined();
  });

  it('per-run derived state is gone, not just the agent name', () => {
    // Restores the WHOLE file rather than stripping known fields: a subtractive list would
    // silently miss the next per-run field somebody adds.
    writeFileSync(join(projectDir, 'prd.json'), JSON.stringify(AFTER_A_RUN));
    writeFileSync(join(projectDir, 'prd.canonical.json'), JSON.stringify(CANONICAL));

    runReset();
    const p = prd();
    expect(p.stories[0].codeline, 'a resolved codeline survived the reset').toBeUndefined();
    expect(Object.keys(p.implementationOrder),
      'the phase the mint injects last run survived into this one').toEqual(['core']);
  });

  it('the work itself is preserved — this is a reset, not a rewrite', () => {
    writeFileSync(join(projectDir, 'prd.json'), JSON.stringify(AFTER_A_RUN));
    writeFileSync(join(projectDir, 'prd.canonical.json'), JSON.stringify(CANONICAL));

    runReset();
    const p = prd();
    expect(p.stories.map((s: any) => s.id)).toEqual(['S-1']);
    expect(p.implementationOrder.core).toEqual(['S-1']);
    expect(p.title).toBe('test');
  });

  it('A RESUME KEEPS ITS PRD — it is the continuation of a run that already reset', () => {
    // The roster restore is resume-aware for exactly this reason; restoring the PRD under a resume
    // would discard the assignments the resumed run is mid-way through executing.
    writeFileSync(join(projectDir, 'prd.json'), JSON.stringify(AFTER_A_RUN));
    writeFileSync(join(projectDir, 'prd.canonical.json'), JSON.stringify(CANONICAL));

    runReset({ EPAM_RESUME_RUN: '20260817T000000Z' });
    expect(prd().stories[0].agentRole,
      'a resume lost the assignments it was resuming with').toBe('transit-fare-engineer');
  });

  it('A CORRUPT CANONICAL FAILS LOUDLY — it never overwrites the only other copy', () => {
    writeFileSync(join(projectDir, 'prd.json'), JSON.stringify(AFTER_A_RUN));
    writeFileSync(join(projectDir, 'prd.canonical.json'), '{ not json');

    const { out, rc } = runReset();
    expect(rc, 'a corrupt canonical was tolerated and the run started stale').not.toBe(0);
    expect(out).toMatch(/not valid JSON/i);
    // The runtime PRD must survive intact — it is now the only readable copy.
    expect(prd().stories[0].agentRole).toBe('transit-fare-engineer');
  });

  it('a project with no canonical is left alone, not emptied', () => {
    // Not every project keeps a canonical; the absence must not destroy the runtime PRD.
    writeFileSync(join(projectDir, 'prd.json'), JSON.stringify(AFTER_A_RUN));

    runReset();
    expect(prd().stories[0].id, 'a project without a canonical lost its PRD').toBe('S-1');
  });
});
