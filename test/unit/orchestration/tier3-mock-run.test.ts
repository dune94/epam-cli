/**
 * tier3-mock-run.sh — real execution of the actual, unmodified wrapper
 * script against stubbed pre-run-reset.sh / run-agent-orchestration.sh, to
 * prove it follows the EXACT same sequence every real tier3-*-run.sh uses
 * (pre-run-reset.sh first, then run-agent-orchestration.sh with self-heal
 * retry on exit 2) — not a source-text regex check, a real call-order test.
 *
 * The stubs live in a temp directory that mirrors this repo's own
 * orchestrations/scripts/ layout (tier3-mock-run.sh computes REPO_ROOT as
 * two directories up from its own location and calls its sibling scripts by
 * relative path) — the REAL tier3-mock-run.sh file is copied in verbatim
 * and executed unmodified; only its two real dependencies are stubbed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const REAL_SCRIPTS = join(REPO_ROOT, 'orchestrations/scripts');
const REAL_WRAPPER = join(REPO_ROOT, 'orchestrations/scripts/tier3-mock-run.sh');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeStubbedRepo(opts: {
  runAgentOrchExitCode?: number | number[]; // sequential exit codes across invocations
}): { repoRoot: string; callLogPath: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'tier3-mock-run-test-'));
  cleanupDirs.push(repoRoot);
  const scriptsDir = join(repoRoot, 'orchestrations/scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const callLogPath = join(repoRoot, 'calls.log');

  copyFileSync(REAL_WRAPPER, join(scriptsDir, 'tier3-mock-run.sh'));
  chmodSync(join(scriptsDir, 'tier3-mock-run.sh'), 0o755);

  // The REAL preflight helper, not a stub: the launcher must abort when the pre-flight
  // fails, and stubbing the helper would test nothing about that. Only the CHECK itself is
  // stubbed, since a temp fixture is not a repo with a dist/, a project config or a
  // dashboard to assess.
  const libDir = join(scriptsDir, 'lib');
  mkdirSync(libDir, { recursive: true });
  copyFileSync(join(REAL_SCRIPTS, 'lib/preflight.sh'), join(libDir, 'preflight.sh'));
  writeFileSync(
    join(scriptsDir, 'preflight-check.sh'),
    `#!/usr/bin/env bash\necho "preflight-check.sh $*" >> ${JSON.stringify(callLogPath)}\nexit \${PREFLIGHT_EXIT:-0}\n`,
  );
  chmodSync(join(scriptsDir, 'preflight-check.sh'), 0o755);

  writeFileSync(
    join(scriptsDir, 'pre-run-reset.sh'),
    `#!/usr/bin/env bash\necho "pre-run-reset.sh $*" >> ${JSON.stringify(callLogPath)}\nexit 0\n`,
  );
  chmodSync(join(scriptsDir, 'pre-run-reset.sh'), 0o755);

  const exitCodes = Array.isArray(opts.runAgentOrchExitCode)
    ? opts.runAgentOrchExitCode
    : [opts.runAgentOrchExitCode ?? 0];
  writeFileSync(
    join(scriptsDir, 'run-agent-orchestration.sh'),
    [
      '#!/usr/bin/env bash',
      `echo "run-agent-orchestration.sh $*" >> ${JSON.stringify(callLogPath)}`,
      `COUNT_FILE=${JSON.stringify(join(repoRoot, 'invoke-count'))}`,
      'N=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)',
      'echo $((N + 1)) > "$COUNT_FILE"',
      `CODES=(${exitCodes.join(' ')})`,
      'IDX=$N',
      '[ "$IDX" -ge "${#CODES[@]}" ] && IDX=$((${#CODES[@]} - 1))',
      'exit "${CODES[$IDX]}"',
    ].join('\n'),
  );
  chmodSync(join(scriptsDir, 'run-agent-orchestration.sh'), 0o755);

  return { repoRoot, callLogPath };
}

function runWrapper(
  repoRoot: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { rc: number; output: string } {
  const wrapperPath = join(repoRoot, 'orchestrations/scripts/tier3-mock-run.sh');
  const result = spawnSync('bash', [wrapperPath, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...extraEnv },
  });
  return { rc: result.status ?? -1, output: (result.stdout || '') + (result.stderr || '') };
}

describe('tier3-mock-run.sh — real execution, exact call sequence vs stubbed dependencies', () => {
  it('calls pre-run-reset.sh --prd <path> BEFORE run-agent-orchestration.sh, in that order', () => {
    const { repoRoot, callLogPath } = makeStubbedRepo({ runAgentOrchExitCode: 0 });
    const { rc, output } = runWrapper(repoRoot, [
      '--prd', '/tmp/fake-prd.json',
      '--project-root', '/tmp/fake-project',
      '--phase', 'test_phase',
    ]);
    expect(rc, output).toBe(0);
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n');
    // The pre-flight assessment runs FIRST, ahead of the reset: assessing a project after
    // tearing its state down assesses the wrong thing.
    expect(calls[0]).toMatch(/^pre-run-reset\.sh --prd \/tmp\/fake-prd\.json$/);
    // The pre-flight assessment sits between the reset and the pipeline, so it assesses the
    // state the run will actually start from.
    expect(calls[1]).toMatch(/^preflight-check\.sh /);
    expect(calls[2]).toMatch(/^run-agent-orchestration\.sh --phase test_phase --reset$/);
  });

  it('exports PRD_FILE and PROJECT_ROOT from the --prd/--project-root args before invoking run-agent-orchestration.sh', () => {
    const { repoRoot } = makeStubbedRepo({ runAgentOrchExitCode: 0 });
    // Replace the run-agent-orchestration.sh stub to print the env vars it actually received.
    writeFileSync(
      join(repoRoot, 'orchestrations/scripts/run-agent-orchestration.sh'),
      '#!/usr/bin/env bash\necho "PRD_FILE=$PRD_FILE"\necho "PROJECT_ROOT=$PROJECT_ROOT"\nexit 0\n',
    );
    chmodSync(join(repoRoot, 'orchestrations/scripts/run-agent-orchestration.sh'), 0o755);
    const { rc, output } = runWrapper(repoRoot, [
      '--prd', '/tmp/xyz/prd.json',
      '--project-root', '/tmp/xyz/clone',
      '--phase', 'p',
    ]);
    expect(rc, output).toBe(0);
    expect(output).toContain('PRD_FILE=/tmp/xyz/prd.json');
    expect(output).toContain('PROJECT_ROOT=/tmp/xyz/clone');
  });

  it('on exit code 2 (gate escalation), retries ONCE with SKIP_GATE_REMEDIATION=1 — same self-heal contract as tier3-metrolinx-run.sh', () => {
    const { repoRoot, callLogPath } = makeStubbedRepo({ runAgentOrchExitCode: [2, 0] });
    writeFileSync(
      join(repoRoot, 'orchestrations/scripts/run-agent-orchestration.sh'),
      [
        '#!/usr/bin/env bash',
        `echo "run-agent-orchestration.sh $* SKIP_GATE_REMEDIATION=${'$'}{SKIP_GATE_REMEDIATION:-unset}" >> ${JSON.stringify(callLogPath)}`,
        `COUNT_FILE=${JSON.stringify(join(repoRoot, 'invoke-count'))}`,
        'N=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)',
        'echo $((N + 1)) > "$COUNT_FILE"',
        '[ "$N" -eq 0 ] && exit 2',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(join(repoRoot, 'orchestrations/scripts/run-agent-orchestration.sh'), 0o755);

    const { rc, output } = runWrapper(repoRoot, [
      '--prd', '/tmp/fake-prd.json',
      '--project-root', '/tmp/fake-project',
      '--phase', 'test_phase',
    ]);
    expect(rc, output).toBe(0);
    expect(output).toMatch(/Self-healing.*retry/);
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n');
    const orchCalls = calls.filter(c => c.startsWith('run-agent-orchestration.sh'));
    expect(orchCalls).toHaveLength(2);
    expect(orchCalls[0]).toMatch(/SKIP_GATE_REMEDIATION=unset/);
    expect(orchCalls[1]).toMatch(/SKIP_GATE_REMEDIATION=1/);
  });

  it('fails the whole wrapper (non-zero exit) if the retry after exit 2 ALSO fails', () => {
    const { repoRoot } = makeStubbedRepo({ runAgentOrchExitCode: [2, 1] });
    const { rc, output } = runWrapper(repoRoot, [
      '--prd', '/tmp/fake-prd.json',
      '--project-root', '/tmp/fake-project',
      '--phase', 'test_phase',
    ]);
    expect(rc).not.toBe(0);
    expect(output).toMatch(/failed after self-healing retry/);
  });

  it('fails immediately (no retry) on a non-2 non-zero exit code', () => {
    const { repoRoot, callLogPath } = makeStubbedRepo({ runAgentOrchExitCode: 1 });
    const { rc, output } = runWrapper(repoRoot, [
      '--prd', '/tmp/fake-prd.json',
      '--project-root', '/tmp/fake-project',
      '--phase', 'test_phase',
    ]);
    expect(rc).not.toBe(0);
    expect(output).not.toMatch(/Self-healing/);
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n');
    expect(calls.filter(c => c.startsWith('run-agent-orchestration.sh'))).toHaveLength(1);
  });

  it('creates an empty placeholder PRD file BEFORE calling pre-run-reset.sh when --prd points at a path that does not exist yet (Jira-ingest mode, first run — no prior synthesized PRD on disk) — dashboards MUST be wired to a real run, this is not optional', () => {
    const { repoRoot } = makeStubbedRepo({ runAgentOrchExitCode: 0 });
    const prdDir = mkdtempSync(join(tmpdir(), 'tier3-mock-placeholder-'));
    const prdPath = join(prdDir, 'not-yet-synthesized.json');
    try {
      expect(existsSync(prdPath)).toBe(false);
      const { rc, output } = runWrapper(repoRoot, [
        '--prd', prdPath,
        '--project-root', '/tmp/fake-project',
        '--phase', 'core',
      ]);
      expect(rc, output).toBe(0);
      expect(existsSync(prdPath)).toBe(true);
      expect(readFileSync(prdPath, 'utf8').trim()).toBe('{}');
    } finally {
      rmSync(prdDir, { recursive: true, force: true });
    }
  });

  it('does NOT overwrite an already-existing PRD file with a placeholder (repeat real runs, where the prior synthesized PRD is still on disk)', () => {
    const { repoRoot } = makeStubbedRepo({ runAgentOrchExitCode: 0 });
    const prdDir = mkdtempSync(join(tmpdir(), 'tier3-mock-existing-prd-'));
    const prdPath = join(prdDir, 'existing.json');
    writeFileSync(prdPath, JSON.stringify({ id: 'real-existing-prd', stories: [{ id: 'X' }] }));
    try {
      const { rc, output } = runWrapper(repoRoot, [
        '--prd', prdPath,
        '--project-root', '/tmp/fake-project',
        '--phase', 'core',
      ]);
      expect(rc, output).toBe(0);
      expect(JSON.parse(readFileSync(prdPath, 'utf8')).id).toBe('real-existing-prd');
    } finally {
      rmSync(prdDir, { recursive: true, force: true });
    }
  });

  it('a pre-run-reset.sh failure for an UNRELATED reason (e.g. Docker unavailable) is still non-fatal, matching tier3-metrolinx-run.sh\'s own real fallback — run-agent-orchestration.sh still runs', () => {
    const { repoRoot, callLogPath } = makeStubbedRepo({ runAgentOrchExitCode: 0 });
    writeFileSync(
      join(repoRoot, 'orchestrations/scripts/pre-run-reset.sh'),
      `#!/usr/bin/env bash\necho "pre-run-reset.sh $*" >> ${JSON.stringify(callLogPath)}\nexit 1\n`,
    );
    chmodSync(join(repoRoot, 'orchestrations/scripts/pre-run-reset.sh'), 0o755);

    const { rc, output } = runWrapper(repoRoot, [
      '--prd', '/tmp/not-yet-synthesized-prd.json',
      '--project-root', '/tmp/fake-project',
      '--phase', 'core',
    ]);
    expect(rc, output).toBe(0);
    expect(output).toMatch(/non-fatal/);
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n');
    expect(calls.some(c => c.startsWith('run-agent-orchestration.sh'))).toBe(true);
  });

  it('requires all three flags — fails fast with a clear usage error if any is missing', () => {
    const { repoRoot } = makeStubbedRepo({ runAgentOrchExitCode: 0 });
    const missingPrd = runWrapper(repoRoot, ['--project-root', '/tmp/x', '--phase', 'p']);
    expect(missingPrd.rc).not.toBe(0);
    expect(missingPrd.output).toMatch(/--prd <path> is required/);

    const missingRoot = runWrapper(repoRoot, ['--prd', '/tmp/x.json', '--phase', 'p']);
    expect(missingRoot.rc).not.toBe(0);
    expect(missingRoot.output).toMatch(/--project-root <path> is required/);

    const missingPhase = runWrapper(repoRoot, ['--prd', '/tmp/x.json', '--project-root', '/tmp/x']);
    expect(missingPhase.rc).not.toBe(0);
    expect(missingPhase.output).toMatch(/--phase <phase> is required/);
  });
});

/**
 * The pre-flight must GATE the launch, not merely precede it. Wiring it into every launcher
 * (2026-08-05) is worth nothing if a failing assessment still lets the run spend.
 */
describe('the pre-flight gates the launch', () => {
  it('runs the pre-flight before invoking the orchestration script', () => {
    const { repoRoot, callLogPath } = makeStubbedRepo({ runAgentOrchExitCode: 0 });
    runWrapper(repoRoot, ['--prd', '/tmp/fake-prd.json', '--project-root', '/tmp/fake-project', '--phase', 'core']);
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n');
    const pre = calls.findIndex((c) => c.startsWith('preflight-check.sh'));
    const orch = calls.findIndex((c) => c.startsWith('run-agent-orchestration.sh'));
    expect(pre, 'the launcher never ran the pre-flight').toBeGreaterThanOrEqual(0);
    expect(orch, 'the launcher never ran the pipeline').toBeGreaterThanOrEqual(0);
    expect(pre, 'assessing AFTER launching assesses nothing').toBeLessThan(orch);
  });

  it('THE POINT: a failing pre-flight aborts before the pipeline is invoked', () => {
    const { repoRoot, callLogPath } = makeStubbedRepo({ runAgentOrchExitCode: 0 });
    const { rc } = runWrapper(
      repoRoot,
      ['--prd', '/tmp/fake-prd.json', '--project-root', '/tmp/fake-project', '--phase', 'core'],
      { PREFLIGHT_EXIT: '1' },
    );
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n');
    expect(
      calls.some((c) => c.startsWith('run-agent-orchestration.sh')),
      'the pipeline ran despite a failed assessment — every launch failure on 2026-08-05 ' +
        'was of exactly this shape: something checkable was wrong and the run spent anyway',
    ).toBe(false);
    expect(rc, 'a launcher that aborts must say so with a non-zero exit').not.toBe(0);
  });
});
