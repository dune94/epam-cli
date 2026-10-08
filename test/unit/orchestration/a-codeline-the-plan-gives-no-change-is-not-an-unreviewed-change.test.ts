/**
 * A CODELINE THE PLAN GIVES NO CHANGE, UNCHANGED, IS NOT AN UNREVIEWED CHANGE.
 *
 * Rehearsal 2026-10-08 (AMSD-2974, metrolinx — plan part "none", nothing changed): the review correctly found nothing
 * to review, then refused to report approved ("reviewed NO stories"), the loop read that as no verdict and cycled to
 * its limit. The refusal stays for a story that should have changed and did not (B26: nothing reviewed is never
 * approved); a story unchanged BECAUSE its plan gives this codeline no change is the plan, met — proved by the gates.
 *
 * EXECUTED: the real team-lead-review.sh on a real repository; no model is reached (nothing to review).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function review(change: string) {
  const d = mkdtempSync(join(tmpdir(), 'nochange-review-')); dirs.push(d);
  const repo = join(d, 'site'); const logs = join(d, 'logs'); mkdirSync(logs);
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).stdout.trim();
  spawnSync('git', ['init', '-q', '-b', 'develop', repo]); writeFileSync(join(repo, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-qm', 'base');
  writeFileSync(join(logs, 'phase-baseline-sha.txt'), git('rev-parse', 'HEAD'));
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ implementationOrder: { core: ['S-1'] }, stories: [{ id: 'S-1', phase: 'core', title: 't', status: 'completed', completed: true,
    overallPlan: { codelines: [{ codeline: 'site', part: 'p', order: 2 }], packages: [{ package: '@s/l', providedBy: 'lib', releaseLines: [], consumers: [{ codeline: 'site', declaredRange: '^1', receivesVia: '1.0.1', usage: [], change }] }] } }] }));
  return spawnSync('bash', [join(SCRIPTS, 'team-lead-review.sh'), 'core'], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PRD_FILE: prd, MAIN_PRD_FILE: prd, PROJECT_ROOT: repo, LOG_DIR: logs, REVIEW_LOG: join(logs, 'code-reviews.jsonl'),
      EPAM_CODELINE: 'site', NODE_BIN: process.execPath, EPAM_PROJECT_CONFIG_DIR: join(ROOT, 'orchestrations/projects/metrolinx'), JIRA_BASELINE_BRANCH: 'develop', BASELINE_SHA: git('rev-parse', 'HEAD'), PHASE: 'core' } });
}

describe('nothing changed, and nothing reviewed', () => {
  it('the plan gives this codeline no change: approved as planned, and says why', () => {
    const r = review('none');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/plan gives site no change/);
  });
  it('the plan gives this codeline a change it did not make: still refused — nothing reviewed is never approved', () => {
    const r = review('rename the toast prop');
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/reviewed NO stories/);
  });
});
