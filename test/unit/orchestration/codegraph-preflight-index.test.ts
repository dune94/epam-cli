/**
 * codegraph-preflight-index.sh — hard gate: every candidate codeline must be
 * CodeGraph-indexed before codeline-discovery.js scores them, or the whole
 * launch aborts. Real git repos, real bash execution — no mocking.
 *
 * Live bug this closes (2026-07-22): codeline-discovery's scorer gave a repo
 * missing its CodeGraph index a score of zero on the CodeGraph tier — not
 * because it was irrelevant, but because nobody had indexed it. The real
 * AMSD-1820 fix site (azure.commerce.cdts) was never indexed, never made the
 * top-8 candidates, and the wrong repo got selected instead.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPT_PATH = join(REPO_ROOT, 'orchestrations/scripts/codegraph-preflight-index.sh');

function hasRealCodegraphBinary(): boolean {
  try {
    return spawnSync('which', ['codegraph'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}
const CODEGRAPH_PRESENT = hasRealCodegraphBinary();

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeGitRepo(root: string, name: string, withSource = true): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  if (withSource) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir });
  return dir;
}

function runPreflight(root: string, env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('bash', [SCRIPT_PATH, root], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60000,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status ?? -1 };
}

describe('codegraph-preflight-index.sh — real git repos, real codegraph binary', () => {
  it('indexes a repo that has no .codegraph/codegraph.db yet and exits 0', () => {
    if (!CODEGRAPH_PRESENT) return;
    const root = mkdtempSync(join(tmpdir(), 'preflight-index-'));
    cleanupDirs.push(root);
    const repo = makeGitRepo(root, 'needs-indexing');

    expect(existsSync(join(repo, '.codegraph', 'codegraph.db'))).toBe(false);

    const { stdout, exitCode } = runPreflight(root);
    expect(exitCode, `stdout+stderr:\n${stdout}`).toBe(0);
    expect(existsSync(join(repo, '.codegraph', 'codegraph.db'))).toBe(true);
    expect(stdout).toMatch(/Indexing needs-indexing/);
    expect(stdout).toMatch(/OK: needs-indexing indexed/);
  });

  it('skips a repo that already has an index (no re-indexing work)', () => {
    if (!CODEGRAPH_PRESENT) return;
    const root = mkdtempSync(join(tmpdir(), 'preflight-skip-'));
    cleanupDirs.push(root);
    const repo = makeGitRepo(root, 'already-indexed');
    execFileSync('codegraph', ['init', repo], { encoding: 'utf8', timeout: 30000 });
    const dbPath = join(repo, '.codegraph', 'codegraph.db');
    expect(existsSync(dbPath)).toBe(true);
    const mtimeBefore = require('node:fs').statSync(dbPath).mtimeMs;

    const { stdout, exitCode } = runPreflight(root);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/1 already indexed, 0 indexed just now/);
    // Must not have been touched/rebuilt
    expect(require('node:fs').statSync(dbPath).mtimeMs).toBe(mtimeBefore);
  });

  it('excludes docs.* repos from indexing (same scope exclusion as codeline-discovery.js)', () => {
    if (!CODEGRAPH_PRESENT) return;
    const root = mkdtempSync(join(tmpdir(), 'preflight-docs-'));
    cleanupDirs.push(root);
    makeGitRepo(root, 'docs.something');
    makeGitRepo(root, 'real-repo');

    const { stdout, exitCode } = runPreflight(root);
    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(/Indexing docs\.something/);
    expect(stdout).toMatch(/Checked 1 repo/);
  });

  it('skips non-git directories entirely', () => {
    if (!CODEGRAPH_PRESENT) return;
    const root = mkdtempSync(join(tmpdir(), 'preflight-nongit-'));
    cleanupDirs.push(root);
    mkdirSync(join(root, 'not-a-repo'), { recursive: true });
    writeFileSync(join(root, 'not-a-repo', 'file.txt'), 'hello');

    const { stdout, exitCode } = runPreflight(root);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Checked 0 repo/);
  });

  it('aborts (exit 1) when the codegraph binary is not on PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-nobin-'));
    cleanupDirs.push(root);
    makeGitRepo(root, 'some-repo');

    // Run with an empty-ish PATH that excludes codegraph, but keep enough
    // for bash builtins (mktemp not needed here, but `dirname`, `basename`
    // etc are bash builtins so this is safe).
    const strippedPath = '/usr/bin:/bin';
    const { stderr, exitCode } = runPreflight(root, { PATH: strippedPath });
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/ABORT.*codegraph binary not found/);
  });

  it('aborts (exit 1) when indexing genuinely fails for a repo, and names it', () => {
    if (!CODEGRAPH_PRESENT) return;
    const root = mkdtempSync(join(tmpdir(), 'preflight-failindex-'));
    cleanupDirs.push(root);
    // A "repo" whose .git exists but is corrupt/empty enough that codegraph
    // init should fail against it (no valid git object database).
    const badRepo = join(root, 'corrupt-repo');
    mkdirSync(join(badRepo, '.git'), { recursive: true }); // .git dir but not a real git repo
    writeFileSync(join(badRepo, 'package.json'), '{}');

    const { stdout, stderr, exitCode } = runPreflight(root);
    // Whether codegraph tolerates a malformed .git or not is not something
    // we assert either way here — only that IF it fails, the script reports
    // and aborts rather than silently continuing.
    if (exitCode !== 0) {
      expect(stderr).toMatch(/ABORT.*corrupt-repo/);
    } else {
      expect(stdout).toMatch(/Checked 1 repo/);
    }
  });

  it('exits non-zero when the codeline root itself does not exist', () => {
    const { stderr, exitCode } = runPreflight('/definitely/does/not/exist/anywhere');
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/ABORT.*does not exist/);
  });

  it('run 10x in a row against fresh repos each time — deterministic outcome every time', () => {
    if (!CODEGRAPH_PRESENT) return;
    const RUNS = 10;
    const outcomes: { indexed: boolean; exitCode: number }[] = [];
    for (let i = 0; i < RUNS; i++) {
      const root = mkdtempSync(join(tmpdir(), `preflight-loop-${i}-`));
      try {
        const repo = makeGitRepo(root, 'repeat-target');
        const { exitCode } = runPreflight(root);
        outcomes.push({
          indexed: existsSync(join(repo, '.codegraph', 'codegraph.db')),
          exitCode,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const failures = outcomes.filter(o => o.exitCode !== 0 || !o.indexed);
    expect(failures, `${failures.length}/${RUNS} runs failed: ${JSON.stringify(outcomes)}`).toHaveLength(0);
    expect(outcomes).toHaveLength(RUNS);
  }, 120000);
});

describe('tier3-metrolinx-run.sh — CodeGraph preflight wiring and ordering', () => {
  const src = require('node:fs').readFileSync(
    join(REPO_ROOT, 'orchestrations/scripts/tier3-metrolinx-run.sh'),
    'utf8'
  );

  it('calls codegraph-preflight-index.sh and aborts the launch on failure', () => {
    expect(src).toMatch(/codegraph-preflight-index\.sh/);
    expect(src).toMatch(/bash\s*"\$SCRIPT_DIR\/codegraph-preflight-index\.sh"[\s\S]{0,600}fail\s+/);
  });

  it('CodeGraph preflight runs AFTER the teardown/reset loop, never before', () => {
    // Indexing before teardown would build an index of a tree state that
    // teardown then overwrites — the index would no longer match the files
    // codeline-discovery actually scores.
    const teardownIdx = src.indexOf('brownfield-preflight-reset.sh');
    const codegraphIdx = src.indexOf('codegraph-preflight-index.sh');
    expect(teardownIdx).toBeGreaterThan(-1);
    expect(codegraphIdx).toBeGreaterThan(-1);
    expect(codegraphIdx).toBeGreaterThan(teardownIdx);
  });

  it('CodeGraph preflight runs AFTER the dashboard-wiring step (pre-run-reset.sh), so its events land in the freshly-reset agent-status.json', () => {
    // pre-run-reset.sh resets agent-status.json. Emitting preflight events
    // before that reset would have them wiped a moment later.
    const resetIdx     = src.indexOf('pre-run-reset.sh');
    const codegraphIdx = src.indexOf('codegraph-preflight-index.sh');
    expect(resetIdx).toBeGreaterThan(-1);
    expect(codegraphIdx).toBeGreaterThan(resetIdx);
  });

  it('emits agent-activity events for preflight start, pass, and failure — visible on the dashboard, not just in a log file', () => {
    expect(src).toMatch(/_emit_preflight_event/);
    expect(src).toMatch(/CodeGraph preflight started/);
    expect(src).toMatch(/CodeGraph preflight passed/);
    expect(src).toMatch(/CodeGraph preflight FAILED/);
    // Must write into the same events[] array / file the rest of the
    // pipeline's monitor events use, not a separate ad hoc file.
    expect(src).toMatch(/MONITOR_FILE.*agent-status\.json/);
    expect(src).toMatch(/\.events \+= \[/);
  });

  it('_emit_preflight_event, extracted and run for real, actually appends valid events to agent-status.json', () => {
    // Real functional proof, not just a source-text match: extract the
    // function verbatim and execute it against a real monitor file.
    const start = src.indexOf('_emit_preflight_event() {');
    const end = src.indexOf('\n}', start) + 2;
    expect(start).toBeGreaterThan(-1);
    const fnBody = src.slice(start, end);

    const dir = mkdtempSync(join(tmpdir(), 'emit-preflight-test-'));
    try {
      const monitorFile = join(dir, 'agent-status.json');
      writeFileSync(monitorFile, JSON.stringify({
        startedAt: null, phase: null, orchMode: null, lanes: {}, events: [], stories: {},
      }));
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, [
        '#!/usr/bin/env bash',
        fnBody,
        '_emit_preflight_event "first event"',
        '_emit_preflight_event "second event"',
      ].join('\n'));

      const result = spawnSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, MONITOR_FILE: monitorFile },
      });
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);

      const out = JSON.parse(readFileSync(monitorFile, 'utf8'));
      expect(out.events).toHaveLength(2);
      expect(out.events[0].message).toBe('first event');
      expect(out.events[1].message).toBe('second event');
      expect(out.events[0].lane).toBe('preflight');
      expect(out.events[0].role).toBe('codegraph-preflight');
      expect(out.events[0].timestamp).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
