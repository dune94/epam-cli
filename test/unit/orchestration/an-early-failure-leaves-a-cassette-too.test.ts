/**
 * A RUN THAT DIES IN THE FIRST HALF STILL LEAVES ITS RECORDING.
 *
 * The cassette export lives inside cleanup(), and cleanup() is registered as an exit handler at
 * line ~4169 of run-agent-orchestration.sh. bash registers a handler when execution REACHES the
 * registration, so a run that exits before that line has no cassette handler installed at all.
 *
 * The script's earliest `exit` is at line ~379. Everything between — ingest, codeline discovery,
 * spec-mode, the agent mint, roster derivation — fails into a trap that does not yet include the
 * export. Measured live 2026-09-11 by the free mockserver rehearsal: roster derivation failed at
 * line 3768, `_release_write_perimeter` (registered at line 38) ran and printed, cleanup never did,
 * and orchestrations/cassettes stayed at 10 directories with nothing from that run.
 *
 * Those are precisely the runs worth replaying — an early structural failure is cheap to re-drive
 * and hard to reason about from a log alone.
 *
 * So the export cannot be a passenger on cleanup's registration. It is registered where the
 * recorder itself is sourced, ahead of every exit the script can take.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPTS = join(REPO_ROOT, 'orchestrations/scripts');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');

/** First line at which the script can leave the process. */
function firstExitLine(src: string): number {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) if (/^\s*exit\s+\d/.test(lines[i])) return i + 1;
  return -1;
}

/** Line at which a named handler is registered, or -1. */
function registrationLine(src: string, handler: string): number {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^\\s*add_exit_handler\\s+${handler}\\b`).test(lines[i])) return i + 1;
  }
  return -1;
}

/** The handler that actually calls export_run_cassette, found by reading the bodies. */
function cassetteHandlerName(src: string): string | null {
  const lines = src.split('\n');
  let current: string | null = null;
  for (const line of lines) {
    const def = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/.exec(line);
    if (def) current = def[1];
    if (/export_run_cassette\s+"/.test(line) && current) return current;
  }
  return null;
}

describe('an early failure leaves a cassette too', () => {
  const src = readFileSync(ORCH, 'utf8');

  it('the script really does exit long before its late handlers — otherwise this proves nothing', () => {
    expect(firstExitLine(src)).toBeGreaterThan(0);
    expect(registrationLine(src, 'cleanup')).toBeGreaterThan(firstExitLine(src));
  });

  it('the cassette export is registered ahead of every exit the script can take', () => {
    const handler = cassetteHandlerName(src);
    expect(handler, 'no function in the script calls export_run_cassette').not.toBeNull();
    const reg = registrationLine(src, handler!);
    expect(reg, `${handler} calls export_run_cassette but is never registered as an exit handler`)
      .toBeGreaterThan(0);
    expect(reg,
      `the cassette export (${handler}, registered at line ${reg}) is installed AFTER the script's ` +
      `first exit at line ${firstExitLine(src)} — every failure before that line leaves no recording`)
      .toBeLessThan(firstExitLine(src));
  });

  it('a script that exits early still exports — executed, not inspected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'early-cassette-'));
    const casDir = join(dir, 'cassettes');
    const stub = join(dir, 'exporter.js');
    // A stand-in exporter that writes the manifest the archiver requires.
    writeFileSync(stub, [
      'const fs = require("fs"), path = require("path");',
      'const out = process.argv[process.argv.indexOf("--out") + 1];',
      'const ses = process.argv[process.argv.indexOf("--session") + 1];',
      'fs.mkdirSync(out, { recursive: true });',
      'fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ session: ses }));',
      'console.log("exported " + ses);',
    ].join('\n'));

    const script = join(dir, 'run.sh');
    writeFileSync(script, [
      '#!/usr/bin/env bash',
      `source ${JSON.stringify(join(SCRIPTS, 'lib/exit-handlers.sh'))}`,
      `source ${JSON.stringify(join(SCRIPTS, 'lib/cassette-archive.sh'))}`,
      'warning() { echo "[WARNING] $1" >&2; }',
      'info()    { echo "[INFO] $1"; }',
      'success() { echo "[SUCCESS] $1"; }',
      // Registered here, where the recorder is sourced — the point of the fix.
      '_export() { export_run_cassette "$RUN_ID" "proj" "$CAS_DIR"; }',
      'add_exit_handler _export',
      'echo "about to fail early"',
      'exit 1',
      'echo "never reached"',
    ].join('\n'));
    chmodSync(script, 0o755);

    const r = spawnSync('bash', [script], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, RUN_ID: 'EARLY-1', CAS_DIR: casDir, EPAM_CASSETTE_EXPORTER: stub },
    });

    expect(r.status, `the early exit code must survive the handler:\n${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stdout, 'the script did not reach its failure').toContain('about to fail early');
    expect(existsSync(join(casDir, 'proj-EARLY-1', 'manifest.json')),
      `no cassette was written despite the handler being registered before the exit:\n${r.stdout}${r.stderr}`)
      .toBe(true);
  });
});
