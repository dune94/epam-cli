/**
 * A MEGABYTE OF EVIDENCE STILL BUILDS A PROMPT.
 *
 * Live failure, run 20260815T195931Z (metrolinx, AMSD-2041), and it is a regression I
 * introduced hours earlier the same day.
 *
 *   [FailureAnalyst] cannot build prompt: [prompt-library] prompt file is not valid JSON
 *   (/tmp/analyst-values-BIoZKp.json): Unexpected end of JSON input
 *
 * Removing pipeline-wide input truncation (commit 27e2501) was correct — the operator
 * mandate is that no agent input is cut mid-meaning. But VERIFICATION_FAILURE had been
 * capped at 1000-4000 chars, and those caps were silently doing a SECOND job: keeping the
 * analyst's values under ARG_MAX.
 *
 * The values are assembled with `jq -n --arg ...`, which passes every value through argv.
 * ARG_MAX here is 2 MiB. Reproduced exactly:
 *
 *     100 KB  -> jq rc=0    file 100037 bytes  valid JSON
 *       1 MB  -> jq rc=126  file 0 bytes       "Unexpected end of JSON input"
 *
 * rc=126 is "Argument list too long". The redirect had `2>/dev/null`, so the failure was
 * invisible; the empty file then failed to parse, the analyst returned 1, and every retry
 * lost its diagnosis. The story burned four attempts and was abandoned with no self-heal.
 *
 * THE FIX IS NOT TO PUT THE CAP BACK. A cap that exists to dodge an argv limit is a
 * truncation nobody declared, and it silently destroys evidence to protect a mechanism.
 * Large values go via --rawfile, which reads from a file and never touches argv. The
 * failure is also no longer swallowed: a values file that cannot be built is reported.
 *
 * Nothing project-specific appears here; the fixture supplies its own content.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const MARKER = 'EVIDENCE_TAIL_MARKER';

/** Extract the real values-building block and run it with a value of the given size. */
function buildValues(bytes: number) {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('    local _analyst_values _analyst_values_err');
  expect(start, 'analyst values block not found in claude.sh').toBeGreaterThan(-1);
  const end = src.indexOf('if ! analyst_prompt=', start);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end);

  const dir = mkdtempSync(join(tmpdir(), 'analyst-vals-'));
  try {
    // A verification failure the size of a real suite dump, with a marker at the very end
    // so a partial write is detectable rather than merely "shorter".
    const big = 'x'.repeat(Math.max(0, bytes - MARKER.length)) + MARKER;
    const vfFile = join(dir, 'vf.txt');
    writeFileSync(vfFile, big);

    const res = spawnSync('bash', ['-c', `
      set -uo pipefail
      export TMPDIR=${JSON.stringify(dir)}
      analyst_profile="a profile"
      story_id="S-1"
      story_role="a-role"
      story_acs="an AC"
      skill_addendum=""
      dependency_contracts=""
      VERIFICATION_FAILURE=$(cat ${JSON.stringify(vfFile)})
      _attempt_change_summary() { echo "one file changed"; }
      ${block.replace(/\blocal\b/g, '')}
      echo "VALUES_FILE=$_analyst_values"
    `], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

    const m = /VALUES_FILE=(\S+)/.exec(res.stdout || '');
    if (!m) return { ok: false, why: `no values file: ${res.stderr}`, size: 0, tail: false };
    const file = m[1];
    let size = 0;
    try { size = statSync(file).size; } catch { /* absent */ }
    let parsed: any = null;
    let why = '';
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (e: any) { why = e.message; }
    return {
      ok: parsed !== null,
      why,
      size,
      tail: parsed ? String(parsed.__VERIFICATION_FAILURE__ || '').endsWith(MARKER) : false,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the analyst values file survives a real evidence dump', () => {
  it('is not vacuous — a small value builds fine, proving the harness works', () => {
    const r = buildValues(1000);
    expect(r.ok, `small value failed to build: ${r.why}`).toBe(true);
    expect(r.size).toBeGreaterThan(500);
  });

  it('THE REGRESSION: 1 MB of evidence still produces valid JSON', () => {
    // Before the fix this is jq rc=126, a 0-byte file, and "Unexpected end of JSON input".
    const r = buildValues(1_000_000);
    expect(r.ok, `values file is not valid JSON: ${r.why}`).toBe(true);
    expect(r.size, 'the values file was empty — jq never ran').toBeGreaterThan(0);
  });

  it('carries the evidence WHOLE — the end of the dump is present', () => {
    // Guards the lazy fix: re-introducing a cap would still parse, and would still be a
    // silent truncation of the thing the analyst diagnoses from.
    const r = buildValues(1_000_000);
    expect(r.tail, 'the tail of the evidence was cut — a cap was reintroduced').toBe(true);
  });

  it('survives past ARG_MAX, which is what argv could never do', () => {
    const r = buildValues(3_000_000);
    expect(r.ok, `3 MB failed: ${r.why}`).toBe(true);
    expect(r.tail).toBe(true);
  });
});

describe('a values file that cannot be built is never silent', () => {
  it('the jq call does not discard its own error', () => {
    // `> file 2>/dev/null` turned "Argument list too long" into an empty file and an
    // unexplained parse error three log lines later. Exit status is a contract.
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const start = src.indexOf('    local _analyst_values _analyst_values_err');
    const block = src.slice(start, src.indexOf('if ! analyst_prompt=', start));
    expect(block, 'the values build still swallows stderr').not.toMatch(/>\s*"\$_analyst_values"\s*2>\/dev\/null/);
  });
});
