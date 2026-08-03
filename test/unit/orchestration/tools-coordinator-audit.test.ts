/**
 * Step 1.66: Tools coordinator audit (run-agent-orchestration.sh).
 *
 * Same rationale as Step 1.65's skills-coordinator, applied to dynamic
 * tools instead of skill notes. Observed live this session: "[dynamic-tools]
 * mock-fetch-in-test.sh exited non-zero (continuing)" — a tool got created
 * by FailureAnalyst, was broken, and run_dynamic_tools_in_unlocked_window()
 * (claude.sh) just logged a warning and moved on every retry, with no
 * mechanism to ever fix or remove it.
 *   1. A free, deterministic scan (run_tools_audit_scan) that: (a)
 *      bash -n syntax-checks every reviewed tool, (b) counts real observed
 *      "<tool>.sh exited non-zero" occurrences across this phase's
 *      main-*.log files (not a synthetic re-execution, to avoid side
 *      effects outside the tool's sanctioned window), (c) flags near-
 *      duplicate tools via purpose-comment word overlap.
 *   2. Only when something is flagged, a tools-coordinator LLM call fixes
 *      the broken tool (duplicates are flagged for manual review only, not
 *      auto-merged — deliberately conservative).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('Step 1.66 wiring (static)', () => {
  it('runs after Step 1.65 (skills coordinator audit), before the monitor sync', () => {
    const skillsIdx = orchSrc.indexOf('step_emit "11" "pass" "Step 11: Skills coordinator audit"');
    const toolsIdx = orchSrc.indexOf('Step 12: Tools coordinator audit');
    const syncIdx = orchSrc.indexOf('Sync story data to monitor from cost log');
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(toolsIdx).toBeGreaterThan(skillsIdx);
    expect(syncIdx).toBeGreaterThan(toolsIdx);
  });

  it('respects SKIP_TOOLS_AUDIT=1', () => {
    expect(orchSrc).toMatch(/if is_truthy "\$\{SKIP_TOOLS_AUDIT:-\}"; then/);
  });

  it('appends the "12" checklist row', () => {
    expect(orchSrc).toMatch(/_checklist_row "12"\s+"Tools coordinator audit"/);
  });

  it('includes "12" in the skip-counting key list', () => {
    const idx = orchSrc.indexOf('for key in "1" "2"');
    const line = orchSrc.slice(idx, orchSrc.indexOf('\n', idx));
    expect(line).toMatch(/"11" "12"/);
  });

  it('duplicates are flagged, not auto-merged', () => {
    const idx = orchSrc.indexOf('Duplicate tools detected');
    expect(idx).toBeGreaterThan(-1);
    expect(orchSrc.slice(idx, idx + 150)).toMatch(/flagged for manual review \(not auto-merged\)/);
  });

  it('restores the pre-audit tool snapshot if the rewrite leaves it syntactically broken', () => {
    const idx = orchSrc.indexOf('_tc_before=$(cat "$_tc_path"');
    expect(idx).toBeGreaterThan(-1);
    const block = orchSrc.slice(idx, idx + 1700);
    expect(block).toMatch(/bash -n "\$_tc_path"/);
    expect(block).toMatch(/echo "\$_tc_before" > "\$_tc_path"/);
  });
});

describe('run_tools_audit_scan — REAL execution', () => {
  function extractScanFunction(): string {
    const start = orchSrc.indexOf('run_tools_audit_scan() {');
    const pyeofIdx = orchSrc.indexOf('PYEOF', start);
    const end = orchSrc.indexOf('\n}', pyeofIdx) + 2;
    return orchSrc.slice(start, end);
  }

  function runScan(setup: (toolsDir: string, logsDir: string) => void): { broken: any[]; duplicates: any[] } {
    const dir = mkdtempSync(join(tmpdir(), 'tools-audit-scan-'));
    const toolsDir = join(dir, 'tools');
    const logsDir = join(dir, 'logs');
    mkdirSync(toolsDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    setup(toolsDir, logsDir);
    try {
      const fnBody = extractScanFunction();
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, `${fnBody}\nrun_tools_audit_scan "$1" "$2"\n`);
      const output = execFileSync('bash', [scriptPath, toolsDir, logsDir], { encoding: 'utf8' });
      return JSON.parse(output.trim());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function writeTool(toolsDir: string, name: string, purpose: string, body: string, reviewed = true) {
    const path = join(toolsDir, `${name}.sh`);
    writeFileSync(path, `#!/usr/bin/env bash\n# ${purpose}\n${body}\n`);
    chmodSync(path, 0o755);
    if (reviewed) writeFileSync(`${path}.reviewed`, 'reviewed_at=2026-07-10\n');
  }

  it('flags a tool that fails bash -n syntax check', () => {
    const { broken } = runScan((toolsDir) => {
      writeTool(toolsDir, 'broken-syntax', 'Does something', 'if [ 1 -eq 1');
    });
    expect(broken).toContainEqual({ tool: 'broken-syntax', reason: 'syntax' });
  });

  it('REPRODUCES the exact live shape: a tool observed failing 2+ times this phase is flagged as broken', () => {
    const { broken } = runScan((toolsDir, logsDir) => {
      writeTool(toolsDir, 'mock-fetch-in-test', 'Mocks global fetch for timeout tests', 'exit 1');
      writeFileSync(
        join(logsDir, 'main-SKY-002-test.log'),
        '[dynamic-tools] mock-fetch-in-test.sh exited non-zero (continuing)\n'.repeat(2),
      );
    });
    expect(broken).toContainEqual({ tool: 'mock-fetch-in-test', reason: 'runtime (2 non-zero exits this phase)' });
  });

  it('does NOT flag a tool with only 1 observed failure (below the 2+ threshold)', () => {
    const { broken } = runScan((toolsDir, logsDir) => {
      writeTool(toolsDir, 'flaky-tool', 'Does a flaky thing', 'exit 1');
      writeFileSync(join(logsDir, 'main-SKY-002-test.log'), '[dynamic-tools] flaky-tool.sh exited non-zero (continuing)\n');
    });
    expect(broken).toHaveLength(0);
  });

  it('does NOT execute tools during the scan (no side effects) — a "broken" runtime tool is only detected via log evidence, not re-run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tools-audit-noexec-'));
    const toolsDir = join(dir, 'tools');
    const logsDir = join(dir, 'logs');
    mkdirSync(toolsDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    const sideEffectFile = join(dir, 'side-effect-marker');
    writeTool(toolsDir, 'has-side-effect', 'Writes a marker file', `touch ${JSON.stringify(sideEffectFile)}`);
    try {
      const fnBody = extractScanFunction();
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, `${fnBody}\nrun_tools_audit_scan "$1" "$2"\n`);
      execFileSync('bash', [scriptPath, toolsDir, logsDir], { encoding: 'utf8' });
      expect(() => readFileSync(sideEffectFile)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags two tools with overlapping purpose text as duplicates', () => {
    const { duplicates } = runScan((toolsDir) => {
      writeTool(toolsDir, 'install-vitest', 'Installs vitest as a dev dependency', 'npm install -D vitest');
      writeTool(toolsDir, 'setup-vitest-deps', 'Installs vitest as a dev dependency', 'npm i -D vitest@latest');
    });
    expect(duplicates).toContainEqual({ tool_a: 'install-vitest', tool_b: 'setup-vitest-deps' });
  });

  it('does NOT flag two tools with unrelated purposes as duplicates', () => {
    const { duplicates } = runScan((toolsDir) => {
      writeTool(toolsDir, 'install-vitest', 'Installs vitest as a dev dependency', 'npm install -D vitest');
      writeTool(toolsDir, 'mock-fetch', 'Mocks global fetch for timeout tests', 'true');
    });
    expect(duplicates).toHaveLength(0);
  });

  it('ignores tools without a .reviewed marker', () => {
    const { broken } = runScan((toolsDir) => {
      writeTool(toolsDir, 'unreviewed-broken', 'Does something', 'if [ 1 -eq 1', false);
    });
    expect(broken).toHaveLength(0);
  });

  it('handles a missing tools directory gracefully (no tools created yet)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tools-audit-missing-'));
    const toolsDir = join(dir, 'does-not-exist');
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    try {
      const fnBody = extractScanFunction();
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, `${fnBody}\nrun_tools_audit_scan "$1" "$2"\n`);
      const output = execFileSync('bash', [scriptPath, toolsDir, logsDir], { encoding: 'utf8' });
      expect(JSON.parse(output.trim())).toEqual({ broken: [], duplicates: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Step 1.66 — REAL execution: LLM only invoked when the scan flags a broken tool', () => {
  function extractScanFunction(): string {
    const start = orchSrc.indexOf('run_tools_audit_scan() {');
    const pyeofIdx = orchSrc.indexOf('PYEOF', start);
    const end = orchSrc.indexOf('\n}', pyeofIdx) + 2;
    return orchSrc.slice(start, end);
  }

  function extractStepBlock(): string {
    const startMarker = 'if is_truthy "${SKIP_TOOLS_AUDIT:-}"; then';
    const start = orchSrc.indexOf(startMarker);
    const endMarker = 'step_emit "12" "pass" "Step 12: Tools coordinator audit"\nfi';
    const end = orchSrc.indexOf(endMarker, start) + endMarker.length;
    if (start === -1 || end === -1) throw new Error('Could not locate Step 1.66 block');
    return orchSrc.slice(start, end);
  }

  type StubMode = 'fix-success' | 'llm-fails' | 'leaves-broken-syntax';

  function buildStub(toolPath: string, callLog: string, dir: string, mode: StubMode): string {
    const stubPath = join(dir, 'ai-runner-stub.sh');
    if (mode === 'llm-fails') {
      writeFileSync(stubPath, ['#!/usr/bin/env bash', 'cat > /dev/null', `echo called >> ${JSON.stringify(callLog)}`, 'exit 1'].join('\n'));
    } else if (mode === 'leaves-broken-syntax') {
      writeFileSync(
        stubPath,
        ['#!/usr/bin/env bash', 'cat > /dev/null', `echo called >> ${JSON.stringify(callLog)}`, `echo 'if [ still broken' > ${JSON.stringify(toolPath)}`, 'exit 0'].join('\n'),
      );
    } else {
      writeFileSync(
        stubPath,
        [
          '#!/usr/bin/env bash',
          `source ${join(__dirname, '../../../orchestrations/scripts/lib/flags.sh')}`,
          'cat > /dev/null',
          `echo called >> ${JSON.stringify(callLog)}`,
          `printf '#!/usr/bin/env bash\\n# Installs vitest as a dev dependency\\nnpm install -D vitest\\n' > ${JSON.stringify(toolPath)}`,
          'exit 0',
        ].join('\n'),
      );
    }
    chmodSync(stubPath, 0o755);
    return stubPath;
  }

  function run(
    setupTools: (toolsDir: string, logsDir: string) => string,
    opts: { stubMode?: StubMode; skipAudit?: boolean } = {},
  ): { llmCallCount: number; stdout: string; toolContent: string; auditLogRecords: any[]; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'tools-step-'));
    const toolsDir = join(dir, '.epam', 'dynamic-tools');
    const logsDir = join(dir, 'logs');
    mkdirSync(toolsDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    const toolPath = setupTools(toolsDir, logsDir);

    const callLog = join(dir, 'llm-called.txt');
    const stubPath = buildStub(toolPath, callLog, dir, opts.stubMode ?? 'fix-success');

    const scanFn = extractScanFunction();
    const block = extractStepBlock();
    const script = [
      '#!/usr/bin/env bash',
      `source ${join(__dirname, '../../../orchestrations/scripts/lib/flags.sh')}`,
      'set -uo pipefail',
      'step_emit() { :; }',
      'error() { echo "ERROR: $*"; }',
      'success() { echo "SUCCESS: $*"; }',
      'warning() { echo "WARNING: $*"; }',
      'info() { echo "INFO: $*"; }',
      'run_orch_prompt_with_tools() {',
      `  echo "$1" | "${stubPath}"`,
      '}',
      `PROJECT_ROOT=${JSON.stringify(dir)}`,
      `LOG_DIR=${JSON.stringify(logsDir)}`,
      'PHASE=core',
      opts.skipAudit ? 'SKIP_TOOLS_AUDIT=1' : '',
      scanFn,
      block,
    ]
      .filter(Boolean)
      .join('\n');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, script);

    let stdout = '';
    try {
      stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    } catch (e: any) {
      stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
    }
    let llmCallCount = 0;
    try {
      llmCallCount = readFileSync(callLog, 'utf8').split('\n').filter((l) => l === 'called').length;
    } catch {
      /* not called */
    }
    const toolContent = readFileSync(toolPath, 'utf8');
    let auditLogRecords: any[] = [];
    try {
      auditLogRecords = readFileSync(join(logsDir, 'tools-coordinator-audit.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      /* no log written */
    }
    return { llmCallCount, stdout, toolContent, auditLogRecords, dir };
  }

  function writeToolFile(toolsDir: string, name: string, purpose: string, body: string): string {
    const path = join(toolsDir, `${name}.sh`);
    writeFileSync(path, `#!/usr/bin/env bash\n# ${purpose}\n${body}\n`);
    chmodSync(path, 0o755);
    writeFileSync(`${path}.reviewed`, 'reviewed_at=2026-07-10\n');
    return path;
  }

  it('a clean tools directory (nothing broken, no duplicates) never invokes the LLM', () => {
    const { llmCallCount, dir } = run((toolsDir) => writeToolFile(toolsDir, 'good-tool', 'Does something fine', 'exit 0'));
    expect(llmCallCount).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('REPRODUCES the exact live case: a repeatedly-failing tool invokes the LLM and gets rewritten', () => {
    const { llmCallCount, toolContent, dir } = run((toolsDir, logsDir) => {
      const path = writeToolFile(toolsDir, 'mock-fetch-in-test', 'Mocks global fetch for timeout tests', 'exit 1');
      writeFileSync(join(logsDir, 'main-SKY-002-test.log'), '[dynamic-tools] mock-fetch-in-test.sh exited non-zero (continuing)\n'.repeat(3));
      return path;
    });
    expect(llmCallCount).toBe(1);
    expect(toolContent).toContain('npm install -D vitest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('SKIP_TOOLS_AUDIT=1 skips the whole step — LLM never called even with a repeatedly-failing tool', () => {
    const { llmCallCount, dir } = run(
      (toolsDir, logsDir) => {
        const path = writeToolFile(toolsDir, 'mock-fetch-in-test', 'Mocks global fetch', 'exit 1');
        writeFileSync(join(logsDir, 'main-SKY-002-test.log'), '[dynamic-tools] mock-fetch-in-test.sh exited non-zero (continuing)\n'.repeat(3));
        return path;
      },
      { skipAudit: true },
    );
    expect(llmCallCount).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('LLM call failure: logs a warning, leaves the tool as-is, does not crash the step', () => {
    const { llmCallCount, stdout, toolContent, dir } = run(
      (toolsDir, logsDir) => {
        const path = writeToolFile(toolsDir, 'mock-fetch-in-test', 'Mocks global fetch', 'exit 1');
        writeFileSync(join(logsDir, 'main-SKY-002-test.log'), '[dynamic-tools] mock-fetch-in-test.sh exited non-zero (continuing)\n'.repeat(2));
        return path;
      },
      { stubMode: 'llm-fails' },
    );
    // Retry fix (2026-07-19): retries once on failure → 2 calls before giving up
    expect(llmCallCount).toBe(2);
    expect(stdout).toMatch(/failed to fix.*leaving as-is/);
    expect(toolContent).toContain('exit 1');
    rmSync(dir, { recursive: true, force: true });
  });

  it('LLM leaves the tool syntactically broken: pre-audit snapshot is restored, error logged', () => {
    const { llmCallCount, stdout, toolContent, dir } = run(
      (toolsDir, logsDir) => {
        const path = writeToolFile(toolsDir, 'mock-fetch-in-test', 'Mocks global fetch', 'exit 1');
        writeFileSync(join(logsDir, 'main-SKY-002-test.log'), '[dynamic-tools] mock-fetch-in-test.sh exited non-zero (continuing)\n'.repeat(2));
        return path;
      },
      { stubMode: 'leaves-broken-syntax' },
    );
    // Retry fix (2026-07-19): attempt 1 warns+retries; attempt 2 restores → 2 calls
    expect(llmCallCount).toBe(2);
    expect(stdout).toMatch(/left mock-fetch-in-test\.sh syntactically broken.*[Rr]estoring/);
    // Restored to the original (still broken-at-runtime, but syntactically valid) tool.
    expect(toolContent).toContain('exit 1');
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a JSONL audit record for the broken-tool rewrite', () => {
    const { auditLogRecords, dir } = run((toolsDir, logsDir) => {
      const path = writeToolFile(toolsDir, 'mock-fetch-in-test', 'Mocks global fetch', 'exit 1');
      writeFileSync(join(logsDir, 'main-SKY-002-test.log'), '[dynamic-tools] mock-fetch-in-test.sh exited non-zero (continuing)\n'.repeat(2));
      return path;
    });
    expect(auditLogRecords).toHaveLength(1);
    expect(auditLogRecords[0]).toMatchObject({ phase: 'core', tool: 'mock-fetch-in-test', event: 'broken_tool_rewrite' });
    rmSync(dir, { recursive: true, force: true });
  });
});
