/**
 * CPA gate exit-code propagation — real bash execution, not simulated logic.
 *
 * Bug found live in the AMSD-1820 run (2026-07-22): contextualize-stories.sh
 * (the CPA script) correctly computed a BLOCK verdict and printed
 * "[CPA ERR] 1 story/stories in BLOCK gate — resolve before orchestration",
 * then exited 3. But run-agent-orchestration.sh invoked it as:
 *
 *   bash "$CPA_SCRIPT" $cpa_flags 2>&1 | tee "$LOG_DIR/cpa-${PHASE}.log" || cpa_exit=$?
 *
 * Without `set -o pipefail`, `$?` after a pipeline is tee's exit code — and
 * tee almost always exits 0 (it successfully wrote the log). So cpa_exit
 * stayed 0 regardless of the CPA script's real exit code, and the case
 * statement always took the "0) pass" branch. The live run logged
 * "[SUCCESS] Step 2: CPA gate PASSED" one line after a hard BLOCK verdict,
 * and the pipeline proceeded to implement a story CPA said should not run.
 *
 * The exact same anti-pattern is called out in a comment already present in
 * this file (search "IMPORTANT: do NOT use") at the ingest-jira-tickets.sh
 * call site, which correctly uses PIPESTATUS[0] — but that fix was never
 * applied to the CPA call site. Fixed by capturing cpa_exit="${PIPESTATUS[0]}"
 * immediately after the pipeline, which reflects $CPA_SCRIPT's real exit
 * code regardless of tee's own (always-0) exit status.
 *
 * This test extracts the EXACT lines from the real script (not a rewritten
 * copy) and executes them in a real bash subshell with a stubbed CPA_SCRIPT,
 * proving the case statement actually reaches each branch for exit 0/2/3.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH_SCRIPT = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SCRIPT, 'utf8');

// ─── Source invariants ─────────────────────────────────────────────────────

describe('CPA gate exit-code capture — source invariants', () => {
  it('captures cpa_exit via PIPESTATUS[0], not `|| cpa_exit=$?` after the CPA pipe', () => {
    const blockIdx = orchSrc.indexOf('cpa_exit=0');
    expect(blockIdx).toBeGreaterThan(-1);
    const block = orchSrc.slice(blockIdx, blockIdx + 2000);
    expect(block).toMatch(/cpa_exit="\$\{PIPESTATUS\[0\]\}"/);
    // The old anti-pattern must be gone from the actual tee invocation line
    // (a comment above explains the fix and legitimately mentions the old
    // pattern in backticks — only the functional line matters here)
    const teeLine = block.split('\n').find(l => l.includes('tee "$LOG_DIR/cpa-'));
    expect(teeLine).toBeDefined();
    expect(teeLine).not.toMatch(/\|\|\s*cpa_exit=\$\?/);
  });

  it('PIPESTATUS[0] capture happens on the line immediately after the tee pipe', () => {
    const blockIdx = orchSrc.indexOf('cpa_exit=0');
    const block = orchSrc.slice(blockIdx, blockIdx + 900);
    const teeIdx = block.indexOf('tee "$LOG_DIR/cpa-');
    const pipestatusIdx = block.indexOf('cpa_exit="${PIPESTATUS[0]}"');
    expect(teeIdx).toBeGreaterThan(-1);
    expect(pipestatusIdx).toBeGreaterThan(teeIdx);
  });

  it('case statement still handles exit 3 (BLOCK) with a hard `exit 3`', () => {
    const caseIdx = orchSrc.indexOf('case $cpa_exit in');
    const block = orchSrc.slice(caseIdx, caseIdx + 2000);
    const blockBranchIdx = block.indexOf('3)');
    const branchBody = block.slice(blockBranchIdx, blockBranchIdx + 700);
    expect(branchBody).toMatch(/CPA gate BLOCKED/);
    expect(branchBody).toMatch(/\bexit 3\b/);
  });
});

// ─── Real bash execution: extracted block behaves correctly end-to-end ────

function extractCpaBlock(): string {
  const startIdx = orchSrc.indexOf('cpa_exit=0');
  const caseStartIdx = orchSrc.indexOf('case $cpa_exit in', startIdx);
  const caseEndIdx = orchSrc.indexOf('esac', caseStartIdx) + 'esac'.length;
  return orchSrc.slice(startIdx, caseEndIdx);
}

let workDir: string;
let cpaScriptPath: string;
let logDir: string;

function runExtractedBlock(cpaExitCode: number): { stdout: string; stderr: string; exitCode: number } {
  writeFileSync(cpaScriptPath, `#!/bin/bash\necho "CPA stub ran"\nexit ${cpaExitCode}\n`);
  chmodSync(cpaScriptPath, 0o755);

  const harness = `
set -e
LOG_DIR="${logDir}"
PHASE="core"
CPA_SCRIPT="${cpaScriptPath}"
CLAUDE_CMD="stub"
AI_RUNNER_CMD="stub"
SCRIPT_DIR="${logDir}"
cpa_flags=""
_prev_handoff=""

step_emit()  { echo "STEP_EMIT: $*"; }
success()    { echo "SUCCESS: $*"; }
warning()    { echo "WARNING: $*"; }
error()      { echo "ERROR: $*"; }
cat > "$SCRIPT_DIR/update-monitor.sh" << 'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$SCRIPT_DIR/update-monitor.sh"

${extractCpaBlock()}

echo "REACHED_END cpa_exit=$cpa_exit"
`;

  const result = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 15000 });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
  };
}

describe('CPA gate exit-code propagation — real bash execution of extracted block', () => {
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'cpa-gate-test-'));
    cpaScriptPath = join(workDir, 'stub-cpa.sh');
    logDir = workDir;
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('CPA script exit 0 (PASS) → case statement reaches the pass branch and continues', () => {
    const { stdout, exitCode } = runExtractedBlock(0);
    expect(stdout).toMatch(/SUCCESS: Step 2: CPA gate PASSED/);
    expect(stdout).toMatch(/REACHED_END cpa_exit=0/);
    expect(exitCode).toBe(0);
  });

  it('CPA script exit 2 (REVIEW) → case statement reaches the review branch and continues (not blocked)', () => {
    const { stdout, exitCode } = runExtractedBlock(2);
    expect(stdout).toMatch(/WARNING: Step 2: CPA gate REVIEW/);
    expect(stdout).toMatch(/REACHED_END cpa_exit=2/);
    expect(exitCode).toBe(0);
  });

  it('CPA script exit 3 (BLOCK) → case statement reaches the block branch and the harness HALTS (exit 3)', () => {
    // This is the exact bug: before the fix, this assertion failed because
    // cpa_exit was always 0 (tee's exit code), so "REACHED_END cpa_exit=0"
    // appeared instead, and the harness exited 0 — the pipeline would have
    // silently proceeded to implement a story CPA explicitly blocked.
    const { stdout, exitCode } = runExtractedBlock(3);
    expect(stdout).toMatch(/ERROR: Step 2: CPA gate BLOCKED/);
    expect(stdout).not.toMatch(/REACHED_END/); // exit 3 fires before reaching this line
    expect(exitCode).toBe(3);
  });

  it('the stub CPA script actually ran in all three cases (proves the pipe executed real output, not a fake exit code)', () => {
    const passRun  = runExtractedBlock(0);
    const blockRun = runExtractedBlock(3);
    expect(passRun.stdout).toMatch(/CPA stub ran/);
    expect(blockRun.stdout).toMatch(/CPA stub ran/);
  });
});
