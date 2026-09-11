/**
 * A REVIEW THAT REFUSES TO JUDGE MUST NOT APPROVE.
 *
 * team-lead-review.sh takes the writer's persisted rung so the reviewer runs on the setup that
 * produced the work. When no rung is on record it refuses — correctly — and writes a blocker:
 *
 *   [FAIL]  no rung on record for AMSD-1919 — the writer never persisted one …
 *   [FAIL]  Refusing to judge converged work on a guessed rung.
 *
 * Then, live 2026-09-11 (£0 harness against bugfix/AI-AMSD-1919, MockServer answering):
 *
 *   [PASS] Code review passed - no issues found
 *   [REVIEW] Review Decision: APPROVED
 *
 * The refusal branch writes its blocker to a feedback file and `continue`s. The phase decision
 * counts ISSUES, which only a COMPLETED review appends to. So a refusal is an approval, with no
 * model called. The sibling refusal (review-agent did not complete) at least raises the
 * review-incomplete flag; this one raised nothing, and wrote its file under $AUTOMATION_DIR/logs
 * while every other artefact of the same review went to $LOG_DIR.
 *
 * This runs the REAL script end to end with one story and no rung. No model is reachable — the
 * refusal happens before any call — so it costs nothing and cannot pass by accident.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPT = join(ROOT, 'orchestrations/scripts/team-lead-review.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function runReviewWithNoRung() {
  const d = mkdtempSync(join(tmpdir(), 'refused-review-')); dirs.push(d);
  const logDir = join(d, 'logs'); mkdirSync(logDir);
  // A codeline with one committed file, so story files resolve to something real.
  const proj = join(d, 'proj'); mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'src/thing.ts'), 'export const thing = 1;\n');
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: proj });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: proj });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: proj });
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    project: { name: 'fixture', outputDir: proj },
    implementationOrder: { core: ['FX-1'] },
    stories: [{
      id: 'FX-1', jiraKey: 'FX-1', title: 'fixture story', description: 'd', agentRole: 'engineer',
      status: 'pending', codelines: ['proj'],
      technicalNotes: { files: ['src/thing.ts'] },
      verificationCriteria: ['thing is exported'],
    }],
  }, null, 2));
  const r = spawnSync('bash', [SCRIPT, 'core'], {
    encoding: 'utf8', timeout: 120_000, cwd: ROOT,
    env: {
      ...process.env,
      PRD_FILE: prd, PROJECT_ROOT: proj, LOG_DIR: logDir, REVIEW_LOG: join(logDir, 'code-reviews.jsonl'),
      AUTO_APPROVE: 'true',
      // A real project's declarations, read only: the review needs ladders and policies to render
      // before it reaches the rung check. The fixture PRD, not this project's, names the story.
      EPAM_PROJECT_CONFIG_DIR: join(ROOT, 'orchestrations/projects/metrolinx'),
      // No provider can be reached; the refusal must happen before any call anyway.
      EPAM_PROVIDER_SET: 'openrouter', OPENROUTER_BASE_URL: 'http://127.0.0.1:9', MINIMAX_BASE_URL: 'http://127.0.0.1:9',
      OPENROUTER_API_KEY: 'none', MINIMAX_API_KEY: 'none',
    },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  return { status: r.status, out, logDir };
}

describe('a refused review is not an approval', () => {
  const r = runReviewWithNoRung();

  it('the refusal actually fired — otherwise nothing below is tested', () => {
    expect(r.out, `expected the no-rung refusal:\n${r.out.slice(-1500)}`).toMatch(/no rung on record for FX-1/);
  });

  it('the phase decision is CHANGES REQUESTED, never APPROVED', () => {
    expect(r.out, `a refused review approved the phase:\n${r.out.slice(-1500)}`).not.toMatch(/Review Decision: APPROVED/);
    expect(r.out).toMatch(/Review Decision: CHANGES REQUESTED/);
  });

  it('the blocker lands in LOG_DIR with the rest of the review, and the incomplete flag is raised', () => {
    const fb = join(r.logDir, 'review-feedback-FX-1.json');
    expect(existsSync(fb), `feedback file not in LOG_DIR (${r.logDir})`).toBe(true);
    const j = JSON.parse(readFileSync(fb, 'utf8'));
    expect(j.verdict).toBe('changes_requested');
    expect(j.reviewIncomplete).toBe(true);
    expect(existsSync(join(r.logDir, 'review-incomplete-core.flag')),
      'no review-incomplete flag: the orchestration cannot tell this from a completed review').toBe(true);
  });
});
