/**
 * THE ONLY CHECKPOINT A RUN SAVES IS ONE ITS RESUME CANNOT SEE.
 *
 * checkpoint_dir() resolves per lane inside a lane, and per parent in the parent. Two calls save
 * a checkpoint:
 *
 *   post-roster (run-agent-orchestration.sh:3984)  guarded by should_pause_after_agent_mint
 *   post-spec   (run-agent-orchestration.sh:4628)  unconditional — but runs INSIDE the lane
 *
 * A project that does not pause therefore produces lane checkpoints and nothing else, while the
 * parent's resume looks only at runs/<id>/checkpoint. Live 2026-08-18, run 20260818T101809Z:
 *
 *   .../runs/20260818T101809Z/lanes/mocka/checkpoint    <- pre-writer, 6 VCs, 2 fix sites
 *   .../runs/20260818T101809Z/lanes/mockb/checkpoint    <- pre-writer, 3 VCs, 2 fix sites
 *   .../runs/20260818T101809Z/checkpoint                <- never written
 *
 * so the resume refused, and the run had to be repeated from zero — roughly 50 minutes of mint
 * and spec pass, to retry a writer stage whose inputs were all sitting on disk. The post-spec
 * call says "saving costs one file copy and buys a resumable run"; for any project that does not
 * pause, it bought nothing.
 *
 * The lane checkpoints are the real artefact — save_run_checkpoint pre-writer ONLY ever runs in a
 * lane, as restore_run_checkpoint's own comment says. So the parent reads them rather than
 * demanding a file the design does not produce at that stage. The existing rule still holds
 * whichever it uses: a restore never moves the PRD backwards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/run-checkpoint.sh');
const RID = '20260818T101809Z';

let dir: string;
let cfg: string;
let prd: string;

/** A PRD with a given number of spec items, so "never move backwards" can be exercised. */
function prdWith(specItems: number, storyId = 'S-1') {
  return JSON.stringify({
    stories: [{
      id: storyId,
      completed: false,
      verificationCriteria: Array.from({ length: specItems }, (_, i) => `vc-${i}`),
      fixSiteAnalysis: [],
    }],
  });
}

function laneCheckpoint(lane: string, specItems: number) {
  const d = join(cfg, 'runs', RID, 'lanes', lane, 'checkpoint');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'prd.json'), prdWith(specItems, `S-${lane}`));
  writeFileSync(join(d, 'checkpoint.json'), JSON.stringify(
    { runId: RID, phase: 'core', stage: 'pre-writer', createdAt: '2026-08-18T11:24:18Z', storyCount: 1 }));
  return d;
}

/** Run restore_run_checkpoint against the fixture, in PARENT context. */
function restore() {
  return spawnSync('bash', ['-c',
    `is_parent() { return 0; }\n. "${LIB}"\nrestore_run_checkpoint "${RID}"`,
  ], {
    encoding: 'utf8',
    env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: cfg, PRD_FILE: prd, AGENT_PROFILES_FILE: '' },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resume-'));
  cfg = join(dir, 'project');
  mkdirSync(cfg, { recursive: true });
  prd = join(cfg, 'prd.json');
  writeFileSync(prd, prdWith(0));            // the live PRD, reset to canonical: no spec items
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a run that never paused was never resumable', () => {
  it('RESUMES FROM LANE CHECKPOINTS WHEN THERE IS NO PARENT ONE — the live shape', () => {
    laneCheckpoint('mocka', 6);
    laneCheckpoint('mockb', 3);
    const r = restore();
    expect(r.status, `refused a run whose checkpoints are on disk: ${r.stdout}${r.stderr}`).toBe(0);
    const after = JSON.parse(readFileSync(prd, 'utf8'));
    const items = after.stories.reduce(
      (n: number, s: any) => n + (s.verificationCriteria?.length || 0) + (s.fixSiteAnalysis?.length || 0), 0);
    expect(items, 'the resumed PRD carries no spec output').toBeGreaterThan(0);
  });

  it('says which checkpoint it used, so a resume is not a silent guess', () => {
    laneCheckpoint('mocka', 6);
    const out = `${restore().stdout}${restore().stderr}`;
    expect(out).toMatch(/lane/i);
  });

  it('A PARENT CHECKPOINT STILL WINS WHEN ONE EXISTS — unchanged behaviour', () => {
    const p = join(cfg, 'runs', RID, 'checkpoint');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'prd.json'), prdWith(9, 'PARENT'));
    writeFileSync(join(p, 'checkpoint.json'), JSON.stringify({ runId: RID, storyCount: 1 }));
    laneCheckpoint('mocka', 6);
    const r = restore();
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(prd, 'utf8')).stories[0].id,
      'a lane checkpoint overrode the parent one').toBe('PARENT');
  });

  it('NEVER MOVES THE PRD BACKWARDS — the rule holds for lane checkpoints too', () => {
    writeFileSync(prd, prdWith(20, 'LIVE'));   // live PRD is richer than any checkpoint
    laneCheckpoint('mocka', 6);
    const r = restore();
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(prd, 'utf8')).stories[0].id,
      'a poorer checkpoint overwrote a richer live PRD').toBe('LIVE');
  });

  it('still REFUSES when there is no checkpoint anywhere', () => {
    mkdirSync(join(cfg, 'runs', RID), { recursive: true });
    const r = restore();
    expect(r.status, 'resumed a run that saved nothing').not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/no checkpoint/i);
  });

  it('refuses a lane checkpoint whose PRD is unusable rather than resuming on it', () => {
    const d = join(cfg, 'runs', RID, 'lanes', 'mocka', 'checkpoint');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'prd.json'), '{ not json');
    const r = restore();
    expect(r.status, 'resumed against a corrupt checkpoint PRD').not.toBe(0);
  });

  it('MERGES EVERY LANE — one lane\'s checkpoint must not discard another lane\'s story', () => {
    // Each lane checkpoints only ITS OWN story, so taking the "best" single lane loses the rest.
    // Live shape: mocka carries MOCK3-1 (6 VCs), mockb carries MOCK3-2 (3 VCs). A resume that
    // restores one of them hands the other lane a PRD with no story to work on.
    laneCheckpoint('mocka', 6);
    laneCheckpoint('mockb', 3);
    const r = restore();
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const ids = JSON.parse(readFileSync(prd, 'utf8')).stories.map((s: any) => s.id).sort();
    expect(ids, 'a lane checkpoint was restored on its own and the other lane vanished')
      .toEqual(['S-mocka', 'S-mockb']);
  });

  it('and keeps each story\'s own spec output through the merge', () => {
    laneCheckpoint('mocka', 6);
    laneCheckpoint('mockb', 3);
    restore();
    const byId = Object.fromEntries(
      JSON.parse(readFileSync(prd, 'utf8')).stories.map((s: any) => [s.id, s]));
    expect(byId['S-mocka'].verificationCriteria.length).toBe(6);
    expect(byId['S-mockb'].verificationCriteria.length).toBe(3);
  });
});
