/**
 * The GATE-REMEDIATION path must feed the KB too.
 *
 * Found by running mock1 with EPAM_KB_SELFHEAL=1 (2026-07-25): the run failed a
 * gate, applied remediation and retried from Step 1 — and wrote ZERO healing
 * episodes, legacy or KB. Because gate remediation lives in
 * run-agent-orchestration.sh and is a STRUCTURALLY DIFFERENT mechanism from
 * claude.sh's run_failure_analyst, which is where the KB had been wired. The
 * as-built survey counted six independent self-heal mechanisms sharing only a
 * name; wiring one covered one.
 *
 * The lint log is the ideal evidence: `tsc --noEmit` + eslint output, i.e.
 * deterministic tool signal, which is exactly what a signature must be derived
 * from rather than a model's prose summary.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const src = readFileSync(ORCH, 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Drive lib/kb-apply.sh the same way the gate-remediation block does. */
function recordFromLintLog(lintLog: string, flag: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-gate-')); dirs.push(dir);
  const logFile = join(dir, 'lint.log');
  writeFileSync(logFile, lintLog);
  const env: Record<string, string> = { ...process.env as any, KB_ROOT: dir };
  if (flag) env.EPAM_KB_SELFHEAL = flag;
  execFileSync('bash', ['-c', `
set -uo pipefail
. ${JSON.stringify(join(LIB, 'kb-apply.sh'))}
head -c 8000 ${JSON.stringify(logFile)} | kb_record_episode core lint-gate "lint gate failed"
`], { encoding: 'utf8', env });
  const f = join(dir, 'healing-events.jsonl');
  return existsSync(f) && readFileSync(f, 'utf8').trim()
    ? JSON.parse(readFileSync(f, 'utf8').trim().split('\n')[0]) : null;
}

describe('gate remediation records an episode keyed by the lint log', () => {
  it('derives the signature from tsc output in the gate log', () => {
    const ep = recordFromLintLog("src/hello.ts(3,1): error TS1005: ';' expected.\n", '1');
    expect(ep).not.toBeNull();
    expect(ep.signature).toBe('TS1005');
    expect(ep.signature_source).toBe('tsc');
    expect(ep.agent_role).toBe('lint-gate');
  });

  it('records nothing when the flag is off', () => {
    expect(recordFromLintLog("src/hello.ts(3,1): error TS1005: ';' expected.\n", null)).toBeNull();
  });

  it('still records when the log has no derivable signature', () => {
    const ep = recordFromLintLog('eslint: some style complaint\n', '1');
    expect(ep).not.toBeNull();
    expect(ep.signature).toBeNull();
  });
});

describe('the call site exists in the gate-remediation block', () => {
  it('records BEFORE the analyst prompt is built, so evidence is captured first', () => {
    const i = src.indexOf('[lint-gate:analyst] Extracting grounded finding');
    const before = src.slice(Math.max(0, i - 1200), i);
    expect(before).toContain('kb_record_episode');
  });

  it('is flag-guarded so a default run is unaffected', () => {
    const i = src.indexOf('kb_record_episode');
    expect(src.slice(Math.max(0, i - 400), i)).toContain('EPAM_KB_SELFHEAL');
  });

  it('cannot fail the gate — the recording is best-effort', () => {
    const i = src.indexOf('kb_record_episode');
    expect(src.slice(i, i + 200)).toMatch(/\|\|\s*true/);
  });
});
