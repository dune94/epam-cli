/**
 * THE EXPORT RAN ONLY WHERE THE RUN NEVER GOT TO.
 *
 * export-on-completion sits at ONE call site: the end of _run_codeline_loop(), reached only when
 * the pipeline runs to the end. But a run rarely ends there:
 *
 *   - pause-before-writer ends the process with `exit 0` (run-agent-orchestration.sh), hundreds of
 *     lines before that call site;
 *   - every failure path is a bare `exit 1`/`exit 2`/`exit 3`, same story.
 *
 * Live proof: pipeline-tests-48 is the ONLY install carrying the export hook, and it has no
 * cassettes directory at all — the run paused, so the hook never ran, while Langfuse held all 286
 * traces the whole time. Langfuse records each call as it happens; the data was never pending.
 * Waiting for completion to harvest it was the defect.
 *
 * The feature: the run leaves a cassette HOWEVER it ends — and that cannot depend on which function
 * happens to carry it. Riding inside cleanup() meant the handler was only installed once execution
 * reached cleanup's registration near the foot of the file, so anything failing earlier (ingest,
 * discovery, spec-mode, the mint, roster derivation) still left nothing. The export is registered
 * on its own, beside the recorder it uses, ahead of every exit the script can take.
 *
 * It must not change what the run reports: the trap captures $? first, and the export can neither
 * alter the exit status nor be skipped by --skip-cleanup (worktree cleanup is optional; run
 * evidence is not).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/**
 * The REAL cleanup() and its trap, lifted from the real script — never a re-typed copy, which
 * would pass forever after the original changed.
 */
function extractFn(name: string, mustContain: RegExp): string {
  const src = readFileSyncUtf8(ORCH);
  const lines = src.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(l));
  if (start < 0) throw new Error(`${name}() not found in run-agent-orchestration.sh`);
  const end = lines.findIndex((l, i) => i > start && /^\}/.test(l));
  if (end < 0) throw new Error(`${name}() has no closing brace at column 0`);
  const body = lines.slice(start, end + 1).join('\n');
  if (!mustContain.test(body)) throw new Error(`extracted the wrong block for ${name}`);
  return body;
}

/**
 * The export is its OWN exit handler, registered beside lib/cassette-archive.sh near the top of the
 * script — not a passenger inside cleanup(), which bash does not install until line ~4186. This
 * harness drives the registration the real script performs, so it cannot pass because of where the
 * export happens to sit today.
 */
function extractCassetteExport(): string {
  return extractFn('_epam_export_cassette', /export_run_cassette/);
}
function extractCleanup(): string {
  return extractFn('cleanup', /stop_control_plane/);
}
function readFileSyncUtf8(p: string) { return require('node:fs').readFileSync(p, 'utf8') as string; }

/** Run the real cleanup() under a trap, exiting the way the pipeline actually exits. */
function runExit(opts: { code: number; skipCleanup?: boolean; runId?: string }) {
  const d = tmp('trapcas-');
  const cassettes = join(d, 'cassettes');

  // A stand-in exporter that writes what the real one writes, so "a cassette exists" is a real
  // artefact check and not a mock assertion.
  const exporter = join(d, 'stub-export.js');
  writeFileSync(exporter, `#!/usr/bin/env node
const fs=require('fs'), path=require('path');
const a=process.argv.slice(2); const out=a[a.indexOf('--out')+1];
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({session:a[a.indexOf('--session')+1],traceCount:3,seams:[],roots:[]}));
process.stdout.write('1 seam(s), 3 turn(s) -> '+out+'\\n'); process.exit(0);
`);
  chmodSync(exporter, 0o755);

  const script = join(d, 'harness.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
warning(){ echo "WARN: $*"; }; info(){ echo "INFO: $*"; }
success(){ echo "OK: $*"; }; error(){ echo "ERR: $*"; }; log(){ echo "LOG: $*"; }
stop_control_plane(){ :; }
stop_dashboards_watch(){ :; }
CLAUDE_SH="/bin/true"
SKIP_CLEANUP=${opts.skipCleanup ? 'true' : 'false'}
export ORCH_RUN_ID="${opts.runId ?? '20260908T215555Z'}"
export EPAM_PROJECT_CONFIG_DIR="${join(d, 'metrolinx')}"
export EPAM_CASSETTE_DIR="${cassettes}"
export EPAM_CASSETTE_EXPORTER="${exporter}"
source "${join(ROOT, 'orchestrations/scripts/lib/exit-handlers.sh')}"
source "${join(ROOT, 'orchestrations/scripts/lib/cassette-archive.sh')}"
AUTOMATION_DIR="${join(ROOT, 'orchestrations')}"
SCRIPT_DIR="${join(ROOT, 'orchestrations/scripts')}"

${extractCassetteExport()}
add_exit_handler _epam_export_cassette

${extractCleanup()}
add_exit_handler cleanup

exit ${opts.code}
`);
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 120_000 });
  return {
    status: r.status,
    out: (r.stdout ?? '') + (r.stderr ?? ''),
    cassettes,
    made: existsSync(cassettes) ? readdirSync(cassettes) : [],
  };
}

describe('a run leaves a cassette however it ends', () => {
  it('exports when the run PAUSES before the writer (exit 0, the completion hook never reached)', () => {
    const r = runExit({ code: 0 });
    expect(r.made, `no cassette after the pause exit. out: ${r.out.slice(0, 400)}`)
      .toContain('metrolinx-20260908T215555Z');
  });

  it('exports when the run FAILS (exit 1)', () => {
    const r = runExit({ code: 1 });
    expect(r.made, `no cassette after a failing exit. out: ${r.out.slice(0, 400)}`)
      .toContain('metrolinx-20260908T215555Z');
  });

  it('exports even with --skip-cleanup, which skips worktrees but must not skip run evidence', () => {
    const r = runExit({ code: 0, skipCleanup: true });
    expect(r.made, `--skip-cleanup swallowed the export. out: ${r.out.slice(0, 400)}`)
      .toContain('metrolinx-20260908T215555Z');
  });

  it('does not change the exit status the run reports', () => {
    expect(runExit({ code: 0 }).status, 'a successful run must still report 0').toBe(0);
    expect(runExit({ code: 3 }).status, 'a failing run must still report its own code').toBe(3);
  });

  it('stays quiet when there is no run id yet — never exports the wrong session', () => {
    const r = runExit({ code: 1, runId: '' });
    expect(r.made, `exported with no run id: ${r.made.join(',')}`).toEqual([]);
  });
});
