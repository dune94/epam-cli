/**
 * THE TEAM LEAD REVIEWS THE STORY'S OWN CHANGE — NOT THE WHOLE PHASE.
 *
 * regintel 140717Z resume 4 (2026-09-21 18:50): the core review of REGI-007 (approved a cycle
 * earlier) came back CHANGES REQUESTED with a blocker: "the current diff includes a substantial
 * refactor of scripts/run_pipeline.py" — REGI-010-A's work. REGI-003a's review said the
 * implementer "did not implement regintel/dedup.py … the diff modifies scripts/run_pipeline.py and
 * tests/test_classifier.py" — other stories' work again. team-lead-review.sh diffs the phase
 * baseline to HEAD for EVERY story, so each story is judged on everything the phase wrote; the
 * story-scoped diff (lib/review-scope.sh, the story-changes record) was wired into the change
 * review cycle and never into this reviewer.
 *
 * Drives the REAL team-lead-review.sh with a stub runner that records the prompt it is handed.
 * Two stories, two commits; the reviewer's prompt for the first must carry its own change and not
 * the second's. The baseline→HEAD diff remains the fallback for a story with no recorded commit.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPT = join(ROOT, 'orchestrations/scripts/team-lead-review.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function review() {
  const d = mkdtempSync(join(tmpdir(), 'tl-scope-')); dirs.push(d);
  const logDir = join(d, 'logs'); mkdirSync(logDir);
  const proj = join(d, 'proj'); mkdirSync(join(proj, 'regintel'), { recursive: true }); mkdirSync(join(proj, 'scripts'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: proj, encoding: 'utf8' }).trim();
  writeFileSync(join(proj, 'README.md'), 'base\n');
  git('init', '-q', '-b', 'develop'); git('add', '.'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(proj, 'regintel/api.py'), 'API_MARKER_SEVEN = 1\n');
  git('add', '.'); git('commit', '-q', '-m', 'FX-7: story complete (1 file(s))');
  const sha7 = git('rev-parse', 'HEAD');
  writeFileSync(join(proj, 'scripts/run_pipeline.py'), 'PIPELINE_MARKER_TEN = 1\n');
  git('add', '.'); git('commit', '-q', '-m', 'FX-10: story complete (1 file(s))');
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), base + '\n');
  writeFileSync(join(logDir, 'story-changes.jsonl'), JSON.stringify({ storyId: 'FX-7', sha: sha7 }) + '\n');
  // The run's own ledgers, so the reviewer derives FX-7's rung and proceeds to the model.
  writeFileSync(join(logDir, 'phase-cost.jsonl'), JSON.stringify({ story_id: 'FX-7', status: 'completed', resolvedModel: 'MiniMax-M3', effort: 'medium' }) + '\n');
  writeFileSync(join(logDir, 'agent-activity.jsonl'), JSON.stringify({ event: 'story_start', storyId: 'FX-7', provider: 'minimax', model: 'MiniMax-M3' }) + '\n');
  // The stub runner: records the prompt it was handed, answers an approval.
  const seen = join(d, 'prompt.txt'); const runner = join(d, 'runner.sh');
  writeFileSync(runner, `#!/usr/bin/env bash\ncat > "${seen}"\n[ -n "\${ORCH_JSON_RESULT:-}" ] && printf '{"result":"{\\\\"verdict\\\\":\\\\"approved\\\\",\\\\"issues\\\\":[]}","cost_usd":0}' > "$ORCH_JSON_RESULT"\nprintf '{"verdict":"approved","issues":[]}'\n`);
  chmodSync(runner, 0o755);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    project: { name: 'fixture', outputDir: proj }, implementationOrder: { core: ['FX-7'] },
    stories: [{ id: 'FX-7', jiraKey: 'FX-7', title: 'api story', description: 'd', agentRole: 'engineer', status: 'completed', completed: true,
      codelines: ['proj'], technicalNotes: { files: ['regintel/api.py'] }, verificationCriteria: ['api present'] }],
  }));
  const r = spawnSync('bash', [SCRIPT, 'core'], {
    encoding: 'utf8', timeout: 120_000, cwd: ROOT,
    env: { ...process.env, PRD_FILE: prd, PROJECT_ROOT: proj, LOG_DIR: logDir, REVIEW_LOG: join(logDir, 'code-reviews.jsonl'),
      AUTO_APPROVE: 'true', AI_RUNNER_CMD: runner, EPAM_PROJECT_CONFIG_DIR: join(ROOT, 'orchestrations/projects/metrolinx'),
      EPAM_PROVIDER_SET: 'openrouter', OPENROUTER_API_KEY: 'none', MINIMAX_API_KEY: 'none' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const prompt = existsSync(seen) ? readFileSync(seen, 'utf8') : '';
  return { out, prompt };
}

describe("the team lead reviews the story's own change", () => {
  const r = review();

  it('the reviewer was actually invoked with a prompt — otherwise nothing below is tested', () => {
    expect(r.prompt.length, r.out.slice(-1500)).toBeGreaterThan(0);
    expect(r.prompt).toContain('API_MARKER_SEVEN');
  });

  it("another story's change is not in this story's review", () => {
    expect(r.prompt, "FX-10's run_pipeline.py change was handed to FX-7's reviewer").not.toContain('PIPELINE_MARKER_TEN');
  });
});
