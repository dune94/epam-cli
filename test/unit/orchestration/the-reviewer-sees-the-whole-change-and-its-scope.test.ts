/**
 * THE REVIEWER SEES THE WHOLE CHANGE, AND WHICH OF IT IS OUTSIDE THE STORY'S SCOPE.
 *
 * regintel 20260919T224649Z: 007a's commit rewrote classifier.py (+297/−98), a file it does not
 * declare; 009's touched classifier.py and config.py. The code reviewer never saw either: its
 * diff was `git diff HEAD~5 HEAD -- <the story's DECLARED files>` — the declared list filtered
 * the out-of-scope edits out of the review, and HEAD~5 was a guess at what the story committed.
 * Scope was a convention the WriteFile tool enforced and bash bypassed; nobody judged it.
 *
 * The reviewer now gets (1) the story's own commit — the record commit_completed_story writes to
 * story-changes.jsonl — every file in it; and (2) a computed block naming each changed file the
 * story does not declare and which story does, so it can judge: an interface change the owner
 * consumes, a scope the story must declare, or an edit that belongs to the owner and must be
 * escalated. The words are the template's; the facts are git's and the PRD's.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/review-scope.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const git = (dir: string, ...a: string[]) => spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).stdout.trim();

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'review-scope-')); dirs.push(dir);
  const logs = join(dir, 'logs'); mkdirSync(logs);
  git(dir, 'init', '-q'); mkdirSync(join(dir, 'regintel'));
  writeFileSync(join(dir, 'regintel/classifier.py'), 'async def classify_event(event): ...\n');
  writeFileSync(join(dir, 'regintel/api.py'), 'app = None\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'REGI-004a: story complete');
  // 007a's commit: its own file, plus classifier.py which it does not declare.
  writeFileSync(join(dir, 'regintel/api.py'), 'app = FastAPI()\n');
  writeFileSync(join(dir, 'regintel/classifier.py'), 'def classify_event(conn, row): ...\n');
  writeFileSync(join(dir, 'regintel/pipeline.py'), 'def run_all(): ...\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'REGI-007a: story complete (3 file(s))');
  const sha = git(dir, 'rev-parse', 'HEAD');
  // A later commit by another story, so HEAD is no longer 007a's.
  writeFileSync(join(dir, 'regintel/store.py'), 'x\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'REGI-006: story complete');
  writeFileSync(join(logs, 'story-changes.jsonl'), JSON.stringify({ storyId: 'REGI-007a', sha, files: ['regintel/api.py', 'regintel/classifier.py', 'regintel/pipeline.py'] }) + '\n');
  writeFileSync(join(dir, 'prd.json'), JSON.stringify({ stories: [
    { id: 'REGI-004a', technicalNotes: { files: ['regintel/classifier.py'] } },
    { id: 'REGI-007a', technicalNotes: { files: ['regintel/api.py', 'regintel/pipeline.py'] } },
    { id: 'REGI-006', technicalNotes: { files: ['regintel/store.py'] } },
  ] }));
  return { dir, logs, sha };
}

function run(f: ReturnType<typeof fixture>, cmd: string) {
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)}; PROJECT_ROOT=${JSON.stringify(f.dir)}; LOG_DIR=${JSON.stringify(f.logs)}; PRD_FILE=${JSON.stringify(join(f.dir, 'prd.json'))}; ${cmd}`], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

describe('the diff under review is the story\'s own commit, every file of it', () => {
  it('comes from the story-changes record, not a HEAD~N guess, and is not filtered to declared files', () => {
    const f = fixture();
    const out = run(f, 'story_review_diff REGI-007a');
    expect(out).toMatch(/classifier\.py/);
    expect(out).toMatch(/api\.py/);
    expect(out).not.toMatch(/store\.py/);
  });
  it('falls back to recent history when the story has no record', () => {
    const f = fixture();
    const out = run(f, 'story_review_diff REGI-999');
    expect(out.trim()).not.toBe('');
  });
});

describe('the scope block names each changed file the story does not declare, and who does', () => {
  it('classifier.py is flagged as REGI-004a\'s; the story\'s own files are not', () => {
    const f = fixture();
    const out = run(f, 'story_scope_block REGI-007a');
    expect(out).toMatch(/regintel\/classifier\.py[^\n]*REGI-004a/);
    expect(out).not.toMatch(/api\.py/);
    expect(out).not.toMatch(/pipeline\.py/);
  });
  it('a changed file no story declares is named as such', () => {
    const f = fixture();
    writeFileSync(join(f.dir, 'prd.json'), JSON.stringify({ stories: [{ id: 'REGI-007a', technicalNotes: { files: ['regintel/api.py', 'regintel/pipeline.py'] } }] }));
    expect(run(f, 'story_scope_block REGI-007a')).toMatch(/classifier\.py[^\n]*no story/i);
  });
  it('is empty when every changed file is the story\'s own', () => {
    const f = fixture();
    writeFileSync(join(f.dir, 'prd.json'), JSON.stringify({ stories: [{ id: 'REGI-007a', technicalNotes: { files: ['regintel/api.py', 'regintel/pipeline.py', 'regintel/classifier.py'] } }] }));
    expect(run(f, 'story_scope_block REGI-007a').trim()).toBe('');
  });
  it('the words are the template layer\'s', () => {
    const f = fixture();
    const out = run(f, 'story_scope_block REGI-007a');
    const tpl = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/review-scope-block.json'), 'utf8'));
    const firstLine = String(tpl.body).split('\n').find((l: string) => l.trim() && !l.includes('__'))!.trim();
    expect(out).toContain(firstLine);
  });
});

describe('the review prompt carries both', () => {
  it('code-review-cycle renders __SCOPE_BLOCK__ from story_scope_block and the diff from story_review_diff', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/code-review-cycle.sh'), 'utf8');
    expect(src).toMatch(/story_review_diff "\$STORY_ID"/);
    expect(src).toMatch(/story_scope_block "\$STORY_ID"/);
    expect(src).toMatch(/"__SCOPE_BLOCK__":\$scope_block/);
  });
  it('the template declares __SCOPE_BLOCK__ (may be empty) and tells the reviewer what an out-of-scope edit means', () => {
    const tpl = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/code-review-cycle.json'), 'utf8'));
    expect(tpl.placeholders).toContain('__SCOPE_BLOCK__');
    expect(tpl.mayBeEmpty).toContain('__SCOPE_BLOCK__');
    expect(String(tpl.body)).toContain('__SCOPE_BLOCK__');
  });
});
