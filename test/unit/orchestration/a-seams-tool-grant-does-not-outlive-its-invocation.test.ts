/**
 * A SEAM'S TOOL GRANT DOES NOT OUTLIVE ITS INVOCATION.
 *
 * regintel resume 4 (2026-09-21, $1.57): the reviewer asked REGI-001's writer to delete two
 * double-copied directories. Five fix attempts, climbing the ladder to kimi-k3, each ended with the
 * writer saying "I have no file-write or file-delete tool in this session. My tools are read_file,
 * list_files, search, codegraph_query" — the READ-ONLY grant of the phase-assessment seam that had
 * run in between. seam_ladder_export `eval`s `export EPAM_ALLOWED_TOOLS=...` into the CALLING shell,
 * and run_orch_prompt runs in the orchestrator's own shell, so the last seam's grant became every
 * later child's environment. The first writer attempt had all its tools only because no seam had
 * exported yet. seam-invocation.js already names the class: "the agent inherited whatever grant the
 * run had last set".
 *
 * This sources the REAL orch-prompt.sh and drives run_orch_prompt with a stub runner; afterwards the
 * caller's shell must hold exactly the grant it held before. The stub records the grant it was
 * handed, so the positive half — the seam itself DID get its declared tools — is asserted too.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function driveSeam(seam: string) {
  const d = mkdtempSync(join(tmpdir(), 'seam-grant-')); dirs.push(d);
  const seen = join(d, 'seen.env');
  const runner = join(d, 'runner.sh');
  writeFileSync(runner, `#!/usr/bin/env bash\ncat >/dev/null\nprintf 'EPAM_ALLOWED_TOOLS=%s\\n' "\${EPAM_ALLOWED_TOOLS-<unset>}" > "${seen}"\nprintf '{"result":"ok","cost_usd":0}' > "\${ORCH_JSON_RESULT}"\n`);
  chmodSync(runner, 0o755);
  const script = `
    set -uo pipefail
    SCRIPT_DIR="${SCRIPTS}"; AUTOMATION_DIR="${SCRIPTS}/.."; LOG_DIR="${d}"
    export PROJECT_ROOT="${d}"
    . "$SCRIPT_DIR/lib/seam-ladder.sh"; . "$SCRIPT_DIR/lib/mint-and-spec.sh" 2>/dev/null || true
    . "$SCRIPT_DIR/lib/orch-prompt.sh"
    log() { :; }; warning() { echo "WARN: $*" >&2; }; error() { echo "ERR: $*" >&2; }; success() { :; }; info() { :; }
    AI_RUNNER_CMD="${runner}"; CLAUDE_CMD=claude; ORCH_GATE_PROVIDER=openrouter
    export EPAM_ALLOWED_TOOLS="bash,read_file,write_file,list_files,search"   # the caller's own grant
    run_orch_prompt "judge this" "${seam}" "S-1" >/dev/null || true
    printf 'AFTER=%s\\n' "$EPAM_ALLOWED_TOOLS"
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, EPAM_PROVIDER_SET: 'openrouter' } });
  const after = /AFTER=(.*)/.exec(r.stdout || '')?.[1] ?? '<not printed>';
  let seenGrant = '<runner not called>';
  try { seenGrant = /EPAM_ALLOWED_TOOLS=(.*)/.exec(readFileSync(seen, 'utf8'))?.[1] ?? '<unset>'; } catch { /* not called */ }
  return { after, seenGrant, err: r.stderr || '' };
}

describe("a seam's tool grant does not outlive its invocation", () => {
  const r = driveSeam('team-lead-agent');

  it('the seam itself ran with its own declared grant — the test is not vacuous', () => {
    expect(r.seenGrant, r.err.slice(-800)).not.toBe('<runner not called>');
    expect(r.seenGrant).not.toContain('write_file');
    expect(r.seenGrant).toContain('read_file');
  });

  it("the caller's shell still holds the grant it had before — the next writer is not handed the assessor's read-only tools", () => {
    expect(r.after, `the seam's grant leaked into the calling shell:\n${r.err.slice(-800)}`).toBe('bash,read_file,write_file,list_files,search');
  });
});
