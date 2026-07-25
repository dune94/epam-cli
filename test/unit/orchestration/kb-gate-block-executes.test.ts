/**
 * PRE-RUN VERIFICATION — execute the real gate-remediation KB block.
 *
 * The previous mock run cost 20 minutes to discover that the KB was wired into a
 * code path a gate failure never reaches. Source-presence assertions could not
 * catch that, and neither could unit tests of kb_record_episode in isolation: both
 * were green while the pipeline recorded nothing.
 *
 * So this extracts the block VERBATIM from run-agent-orchestration.sh and runs it
 * with a real lint-log fixture, under the same `set -euo pipefail` the orchestrator
 * uses. If the block is syntactically valid but does nothing, this fails. If it
 * fails the caller's pipeline (the SIGPIPE hazard), this fails too.
 *
 * The point is to answer "will the next run actually record?" without spending the
 * next run to find out.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const src = readFileSync(join(SCRIPTS, 'run-agent-orchestration.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The KB block, lifted verbatim out of the orchestrator. */
function extractKbBlock(): string {
  const start = src.indexOf('            if [ "${EPAM_KB_SELFHEAL:-0}" = "1" ] && [ -f "$SCRIPT_DIR/lib/kb-apply.sh" ]; then');
  expect(start, 'KB block not found in the gate-remediation path').toBeGreaterThan(-1);
  const end = src.indexOf('\n            fi', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + '\n            fi'.length);
}

function runBlock(lintLog: string, flag: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-block-')); dirs.push(dir);
  const logFile = join(dir, 'lint.log');
  writeFileSync(logFile, lintLog);
  const script = `
set -euo pipefail
SCRIPT_DIR=${JSON.stringify(SCRIPTS)}
_lint_log=${JSON.stringify(logFile)}
_phase=core
PHASE=core
${extractKbBlock()}
echo "BLOCK_COMPLETED"
`;
  const env: Record<string, string> = { ...process.env as any, KB_ROOT: dir };
  if (flag) env.EPAM_KB_SELFHEAL = flag;
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8', env });
  const f = join(dir, 'healing-events.jsonl');
  const ep = existsSync(f) && readFileSync(f, 'utf8').trim()
    ? JSON.parse(readFileSync(f, 'utf8').trim().split('\n')[0]) : null;
  return { out, ep };
}

describe('the real gate block, executed', () => {
  it('records an episode keyed by the tsc error in the lint log', () => {
    const { out, ep } = runBlock("src/hello.ts(3,1): error TS1005: ';' expected.\n", '1');
    expect(out).toContain('BLOCK_COMPLETED');
    expect(ep, 'the block ran but recorded nothing — the exact failure mock1 exposed').not.toBeNull();
    expect(ep.signature).toBe('TS1005');
    expect(ep.signature_source).toBe('tsc');
    expect(ep.agent_role).toBe('lint-gate');
  });

  it('completes under set -euo pipefail with the flag OFF (SIGPIPE safety)', () => {
    // Returning without draining stdin gives `head` a SIGPIPE; under pipefail that
    // would abort the gate. A disabled feature must not be able to break a run.
    const { out, ep } = runBlock("src/hello.ts(3,1): error TS1005: ';' expected.\n", null);
    expect(out).toContain('BLOCK_COMPLETED');
    expect(ep).toBeNull();
  });

  it('completes on a huge lint log without tripping the 8000-byte head', () => {
    const big = 'x'.repeat(50000) + "\nsrc/a.ts(1,1): error TS2532: Object is possibly 'undefined'.\n";
    const { out } = runBlock(big, '1');
    expect(out).toContain('BLOCK_COMPLETED');
  });

  it('completes when the log has no derivable signature', () => {
    const { out, ep } = runBlock('eslint: prefer-const\n', '1');
    expect(out).toContain('BLOCK_COMPLETED');
    expect(ep.signature).toBeNull();
  });
});

describe('mock1 is budgeted for pass + remediation retry', () => {
  it('the timeout exceeds two full passes at the observed ~19min each', () => {
    const mock = readFileSync(join(__dirname, 'brownfield-mock-e2e.test.ts'), 'utf8');
    const m = mock.match(/timeout:\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
    expect(m, 'mock1 has no minute-based timeout').toBeTruthy();
    expect(Number(m![1]), 'cannot fit a first pass plus the exit-2 retry').toBeGreaterThanOrEqual(40);
  });
});
