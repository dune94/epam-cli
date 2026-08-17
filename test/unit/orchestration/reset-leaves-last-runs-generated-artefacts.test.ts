/**
 * THE RESET CLEARS SOME OF WHAT A RUN GENERATES, AND LEAVES THE REST.
 *
 * pre-run-reset restores the roster, the PRD, the KB and the ladder, and clears the two role
 * registries. Everything else a run writes into the project config dir survives — and each survivor
 * is derived state that the next run's agents will read as though this run produced it.
 *
 * Found 2026-08-17 while checking whether run 20260817T154640Z had provisioned its own prompts.
 * It had not yet, and the files were there anyway:
 *
 *   projects/mock3/prompts/codeline-bridge.json      10:37  <- run whose survey FAILED
 *   projects/mock3/prompts/assign-agent-roles.json   10:40  <- roster: transit-fare-engineer
 *   projects/mock3/prompts/ac-classification.json    11:54
 *   run started                                      12:01
 *
 * A project prompt is specialised against a specific roster and a specific survey. Those copies
 * were written against a survey that returned state:"failed" with filesRead:[], for agents that no
 * longer exist. Provisioning overwrites most of them alphabetically, so the window is narrow — but
 * anything this run's list does not include is never overwritten and persists indefinitely.
 *
 * Same class as the PRD keeping the previous run's agentRole: derived state in a directory the
 * reset does not walk. The others are codeline-facts.json (discovery), estate-survey.md (the
 * survey) and prompt-agent-link.json (the mint).
 *
 * PRESERVED ON RESUME AND ON A SKIPPED MINT, for the reason the roster is: a resume continues a run
 * that already reset, and nothing rebuilds these when the mint does not run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');

/** Everything a run GENERATES into the project config dir. None is authored by a human. */
const GENERATED = [
  'codeline-facts.json',
  'estate-survey.md',
  'prompt-agent-link.json',
];
/** Human-authored project inputs. Clearing any of these would destroy the project. */
const AUTHORED = [
  'config.env', 'llm-settings.json', 'manifest.json', 'plugins.json',
  'dependency-check.json', 'prd.canonical.json',
];

let work: string;
let projectDir: string;
let logDir: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'reset-gen-'));
  projectDir = join(work, 'project');
  logDir = join(work, 'logs');
  mkdirSync(join(projectDir, 'prompts'), { recursive: true });
  mkdirSync(logDir, { recursive: true });

  for (const f of [...GENERATED, ...AUTHORED]) {
    writeFileSync(join(projectDir, f), f.endsWith('.json') ? '{"stale":true}' : 'stale');
  }
  // A project prompt from a previous run, specialised for a roster that no longer exists.
  writeFileSync(join(projectDir, 'prompts', 'codeline-bridge.json'),
    JSON.stringify({ id: 'codeline-bridge', body: 'specialised for transit-fare-engineer' }));
  writeFileSync(join(projectDir, 'prd.json'), JSON.stringify({ stories: [] }));
  writeFileSync(join(projectDir, 'prd.canonical.json'), JSON.stringify({ stories: [] }));
});
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function runReset(extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [RESET, '--prd', join(projectDir, 'prd.json')], {
    encoding: 'utf8',
    timeout: 180000,
    env: {
      ...process.env,
      LOG_DIR: logDir,
      EPAM_PROJECT_CONFIG_DIR: projectDir,
      EPAM_SKIP_DASHBOARD: '1',
      ...extraEnv,
    },
  });
}

const there = (...p: string[]) => existsSync(join(projectDir, ...p));

describe('the reset leaves last run\'s generated artefacts', () => {
  it('clears every generated artefact in the project config dir', () => {
    runReset();
    const survivors = GENERATED.filter((f) => there(f));
    expect(survivors,
      `these are derived from a previous run and would be read as this run's: ${survivors.join(', ')}`)
      .toEqual([]);
  });

  it('CLEARS THE PROJECT PROMPTS — they are specialised for a roster that no longer exists', () => {
    runReset();
    expect(there('prompts', 'codeline-bridge.json'),
      'a prompt specialised for a previous run\'s roster survived into this one').toBe(false);
  });

  it('never touches human-authored project inputs', () => {
    // The whole project lives in these. A reset that removes one destroys the project.
    runReset();
    const destroyed = AUTHORED.filter((f) => !there(f));
    expect(destroyed, `the reset destroyed authored project input(s): ${destroyed.join(', ')}`)
      .toEqual([]);
  });

  it('a RESUME keeps them — it continues a run that already reset', () => {
    runReset({ EPAM_RESUME_RUN: '20260817T000000Z' });
    expect(there('prompts', 'codeline-bridge.json'),
      'a resume lost the prompts the run it resumes was using').toBe(true);
    expect(there('codeline-facts.json'), 'a resume lost its resolved codelines').toBe(true);
  });

  it('a SKIPPED MINT keeps them — nothing would rebuild them', () => {
    // Same protection the roster registries already get: clearing what the mint rebuilds is right
    // only when the mint is about to rebuild it.
    runReset({ EPAM_SKIP_AGENT_MINT: '1' });
    expect(there('prompts', 'codeline-bridge.json'),
      'the mint was skipped and the prompts it would have rebuilt were deleted anyway').toBe(true);
  });

  it('says what it cleared — a silent delete is indistinguishable from never having written', () => {
    const r = runReset();
    expect(r.stdout + r.stderr).toMatch(/generated project artefact|project prompt/i);
  });
});
