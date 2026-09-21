/**
 * A CHANGE TOO LARGE TO INLINE STILL REACHES THE REVIEWER.
 *
 * regintel 20260921T032802Z, phase scaffold: REGI-001 completed (13 deliverables, $0.14) and the
 * team-lead review then produced NO VERDICT six times in a row, killing the run. Nothing was ever
 * reviewed: the story's diff was over REVIEW_DIFF_MAX_BYTES, and the branch that summarises a
 * large change ran
 *
 *     node -e '"'"' … '"'"'
 *
 * — quoting written as if inside a single-quoted string, at top level. The program node received
 * BEGAN with a literal apostrophe: "Unterminated string constant", exit 1, and `set -e` took the
 * reviewer down before a model was ever asked. No £0 stand-in had ever produced a diff that big,
 * so the branch had never executed.
 *
 * This runs the REAL reviewer against a codeline whose change exceeds a deliberately small cap.
 * The story has no persisted rung, so the reviewer refuses further down — AFTER the large-diff
 * branch — without reaching any provider. Reaching that refusal proves the branch ran clean;
 * the negative assertion proves node never choked on its own program.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPT = join(ROOT, 'orchestrations/scripts/team-lead-review.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
}

function reviewALargeChange() {
  const d = mkdtempSync(join(tmpdir(), 'large-change-review-')); dirs.push(d);
  const logDir = join(d, 'logs'); mkdirSync(logDir);
  const proj = join(d, 'proj'); mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'src/thing.ts'), 'export const thing = 1;\n');
  git(proj, 'init', '-q', '-b', 'develop');
  git(proj, 'add', '.'); git(proj, 'commit', '-q', '-m', 'base');
  const base = git(proj, 'rev-parse', 'HEAD');
  // The story's change: well over the cap set below.
  writeFileSync(join(proj, 'src/thing.ts'), 'export const thing = 1;\n' + 'export const pad = "x";\n'.repeat(400));
  git(proj, 'add', '.'); git(proj, 'commit', '-q', '-m', 'FX-1: story complete');
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), base + '\n');
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
      REVIEW_DIFF_MAX_BYTES: '200',
      EPAM_PROJECT_CONFIG_DIR: join(ROOT, 'orchestrations/projects/metrolinx'),
      EPAM_PROVIDER_SET: 'openrouter', OPENROUTER_BASE_URL: 'http://127.0.0.1:9', MINIMAX_BASE_URL: 'http://127.0.0.1:9',
      OPENROUTER_API_KEY: 'none', MINIMAX_API_KEY: 'none',
    },
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('a change too large to inline still reaches the reviewer', () => {
  const r = reviewALargeChange();

  it('the reviewer did not choke on its own summarising program', () => {
    expect(r.out, `node rejected the program the reviewer handed it:\n${r.out.slice(-1500)}`)
      .not.toMatch(/Unterminated string constant|SyntaxError|\[eval\]/);
  });

  it('the reviewer got past the large-diff branch to its rung check — the branch ran clean', () => {
    // The refusal lives AFTER the large-diff branch; a script killed by `set -e` never prints it.
    expect(r.out, `the reviewer never reached its rung check:\n${r.out.slice(-1500)}`).toMatch(/no rung on record for FX-1/);
  });
});
