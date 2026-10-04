/**
 * THE ANALYSTS SEE WHERE THE DETECTIVE FOUND THE FIX.
 *
 * 2026-10-04, checked against the live AMSD-2974 calls: the writer and the reviewer receive the
 * code-graph detective's fix sites (story.fixSiteAnalysis); impl-failure-analyst and
 * agent-failure-analyst never did. They diagnosed failed attempts without knowing which files the
 * fix belongs in, which the detective said need no edit, or the minimal change it prescribed.
 *
 * One rendering (lib/handlers/fix-sites.js) for the reviewer and both analysts. EXECUTED here: the
 * handler on a PRD, and the real agent-attempt-analyst.sh rendering its real project prompt, with a
 * runner that records the prompt it is sent. impl-failure-analyst is proven where it runs — the
 * £0 multi-lane run asserts every one of its requests carries the fix sites.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintProjectPrompts } from '../../helpers/project-prompts';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const HANDLER = join(SCRIPTS, 'lib/handlers/fix-sites.js');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function prd() {
  const d = mkdtempSync(join(tmpdir(), 'fix-sites-')); dirs.push(d);
  const f = join(d, 'prd.json');
  writeFileSync(f, JSON.stringify({ stories: [
    { id: 'S-1', fixSiteAnalysis: [
      { file: 'src/toast/Toast.tsx', function: 'success', reason: 'success toasts carry no live-region role', fix: 'pass role "status" to toast.success', changeRequired: true },
      { file: 'src/pages/Layout.tsx', reason: 'mounts the container once; the fix lives in the component', changeRequired: false },
    ] },
    { id: 'S-2', fixSiteAnalysis: [{ file: 'src/other.ts', reason: 'not this story', fix: 'unrelated' }] },
  ] }));
  return { dir: d, file: f };
}

describe('one rendering of the detective\'s fix sites', () => {
  it('names each site, marks the ones needing no edit, and carries the prescribed fix — this story only', () => {
    const { file } = prd();
    const r = spawnSync(process.execPath, [HANDLER, file, 'S-1'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe([
      '- **src/toast/Toast.tsx** (`success`): success toasts carry no live-region role',
      '  - Prescribed minimal fix: pass role "status" to toast.success',
      '- **src/pages/Layout.tsx**  [NO EDIT REQUIRED — part of the fix, correctly left unchanged; never raise a finding because this file is untouched]: mounts the container once; the fix lives in the component',
    ].join('\n'));
    expect(r.stdout).not.toContain('src/other.ts');
  });

  it('a story with no findings renders nothing', () => {
    const { file } = prd();
    expect(spawnSync(process.execPath, [HANDLER, file, 'S-9'], { encoding: 'utf8' }).stdout).toBe('');
  });
});

describe('agent-failure-analyst is shown the fix sites of the story whose agent failed', () => {
  it('its prompt carries them', () => {
    const { dir, file } = prd();
    const seen = join(dir, 'prompt.txt');
    const runner = join(dir, 'runner.sh');
    writeFileSync(runner, `#!/usr/bin/env bash\ncat > ${JSON.stringify(seen)}\necho "Write the test to the named path."\n`);
    chmodSync(runner, 0o755);
    const failed = join(dir, 'failed.log'); writeFileSync(failed, 'the agent wrote prose and no file\n');
    const ctx = join(dir, 'ctx.txt'); writeFileSync(ctx, 'Write a reproducing test at src/toast/Toast.spec.tsx\n');
    const r = spawnSync('bash', [join(SCRIPTS, 'agent-attempt-analyst.sh'), 'no_file', failed, ctx], {
      encoding: 'utf8',
      env: { ...process.env, AI_RUNNER_CMD: runner, PRD_FILE: file, AGENT_ANALYST_STORY_ID: 'S-1',
        EPAM_PROJECT_CONFIG_DIR: mintProjectPrompts(), LOG_DIR: dir, NODE_BIN: process.execPath },
    });
    expect(existsSync(seen), `the analyst never called its model:\n${r.stdout}${r.stderr}`).toBe(true);
    const prompt = readFileSync(seen, 'utf8');
    expect(prompt, 'not the analyst prompt').toMatch(/FAILURE CLASS/);
    expect(prompt).toContain('Prescribed minimal fix: pass role "status" to toast.success');
    expect(prompt).toContain('[NO EDIT REQUIRED');
    expect(prompt).not.toContain('src/other.ts');
  });
});
