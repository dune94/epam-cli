/**
 * CROSS-PROJECT CONTAMINATION MUST BE IMPOSSIBLE, PROVEN BY EXECUTION.
 *
 * Live 2026-08-05: a clean mock1 run (hello-dolly / MOCK-HW-1) archived artefacts naming a
 * different project, story and day — metrolinx / AMSD-2041, plus 19 healing events from the
 * previous day. Three separate leaks, all the same shape: a fallback that GUESSES.
 *
 *   working-prd.json   `ls -t /tmp/orch-*-prd-*.json | head -1`, commented
 *                      "the newest, which is this run's" — it is the newest from ANY project
 *   lane PRDs          written to a flat machine-global /tmp namespace every project shared
 *   healing events     the engine-wide store copied whole, across every project and run
 *
 * A source check cannot prove isolation. These tests RUN the archiver with the environment
 * deliberately poisoned — another project's PRD sitting in /tmp, another project's healing
 * events in the engine KB — and assert none of it reaches the output.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ARCHIVER = join(__dirname, '../../../orchestrations/scripts/archive-run-artifacts.sh');
const RUN_ID = '20260805T174459Z';
const RUN_STARTED = '2026-08-05T17:44:59Z';

interface Env { out: string; automation: string; projectCfg: string; }

function poisonedRun(): Env {
  const root = mkdtempSync(join(tmpdir(), 'iso-'));
  const automation = join(root, 'orchestrations');
  const projectCfg = join(automation, 'projects', 'mine');
  const work = join(projectCfg, 'runs', RUN_ID, 'work');
  const out = join(root, 'out');
  const logDir = join(automation, 'logs');
  for (const d of [work, out, logDir, join(automation, 'agents', 'kb')]) mkdirSync(d, { recursive: true });

  // THIS run's PRD, in this run's own working directory.
  writeFileSync(join(work, 'mine-prd.json'),
    JSON.stringify({ project: { name: 'mine' }, stories: [{ id: 'MINE-1', title: 'my story' }] }));

  // ANOTHER project's PRD, newer, in the shared namespace the old code globbed.
  writeFileSync(join(tmpdir(), `orch-other-prd-${process.pid}.json`),
    JSON.stringify({ project: { name: 'OTHER-PROJECT' }, stories: [{ id: 'OTHER-99', title: 'not mine' }] }));

  // Engine-wide healing store: entries from BEFORE this run (another project) and during it.
  writeFileSync(join(automation, 'agents', 'kb', 'healing-events.jsonl'),
    [
      JSON.stringify({ ts: '2026-08-04T02:55:05Z', story_id: 'OTHER-99', diagnosis: 'yesterday, another project' }),
      JSON.stringify({ ts: '2026-08-04T04:03:18Z', story_id: 'OTHER-99', diagnosis: 'also not mine' }),
      JSON.stringify({ ts: '2026-08-05T17:45:30Z', story_id: 'MINE-1', diagnosis: 'this run' }),
    ].join('\n') + '\n');
  writeFileSync(join(automation, 'agents', 'kb', 'constraints.json'), '{}');
  writeFileSync(join(automation, 'agents', 'profiles.json'), '{}');

  const r = spawnSync('bash', [ARCHIVER], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      AUTOMATION_DIR: automation,
      LOG_DIR: logDir,
      RUN_ARTIFACT_DIR: out,
      EPAM_PROJECT_CONFIG_DIR: projectCfg,
      ORCH_RUN_ID: RUN_ID,
      WORKING_PRD: '',
    },
  });
  if (r.status !== 0 && !existsSync(out)) throw new Error(`archiver failed: ${r.stderr}`);
  return { out, automation, projectCfg };
}

let env: Env;
beforeAll(() => { env = poisonedRun(); });

const read = (rel: string) => {
  const p = join(env.out, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

describe('another project cannot leak into this run\'s artefacts', () => {
  it('the archived PRD is THIS run\'s, with a newer foreign PRD sitting in /tmp', () => {
    const prd = read('working-prd.json');
    expect(prd, 'no PRD archived at all').toBeTruthy();
    expect(
      prd,
      'the archiver took the newest matching file from a shared namespace — exactly how ' +
        'mock1 ended up holding metrolinx\'s AMSD-2041',
    ).not.toMatch(/OTHER-PROJECT|OTHER-99/);
    expect(prd).toMatch(/MINE-1/);
  });

  it('healing events are only those from THIS run', () => {
    const kb = read('kb/healing-events.jsonl');
    expect(kb, 'no healing events archived').toBeTruthy();
    expect(
      kb,
      'the engine-wide store was copied whole, carrying another project\'s history from ' +
        'a previous day into this run\'s evidence',
    ).not.toMatch(/OTHER-99|yesterday/);
    expect(kb).toMatch(/MINE-1/);
  });

  it('every archived file names this project, or none', () => {
    for (const rel of ['working-prd.json', 'kb/healing-events.jsonl', 'kb/constraints.json']) {
      const body = read(rel);
      if (body === null) continue;
      expect(body, `${rel} names another project`).not.toMatch(/OTHER-PROJECT|OTHER-99/);
    }
  });

  it('the manifest reports what was captured AND what was missing', () => {
    const manifest = read('artifacts.json');
    expect(manifest, 'no artifacts.json — absence would be ambiguous').toBeTruthy();
    const parsed = JSON.parse(manifest!);
    expect(parsed).toHaveProperty('captured');
    expect(parsed, 'a missing list is what makes "not archived" honest rather than silent')
      .toHaveProperty('missing');
  });
});

describe('with nothing to archive it stays empty rather than borrowing', () => {
  it('a run whose work dir is empty archives NO prd, not somebody else\'s', () => {
    const root = mkdtempSync(join(tmpdir(), 'iso2-'));
    const automation = join(root, 'orchestrations');
    const projectCfg = join(automation, 'projects', 'empty');
    const out = join(root, 'out');
    mkdirSync(join(projectCfg, 'runs', RUN_ID, 'work'), { recursive: true });
    mkdirSync(join(automation, 'logs'), { recursive: true });
    mkdirSync(out, { recursive: true });
    // A foreign PRD in the shared namespace, and NOTHING in this run's work dir.
    writeFileSync(join(tmpdir(), `orch-foreign-prd-${process.pid}.json`),
      JSON.stringify({ project: { name: 'OTHER-PROJECT' }, stories: [{ id: 'OTHER-99' }] }));

    spawnSync('bash', [ARCHIVER], {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        AUTOMATION_DIR: automation, LOG_DIR: join(automation, 'logs'),
        RUN_ARTIFACT_DIR: out, EPAM_PROJECT_CONFIG_DIR: projectCfg,
        ORCH_RUN_ID: RUN_ID, WORKING_PRD: '',
      },
    });
    const prd = join(out, 'working-prd.json');
    expect(
      existsSync(prd) ? readFileSync(prd, 'utf8') : '',
      'nothing of this run existed, so the archiver reached for another project\'s file',
    ).not.toMatch(/OTHER-PROJECT|OTHER-99/);
  });
});
