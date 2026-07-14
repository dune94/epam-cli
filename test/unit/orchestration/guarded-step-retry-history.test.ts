/**
 * Cross-run prompt-eval history (2026-07-13, per the approved
 * tidy-wandering-floyd plan): guarded-step-retry records must double-write
 * to BOTH the per-run project-local file (wiped by this pipeline's own
 * "rm -rf OUTPUT_DIR" teardown convention before every fresh launch) AND a
 * persistent, engine-side history file (orchestrations/logs/, repo-relative
 * to epam-cli — survives target-project teardown), tagged with runId +
 * promptVersion (the epam-cli repo's own short git SHA), so a prompt's
 * violation rate can be measured across runs instead of destroyed on relaunch.
 *
 * Covers both implementations of the same double-write contract:
 *   - _log_guarded_step_retry() in run-agent-orchestration.sh (bash sites)
 *   - logGuardedStepRetry() in spec-mode-runner.js (ac-review JS site)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const SPEC_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

const realGitSha = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

function extractFunctionBody(src: string, name: string): string {
  const defRe = new RegExp(`^${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(src);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = src.indexOf('\n}', start) + 2;
  return src.slice(start, end);
}

describe('_epam_prompt_version() / _log_guarded_step_retry() — bash, real execution', () => {
  function run(scriptDirRelToRepo: string, runId: string, jsonLine: string): {
    perRun: string;
    history: string;
    historyDir: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'guarded-step-history-'));
    try {
      const logDir = join(dir, 'run-output');
      mkdirSync(logDir, { recursive: true });
      // SCRIPT_DIR must resolve "$SCRIPT_DIR/.." to the real epam-cli repo
      // root (for the git SHA lookup) and "$SCRIPT_DIR/../logs" to a
      // throwaway history dir, not the real orchestrations/logs — use the
      // real orchestrations/scripts dir as SCRIPT_DIR but redirect the
      // history file's parent via a symlink-free override: pass a distinct
      // HISTORY_DIR and have the harness script cd there instead.
      const historyDir = join(dir, 'history-logs');

      const versionFnBody = extractFunctionBody(orchSrc, '_epam_prompt_version');
      const logFnBody = extractFunctionBody(orchSrc, '_log_guarded_step_retry');
      // Rewrite every "$SCRIPT_DIR/../logs" substring (both the `mkdir -p`
      // target AND the `echo >> ".../logs/guarded-step-retries-history.jsonl"`
      // target -- NOT the same string, the latter has a longer suffix after
      // "logs" before its closing quote) to our throwaway historyDir, so this
      // test NEVER touches the real engine-side history file, while keeping
      // SCRIPT_DIR pointed at the real scripts/ dir so the git SHA lookup
      // ("$SCRIPT_DIR/..") resolves to the real repo.
      const logFnBodyIsolated = logFnBody.replace(/\$SCRIPT_DIR\/\.\.\/logs/g, historyDir);

      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `SCRIPT_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts'))}`,
          `LOG_DIR=${JSON.stringify(logDir)}`,
          `ORCH_RUN_ID=${JSON.stringify(runId)}`,
          versionFnBody,
          logFnBodyIsolated,
          `_log_guarded_step_retry ${JSON.stringify(jsonLine)}`,
        ].join('\n'),
      );

      execFileSync('bash', [scriptPath], { encoding: 'utf8' });

      const perRun = readFileSync(join(logDir, 'guarded-step-retries.jsonl'), 'utf8');
      const history = existsSync(join(historyDir, 'guarded-step-retries-history.jsonl'))
        ? readFileSync(join(historyDir, 'guarded-step-retries-history.jsonl'), 'utf8')
        : '';
      return { perRun, history, historyDir };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('writes the SAME augmented record to both the per-run file and the persistent history file', () => {
    const { perRun, history } = run('scripts', 'run-abc', '{"step":"0.5","phaseId":"core","attempts":2,"outcome":"pass","reason":""}');
    const perRunObj = JSON.parse(perRun.trim());
    const historyObj = JSON.parse(history.trim());
    expect(perRunObj).toEqual(historyObj);
    expect(perRunObj.step).toBe('0.5');
    expect(perRunObj.outcome).toBe('pass');
  });

  it('tags the record with runId (from ORCH_RUN_ID) and promptVersion (the real epam-cli short git SHA)', () => {
    const { perRun } = run('scripts', 'run-xyz-42', '{"step":"0.9","phaseId":"core","attempts":1,"outcome":"noop","reason":""}');
    const obj = JSON.parse(perRun.trim());
    expect(obj.runId).toBe('run-xyz-42');
    expect(obj.promptVersion).toBe(realGitSha);
  });

  it('APPENDS to the history file across multiple calls (different runs never clobber each other)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guarded-step-history-append-'));
    try {
      const logDir = join(dir, 'run-output');
      mkdirSync(logDir, { recursive: true });
      const historyDir = join(dir, 'history-logs');
      const versionFnBody = extractFunctionBody(orchSrc, '_epam_prompt_version');
      const logFnBody = extractFunctionBody(orchSrc, '_log_guarded_step_retry').replace(
        /\$SCRIPT_DIR\/\.\.\/logs/g,
        historyDir,
      );
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `SCRIPT_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts'))}`,
          `LOG_DIR=${JSON.stringify(logDir)}`,
          'ORCH_RUN_ID=run-1',
          versionFnBody,
          logFnBody,
          `_log_guarded_step_retry '{"step":"0.5","phaseId":"core","attempts":1,"outcome":"pass","reason":""}'`,
          'ORCH_RUN_ID=run-2',
          `_log_guarded_step_retry '{"step":"0.9","phaseId":"core","attempts":3,"outcome":"reverted","reason":""}'`,
        ].join('\n'),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const lines = readFileSync(join(historyDir, 'guarded-step-retries-history.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0].runId).toBe('run-1');
      expect(lines[1].runId).toBe('run-2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to "unknown" runId when ORCH_RUN_ID is unset (never crashes the pipeline)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guarded-step-history-nounset-'));
    try {
      const logDir = join(dir, 'run-output');
      mkdirSync(logDir, { recursive: true });
      const historyDir = join(dir, 'history-logs');
      const versionFnBody = extractFunctionBody(orchSrc, '_epam_prompt_version');
      const logFnBody = extractFunctionBody(orchSrc, '_log_guarded_step_retry').replace(
        /\$SCRIPT_DIR\/\.\.\/logs/g,
        historyDir,
      );
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `SCRIPT_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts'))}`,
          `LOG_DIR=${JSON.stringify(logDir)}`,
          versionFnBody,
          logFnBody,
          `_log_guarded_step_retry '{"step":"tc-writer-inline","storyId":"SKY-001","attempts":1,"outcome":"pass"}'`,
        ].join('\n'),
      );
      const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(stdout).toBe('');
      const obj = JSON.parse(readFileSync(join(logDir, 'guarded-step-retries.jsonl'), 'utf8').trim());
      expect(obj.runId).toBe('unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('promptVersion() — spec-mode-runner.js, real execution against the REAL repo (no file writes, safe to require directly)', () => {
  it('returns the real epam-cli short git SHA', () => {
    const scriptPath = join(tmpdir(), `prompt-version-check-${process.pid}.js`);
    writeFileSync(
      scriptPath,
      `const { promptVersion } = require(${JSON.stringify(SPEC_RUNNER)});\nprocess.stdout.write(promptVersion());`,
    );
    try {
      const out = execFileSync('node', [scriptPath], { encoding: 'utf8' });
      expect(out).toBe(realGitSha);
    } finally {
      rmSync(scriptPath, { force: true });
    }
  });
});

describe('logGuardedStepRetry() — spec-mode-runner.js, real execution against an ISOLATED copy', () => {
  // logGuardedStepRetry()'s history path is `path.join(__dirname, '..', 'logs')`
  // -- Node resolves __dirname to the REQUIRED module's own location, not the
  // caller's, so requiring the real spec-mode-runner.js directly would write
  // into the actual orchestrations/logs/ directory. To exercise the double-
  // write for real without touching that file, copy spec-mode-runner.js into
  // a throwaway directory that mirrors the real relative layout
  // (fake-repo/orchestrations/scripts/spec-mode-runner.js, so `__dirname/../logs`
  // resolves to fake-repo/orchestrations/logs) with its own tiny git repo (so
  // the git-SHA lookup succeeds instead of silently falling back to "unknown").
  function setupIsolatedCopy(): { fakeRepo: string; scriptsDir: string; logsDir: string } {
    const fakeRepo = mkdtempSync(join(tmpdir(), 'guarded-step-history-js-'));
    const scriptsDir = join(fakeRepo, 'orchestrations', 'scripts');
    const logsDir = join(fakeRepo, 'orchestrations', 'logs');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'spec-mode-runner.js'), readFileSync(SPEC_RUNNER, 'utf8'));
    execFileSync('git', ['init', '-q'], { cwd: fakeRepo });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: fakeRepo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: fakeRepo });
    writeFileSync(join(fakeRepo, 'README.md'), 'fixture');
    execFileSync('git', ['add', '.'], { cwd: fakeRepo });
    execFileSync('git', ['commit', '-q', '-m', 'fixture commit'], { cwd: fakeRepo });
    return { fakeRepo, scriptsDir, logsDir };
  }

  function callLogGuardedStepRetry(scriptsDir: string, logDir: string, runId: string, record: Record<string, unknown>) {
    const scriptPath = join(logDir, '..', 'call.js');
    writeFileSync(
      scriptPath,
      [
        `const { logGuardedStepRetry } = require(${JSON.stringify(join(scriptsDir, 'spec-mode-runner.js'))});`,
        `logGuardedStepRetry(${JSON.stringify(logDir)}, ${JSON.stringify({ runId, ...record })});`,
      ].join('\n'),
    );
    execFileSync('node', [scriptPath], { encoding: 'utf8' });
    rmSync(scriptPath, { force: true });
  }

  it('writes the SAME augmented record to both the per-run file and the persistent history file', () => {
    const { fakeRepo, scriptsDir, logsDir } = setupIsolatedCopy();
    try {
      const logDir = join(fakeRepo, 'run-output');
      mkdirSync(logDir, { recursive: true });
      callLogGuardedStepRetry(scriptsDir, logDir, 'run-js-1', {
        step: 'ac-review', storyId: 'SKY-002', agent: 'openspec', attempts: 2, outcome: 'reverted', reason: 'x', violationTypes: ['content_quality'],
      });
      const perRun = JSON.parse(readFileSync(join(logDir, 'guarded-step-retries.jsonl'), 'utf8').trim());
      const history = JSON.parse(readFileSync(join(logsDir, 'guarded-step-retries-history.jsonl'), 'utf8').trim());
      expect(perRun).toEqual(history);
      expect(perRun.step).toBe('ac-review');
      expect(perRun.violationTypes).toEqual(['content_quality']);
      expect(perRun.runId).toBe('run-js-1');
      expect(typeof perRun.promptVersion).toBe('string');
      expect(perRun.promptVersion.length).toBeGreaterThan(0);
      expect(perRun.promptVersion).not.toBe('unknown');
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  it('APPENDS to the history file across multiple calls (different runs never clobber each other)', () => {
    const { fakeRepo, scriptsDir, logsDir } = setupIsolatedCopy();
    try {
      const logDir = join(fakeRepo, 'run-output');
      mkdirSync(logDir, { recursive: true });
      callLogGuardedStepRetry(scriptsDir, logDir, 'run-1', { step: 'ac-review', storyId: 'SKY-002', outcome: 'pass', attempts: 1 });
      callLogGuardedStepRetry(scriptsDir, logDir, 'run-2', { step: 'ac-review', storyId: 'SKY-003', outcome: 'reverted', attempts: 3 });
      const lines = readFileSync(join(logsDir, 'guarded-step-retries-history.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0].runId).toBe('run-1');
      expect(lines[1].runId).toBe('run-2');
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });
});

describe('spec-mode-runner.js ac-review call site — wired to logGuardedStepRetry, not raw appendJsonl', () => {
  const src = readFileSync(SPEC_RUNNER, 'utf8');

  it('the ac-review guarded-step-retry write uses logGuardedStepRetry (double-write), not a raw appendJsonl call', () => {
    const idx = src.indexOf("step: 'ac-review'");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, idx - 200), idx);
    expect(block).toMatch(/logGuardedStepRetry\(logDir,\s*\{/);
  });

  it('the ac-review record includes a violationTypes array (content_quality vocabulary)', () => {
    const idx = src.indexOf("step: 'ac-review'");
    const block = src.slice(idx, idx + 600);
    expect(block).toMatch(/violationTypes:/);
    expect(block).toContain('content_quality');
  });
});
