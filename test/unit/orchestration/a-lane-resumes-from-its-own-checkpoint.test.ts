/**
 * A LANE RESUMES FROM ITS OWN CHECKPOINT — _lane_resume_prd (lib/codeline-lanes.sh).
 *
 * The AMSD-2974 writer relaunch (2026-10-02) rebuilt every lane's PRD from the canonical one, which
 * a resume restores from the run's post-roster checkpoint, taken before any spec: every lane ran its
 * spec pass again, paid, and overwrote the spec the operator had approved at pause 2. A lane whose
 * own checkpoint is pre-writer now takes that checkpoint's PRD and skips its spec pass. The whole
 * flow is proven by test/mock-agent/multi-lane-worktree.test.ts; this executes the decision itself
 * against every case it decides.
 *
 * EXECUTED: the real _lane_resume_prd, sliced from lib/codeline-lanes.sh, with the real
 * lib/run-checkpoint.sh (_stage_rank, _operator_edited).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const lines = readFileSync(join(LIB, 'codeline-lanes.sh'), 'utf8').split('\n');
const s = lines.findIndex((l) => /^\s*_lane_resume_prd\(\) \{/.test(l));
const indent = (lines[s] || '').match(/^\s*/)![0];
const e = lines.findIndex((l, i) => i > s && l === `${indent}}`);
const fn = lines.slice(s, e + 1).join('\n');

const work = mkdtempSync(join(tmpdir(), 'lane-resume-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function lane(name: string, stage: string | null, opts: { edited?: boolean } = {}) {
  const cfg = join(work, name, 'project');
  const ck = join(cfg, 'runs', 'R1', 'lanes', 'site', 'checkpoint');
  const out = join(work, name, 'site-prd.json');
  mkdirSync(join(ck, 'reviewed'), { recursive: true });
  if (stage) {
    writeFileSync(join(ck, 'checkpoint.json'), JSON.stringify({ stage }));
    writeFileSync(join(ck, 'prd.json'), JSON.stringify({ stories: [{ id: 'S-1', approved: true }] }));
  }
  // What the pause showed the operator, and the lane's working PRD as it stands now.
  writeFileSync(join(ck, 'reviewed', 'site-prd.json'), JSON.stringify({ stories: [{ id: 'S-1', shown: true }] }));
  writeFileSync(out, JSON.stringify({ stories: [{ id: 'S-1', shown: true, ...(opts.edited ? { operatorEdit: true } : {}) }] }));
  return { cfg, out };
}

function run(cfg: string, out: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `log(){ echo "LOG $*"; }; warning(){ :; }; info(){ :; }; error(){ :; }
source ${JSON.stringify(join(LIB, 'run-checkpoint.sh'))}
${fn}
if _lane_resume_prd site ${JSON.stringify(out)}; then echo "RESUMED spec=$_lane_spec_mode"; else echo "REBUILD spec=$_lane_spec_mode"; fi`],
  { encoding: 'utf8', env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: cfg, EPAM_RESUME_RUN: 'R1', ...env } });
  return { stdout: r.stdout, prd: JSON.parse(readFileSync(out, 'utf8')) };
}

describe('_lane_resume_prd', () => {
  it('the function under test was found', () => { expect(s).toBeGreaterThan(-1); expect(e).toBeGreaterThan(s); });

  it('a lane checkpointed pre-writer resumes from its own approved PRD and skips its spec pass', () => {
    const { cfg, out } = lane('prewriter', 'pre-writer');
    const r = run(cfg, out);
    expect(r.stdout).toContain('RESUMED spec=0');
    expect(r.prd.stories[0].approved).toBe(true);
  });

  it('an edit the operator made to the lane\'s PRD at the pause is kept', () => {
    const { cfg, out } = lane('edited', 'pre-writer', { edited: true });
    const r = run(cfg, out);
    expect(r.stdout).toContain('RESUMED spec=0');
    expect(r.prd.stories[0].operatorEdit).toBe(true);
    expect(r.prd.stories[0].approved).toBeUndefined();
  });

  it('a resume sent back to an earlier stage rebuilds the lane and runs its spec pass', () => {
    const { cfg, out } = lane('sentback', 'pre-writer');
    const r = run(cfg, out, { EPAM_RESUME_FROM_STAGE: 'post-roster' });
    expect(r.stdout).toContain('REBUILD spec=');
    expect(r.stdout).not.toContain('spec=0');
  });

  it('a lane that never reached pre-writer is rebuilt as before', () => {
    const { cfg, out } = lane('postroster', 'post-roster');
    expect(run(cfg, out).stdout).toContain('REBUILD');
  });

  it('a lane with no checkpoint at all is rebuilt as before, and a fresh run never resumes', () => {
    const { cfg, out } = lane('none', null);
    expect(run(cfg, out).stdout).toContain('REBUILD');
    const fresh = lane('fresh', 'pre-writer');
    expect(existsSync(fresh.out)).toBe(true);
    expect(run(fresh.cfg, fresh.out, { EPAM_RESUME_RUN: '' }).stdout).toContain('REBUILD');
  });
});
