/**
 * A RUNG RECORD THAT IS GONE IS DERIVED FROM THE RUN'S OWN LEDGER — NEVER GUESSED, NEVER HAND-WRITTEN.
 *
 * regintel resume 3 (2026-09-21 12:15): pre-run-reset had wiped logs/story-rung/ on the resume, and
 * the reviewer refused REGI-001 six times — "no rung on record" — on a story the run itself had
 * completed. The reset is fixed; but the record was already gone from the live install, and the
 * operator's rule is that nobody writes a run artefact by hand.
 *
 * The run's ledgers already say what the rung was: phase-cost.jsonl holds the completed attempt's
 * resolvedModel and effort, agent-activity.jsonl the provider the story started on. story_rung_get
 * now derives the rung from them when the record file is absent, persists what it derived (marked
 * derivedFrom), and the reviewer proceeds on the setup that produced the work.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/story-outputs.sh');
const SCRIPT = join(ROOT, 'orchestrations/scripts/team-lead-review.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function ledgers(logDir: string, story = 'REGI-001') {
  writeFileSync(join(logDir, 'phase-cost.jsonl'), [
    JSON.stringify({ run_id: 'R', story_id: story, attempt: 1, status: 'attempt', resolvedModel: 'MiniMax-M3', effort: 'medium' }),
    JSON.stringify({ run_id: 'R', story_id: story, attempt: null, status: 'completed', resolvedModel: 'MiniMax-M3', effort: 'medium' }),
  ].join('\n') + '\n');
  writeFileSync(join(logDir, 'agent-activity.jsonl'), [
    JSON.stringify({ event: 'story_start', storyId: story, provider: 'minimax', model: 'MiniMax-M3' }),
    JSON.stringify({ event: 'tool_call', storyId: story, tool: 'write_file' }),
  ].join('\n') + '\n');
}

function rungGet(logDir: string, story: string, key: string) {
  const r = spawnSync('bash', ['-c', `source "${LIB}"; story_rung_get "${logDir}" "${story}" ${key}`], { encoding: 'utf8' });
  return { value: (r.stdout || '').trim(), err: r.stderr || '' };
}

describe('story_rung_get with no record file', () => {
  const d = mkdtempSync(join(tmpdir(), 'lost-rung-')); dirs.push(d);
  const logDir = join(d, 'logs'); mkdirSync(logDir); ledgers(logDir);

  it('derives the model from the completed attempt in the cost ledger', () => {
    expect(rungGet(logDir, 'REGI-001', 'model').value).toBe('MiniMax-M3');
  });
  it('derives the provider from the activity ledger', () => {
    expect(rungGet(logDir, 'REGI-001', 'provider').value).toBe('minimax');
  });
  it('persists what it derived, marked as derived — generated state is written, not recomputed forever', () => {
    rungGet(logDir, 'REGI-001', 'model');
    const f = join(logDir, 'story-rung/REGI-001.json');
    expect(existsSync(f)).toBe(true);
    const j = JSON.parse(readFileSync(f, 'utf8'));
    expect(j.model).toBe('MiniMax-M3');
    expect(j.provider).toBe('minimax');
    expect(String(j.derivedFrom || '')).toMatch(/ledger/);
  });
  it('a story the ledger never completed yields nothing — the reviewer\'s refusal stands', () => {
    expect(rungGet(logDir, 'REGI-999', 'model').value).toBe('');
    expect(existsSync(join(logDir, 'story-rung/REGI-999.json'))).toBe(false);
  });
  it('an existing record wins over the ledger', () => {
    const d2 = mkdtempSync(join(tmpdir(), 'lost-rung-')); dirs.push(d2);
    const l2 = join(d2, 'logs'); mkdirSync(join(l2, 'story-rung'), { recursive: true }); ledgers(l2);
    writeFileSync(join(l2, 'story-rung/REGI-001.json'), JSON.stringify({ model: 'z-ai/glm-5.2', provider: 'openrouter' }));
    expect(rungGet(l2, 'REGI-001', 'model').value).toBe('z-ai/glm-5.2');
  });
});

describe('the reviewer proceeds on the derived rung', () => {
  it('takes the writer\'s rung from the ledger instead of refusing', () => {
    const d = mkdtempSync(join(tmpdir(), 'lost-rung-review-')); dirs.push(d);
    const logDir = join(d, 'logs'); mkdirSync(logDir); ledgers(logDir, 'FX-1');
    const proj = join(d, 'proj'); mkdirSync(join(proj, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src/thing.ts'), 'export const thing = 1;\n');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: proj });
    git('init', '-q', '-b', 'develop'); git('add', '.'); git('commit', '-q', '-m', 'base');
    const prd = join(d, 'prd.json');
    writeFileSync(prd, JSON.stringify({
      project: { name: 'fixture', outputDir: proj }, implementationOrder: { core: ['FX-1'] },
      stories: [{ id: 'FX-1', jiraKey: 'FX-1', title: 'fixture story', description: 'd', agentRole: 'engineer',
        status: 'pending', codelines: ['proj'], technicalNotes: { files: ['src/thing.ts'] }, verificationCriteria: ['thing is exported'] }],
    }));
    const r = spawnSync('bash', [SCRIPT, 'core'], {
      encoding: 'utf8', timeout: 120_000, cwd: ROOT,
      env: { ...process.env, PRD_FILE: prd, PROJECT_ROOT: proj, LOG_DIR: logDir, REVIEW_LOG: join(logDir, 'code-reviews.jsonl'),
        AUTO_APPROVE: 'true', EPAM_PROJECT_CONFIG_DIR: join(ROOT, 'orchestrations/projects/metrolinx'),
        EPAM_PROVIDER_SET: 'openrouter', OPENROUTER_BASE_URL: 'http://127.0.0.1:9', MINIMAX_BASE_URL: 'http://127.0.0.1:9',
        OPENROUTER_API_KEY: 'none', MINIMAX_API_KEY: 'none' },
    });
    const out = (r.stdout || '') + (r.stderr || '');
    expect(out, `the reviewer still refused:\n${out.slice(-1200)}`).not.toMatch(/no rung on record for FX-1/);
    expect(out).toMatch(/takes the writer's rung for FX-1: model=MiniMax-M3 provider=minimax/);
  });
});
