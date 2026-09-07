/**
 * A RUN RECORDS WHAT IT WROTE, AT THE MOMENT IT WRITES IT.
 *
 * THE LIVE DEFECT (Successful-Run-Sept-07-1, AMSD-1919). The run passed, committed one file and
 * its repro gate proved the fix — and code.html reported "FILES CHANGED 0", "LINES 0/0" and
 * "not recorded" for both the change and the fix site. The narrative said the same. run-facts.json
 * held `commits: []`, `manifest: []`, `diff` absent.
 *
 * WHY. generate-run-report.py never recorded what the story wrote. It RECONSTRUCTED the diff at
 * report time: `git log <baseline>..HEAD` against the LIVE codeline, with the baseline read from
 * orchestrations/logs/phase-baseline-sha.txt — one mutable file every run and every phase
 * overwrites — and HEAD meaning "whatever the shared codeline is at right now". The codeline is
 * reset to origin/develop at the start of each cycle. By report time that pair no longer brackets
 * the story, so the range is empty and every derived number renders as a confident zero.
 *
 * That silent zero is the failure the report exists to prevent: it is indistinguishable from
 * "this run changed nothing", which is the shape of a false pass.
 *
 * THE RULE (standing): anything the pipeline generates is written to disk AT GENERATION TIME, in
 * a place a later reset cannot invalidate. The commit is the moment; git-ops records there.
 *
 * BOTH ENDS. A caller test alone is a guess, so this asserts the producer writes the record, the
 * consumer reads it, and — the case that actually failed — the consumer still reports the truth
 * when the live codeline has moved on underneath it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(process.cwd(), 'orchestrations', 'scripts');
const REPORT = join(SCRIPTS, 'generate-run-report.py');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(p: string): string {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

/** A real codeline: a baseline commit, then a story commit that changes one file. */
function codelineWithStory(): { root: string; baseline: string; head: string } {
  const root = tmp('cl-');
  git(root, 'init', '-q', '-b', 'develop', '.');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 'T');
  writeFileSync(join(root, 'app.ts'), 'export const n = 1\nexport const keep = 2\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'baseline');
  const baseline = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'app.ts'), 'export const n = 42\nexport const keep = 2\nexport const added = 3\n');
  return { root, baseline, head: '' };
}

/**
 * Runs the REAL commit_completed_story from lib/git-ops.sh against a real repo, with LOG_DIR set,
 * and returns the recorded story-changes lines. The function is lifted whole — the point is what
 * the shipped code does at the commit, not a re-implementation of it.
 */
function commitStory(root: string, logDir: string, storyId = 'AMSD-1919'): any[] {
  const drive = join(tmp('drv-'), 'drive.sh');
  writeFileSync(drive, [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    'log() { :; }; warning() { echo "WARN: $*" >&2; }; error() { echo "ERR: $*" >&2; }',
    `PROJECT_ROOT=${JSON.stringify(root)}`,
    `GIT_WORK_ROOT=${JSON.stringify(root)}`,
    `LOG_DIR=${JSON.stringify(logDir)}`,
    `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}`,
    'SKIP_SECRET_SCAN=true',
    `. ${JSON.stringify(join(SCRIPTS, 'lib', 'git-ops.sh'))}`,
    `commit_completed_story ${JSON.stringify(storyId)}`,
  ].join('\n'));
  execFileSync('bash', [drive], { encoding: 'utf8', timeout: 60_000, stdio: 'pipe' });

  const f = join(logDir, 'story-changes.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Runs the real report generator and returns its run-facts plus the rendered code page. */
function report(opts: { codeline: string; baseline: string; logsDir: string }):
    { facts: any; code: string } {
  const out = tmp('out-');
  const logFile = join(tmp('log-'), 'run.log');
  writeFileSync(logFile, [
    "Codeline 'gotransit' → " + opts.codeline,
    'AMSD-1919: the test reproduces the bug (fails on baseline, passes with the fix) — gate passed.',
  ].join('\n'));
  execFileSync('python3', [REPORT,
    '--launch-log', logFile, '--logs-dir', opts.logsDir,
    '--codeline', opts.codeline, '--baseline', opts.baseline,
    '--out', out,
  ], { encoding: 'utf8', timeout: 120_000, stdio: 'pipe' });
  return {
    facts: JSON.parse(readFileSync(join(out, 'run-facts.json'), 'utf8')),
    code: readFileSync(join(out, 'code.html'), 'utf8'),
  };
}

describe('a run records what it wrote', () => {
  it('PRODUCER: the commit records the story\'s own changes where a later reset cannot reach', () => {
    const { root } = codelineWithStory();
    const logDir = tmp('logs-');
    const rows = commitStory(root, logDir);

    expect(rows.length, 'the commit recorded nothing — the report has only the live codeline to '
      + 'go on, which is exactly the defect').toBe(1);
    const r = rows[0];
    expect(r.storyId).toBe('AMSD-1919');
    expect(r.sha, 'no commit sha recorded').toMatch(/^[0-9a-f]{7,40}$/);
    expect(r.sha, 'the recorded sha is not the commit that was just made')
      .toBe(git(root, 'rev-parse', 'HEAD'));
    expect(r.files, 'the changed file was not recorded').toEqual(['app.ts']);
    expect(r.insertions, 'insertions not recorded').toBe(2);
    expect(r.deletions, 'deletions not recorded').toBe(1);
    expect(String(r.diff), 'the diff itself was not recorded').toContain('export const n = 42');
  });

  it('THE DEFECT: the report is still right after the codeline is reset underneath it', () => {
    // This is the live failure, reproduced exactly: the story commits, then the codeline is reset
    // to develop for the next cycle, and only THEN does the report run. Reconstructing from
    // <baseline>..HEAD yields an empty range here — the recorded artefact is the only truth left.
    const { root, baseline } = codelineWithStory();
    const logDir = tmp('logs-');
    commitStory(root, logDir);

    git(root, 'reset', '--hard', baseline);   // the next cycle's reset
    expect(git(root, 'rev-parse', 'HEAD'), 'fixture did not actually reset').toBe(baseline);

    const { facts, code } = report({ codeline: root, baseline, logsDir: logDir });

    expect(facts.commits.length, 'the run reported no commits for a story that committed one')
      .toBe(1);
    expect(facts.manifest, 'the run reported no changed files for a story that changed one')
      .toEqual(['app.ts']);
    expect(code, 'the page still claims zero files changed').not.toMatch(
      /Files changed<\/div><div class="v">0</);
    expect(code, 'the real changed file is not on the page').toContain('app.ts');
    expect(code, 'the diff is missing from the page').toContain('export const n = 42');
  });

  it('a nothing-recorded run says so, instead of rendering zero as a fact', () => {
    // No record, and a baseline that brackets nothing. The page must not present that as
    // "0 files changed" — indistinguishable from a real no-op, and the shape of a false pass.
    const { root, baseline } = codelineWithStory();
    const logDir = tmp('logs-');   // empty: nothing was ever recorded
    git(root, 'checkout', '-q', '.');

    const { code } = report({ codeline: root, baseline, logsDir: logDir });
    expect(code, 'a run with no recorded change rendered a confident zero')
      .toMatch(/not recorded|unavailable|MISSING/i);
  });
});
