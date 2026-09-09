/**
 * FOUR RUNS, ZERO CASSETTES.
 *
 * Operator, repeatedly: replay must be on for every run. It was not, and nothing said so:
 *
 *   - EPAM_REPLAY is read in exactly ONE place — install.sh:57. No run script reads it. Setting it
 *     on a launch did nothing at all.
 *   - A Langfuse trace is not a cassette. A cassette exists only when cassette-export.js is run,
 *     and NOTHING ran it: `grep -rn cassette-export orchestrations/` finds no caller.
 *   - orchestrations/cassettes/ — the durable home, four cassettes — had received nothing since
 *     2026-08-26.
 *
 * So run 20260908T215555Z recorded 278 traces across 35 seams, and when the machine restarted and
 * Langfuse went down, the run became unreplayable. The recording existed; the artefact never did.
 *
 * The feature is export-on-completion: a run that finishes leaves a cassette in the durable
 * directory, or says loudly why it could not. It never fails the run for it — the work is already
 * done by then — and it never overwrites an existing one, because a cassette is run evidence.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/cassette-archive.sh');
const REAL_EXPORTER = join(ROOT, 'orchestrations/scripts/cassette-export.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** A stand-in exporter that behaves as the real one does on success: writes a manifest. */
function stubExporter(dir: string, ok: boolean) {
  const f = join(dir, 'stub-export.js');
  writeFileSync(f, `#!/usr/bin/env node
const fs=require('fs'), path=require('path');
const a=process.argv.slice(2);
const out=a[a.indexOf('--out')+1];
if(${ok ? 'true' : 'false'}){
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({session:a[a.indexOf('--session')+1],traceCount:3,seams:[{seam:'x',turns:3}],roots:['/tmp']}));
  fs.writeFileSync(path.join(out,'x.json'),'[]');
  process.stdout.write('1 seam(s), 3 turn(s) -> '+out+'\\n');
  process.exit(0);
}
process.stderr.write('fetch failed\\n'); process.exit(1);
`);
  chmodSync(f, 0o755);
  return f;
}

function run(args: { session: string; project: string; exporter: string; cassettes: string }) {
  const d = tmp('casarch-');
  const script = join(d, 'run.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
warning(){ echo "WARN: $*"; }; info(){ echo "INFO: $*"; }; success(){ echo "OK: $*"; }; error(){ echo "ERR: $*"; }
source "${LIB}"
export EPAM_CASSETTE_EXPORTER="${args.exporter}"
export_run_cassette "${args.session}" "${args.project}" "${args.cassettes}"
echo "rc=$?"
`);
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 120_000 });
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

describe('a completed run leaves a cassette in the durable directory', () => {
  it('exports it, named <project>-<runId>, where the other cassettes live', () => {
    const d = tmp('cas-'); const cass = join(d, 'cassettes');
    const r = run({ session: '20260908T215555Z', project: 'metrolinx',
                    exporter: stubExporter(d, true), cassettes: cass });
    const expected = join(cass, 'metrolinx-20260908T215555Z');
    expect(existsSync(expected), `no cassette at ${expected}. out: ${r.out.slice(0, 300)}`).toBe(true);
    expect(existsSync(join(expected, 'manifest.json')), 'no manifest — not a cassette').toBe(true);
    expect(JSON.parse(readFileSync(join(expected, 'manifest.json'), 'utf8')).session)
      .toBe('20260908T215555Z');
  });

  it('NEVER overwrites one that already exists — a cassette is run evidence', () => {
    const d = tmp('cas-'); const cass = join(d, 'cassettes');
    const existing = join(cass, 'metrolinx-20260908T215555Z');
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, 'manifest.json'), '{"session":"ORIGINAL","traceCount":99}');
    const r = run({ session: '20260908T215555Z', project: 'metrolinx',
                    exporter: stubExporter(d, true), cassettes: cass });
    expect(JSON.parse(readFileSync(join(existing, 'manifest.json'), 'utf8')).session,
      'the existing cassette was overwritten').toBe('ORIGINAL');
    expect(r.out, 'it overwrote silently — say so instead').toMatch(/already|exists|keeping/i);
  });

  it('says LOUDLY why it could not, using the REAL exporter against a Langfuse that is down', () => {
    const d = tmp('cas-'); const cass = join(d, 'cassettes');
    const r = run({ session: 'no-such-session', project: 'metrolinx',
                    exporter: REAL_EXPORTER, cassettes: cass });
    expect(r.out, 'a failed export was silent — the run would look recorded when it is not')
      .toMatch(/cassette/i);
    expect(r.out).toMatch(/WARN|ERR/);
  });

  it('NEVER fails the run — the work is already done by the time this runs', () => {
    const d = tmp('cas-'); const cass = join(d, 'cassettes');
    const r = run({ session: '20260908T215555Z', project: 'metrolinx',
                    exporter: stubExporter(d, false), cassettes: cass });
    expect(r.out, 'a failed export aborted the caller').toMatch(/rc=0/);
  });

  it('refuses an empty run id rather than writing a cassette called "-"', () => {
    const d = tmp('cas-'); const cass = join(d, 'cassettes');
    const r = run({ session: '', project: 'metrolinx',
                    exporter: stubExporter(d, true), cassettes: cass });
    expect(existsSync(join(cass, 'metrolinx-')), 'it created a nameless cassette').toBe(false);
    expect(r.out).toMatch(/rc=0/);
    expect(r.out).toMatch(/run id|session/i);
  });
});

/**
 * THE FUNCTION EXISTING IS NOT THE FEATURE. The exporter existed all along and had no caller —
 * that is precisely how four runs left nothing. So this asserts the CALL SITE: the block is
 * lifted from run-agent-orchestration.sh and executed, and the cassette must appear.
 */
describe("the pipeline's own completion block", () => {
  function completionBlock(): string {
    const lines = readFileSync(
      join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8').split('\n');
    const i = lines.findIndex((l) => l.includes('if declare -F export_run_cassette'));
    if (i === -1) {
      throw new Error('run-agent-orchestration.sh does not call export_run_cassette — the exporter '
        + 'has no caller again, which is exactly how four runs left no cassette');
    }
    const pad = lines[i].length - lines[i].trimStart().length;
    const close = ' '.repeat(pad) + 'fi';
    const j = lines.findIndex((l, n) => n > i && l === close);
    if (j === -1) throw new Error('completion block has no closing fi at its indentation');
    return lines.slice(i, j + 1).map((l) => l.slice(pad)).join('\n');
  }

  it('ARCHIVES the run when the pipeline completes', () => {
    const d = tmp('cas-'); const cass = join(d, 'cassettes');
    const script = join(d, 'completion.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
warning(){ echo "WARN: $*"; }; info(){ echo "INFO: $*"; }; success(){ echo "OK: $*"; }; error(){ echo "ERR: $*"; }
source "${LIB}"
export EPAM_CASSETTE_EXPORTER="${stubExporter(d, true)}"
ORCH_RUN_ID=20260908T215555Z
EPAM_PROJECT_CONFIG_DIR=/somewhere/metrolinx
EPAM_CASSETTE_DIR="${cass}"
AUTOMATION_DIR="${d}"
${completionBlock()}
echo "rc=$?"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60_000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const expected = join(cass, 'metrolinx-20260908T215555Z');
    expect(existsSync(expected), `completion left no cassette. out: ${out.slice(0, 300)}`).toBe(true);
    expect(existsSync(join(expected, 'manifest.json'))).toBe(true);
    expect(out).toMatch(/rc=0/);
  });
});
