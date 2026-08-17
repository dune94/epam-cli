/**
 * EVERY PARALLEL LANE DID NOTHING AND REPORTED SUCCESS.
 *
 * A lane runs each phase its PRD declares. The list came from:
 *
 *     _prd_phases() { "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/prd-phases.js" 2>/dev/null }
 *
 * called as `_prd_phases "$_cl_prd"` — and the function never forwarded the argument. Worse, the
 * handler itself had been extracted from an inline shell snippet with the shell's own placeholder
 * left in the JavaScript:
 *
 *     JSON.parse(require('fs').readFileSync('$1','utf8'))
 *
 * So it tried to open a file literally named `$1`, threw, and `2>/dev/null` swallowed it. The
 * phase list came back EMPTY, the lane's `for _phase in "${_phases[@]}"` ran zero times, and the
 * lane reported `✓ completed`.
 *
 * Live 2026-08-17, mock3: two lanes, two pending stories assigned to minted agents, 35 project
 * prompts provisioned — and both lanes finished in FIVE SECONDS having invoked no writer, run no
 * gate and made no commit. The seeded bugs were untouched. The pipeline printed
 * "Lane outcomes — 2 completed, 0 did not" and "✅ Pipeline complete".
 *
 * The failure mode is the one that recurs: an empty list is a legitimate answer ("this PRD
 * declares no phases") and is indistinguishable from a failure to read one. So the failure must be
 * loud, and an empty result must never arrive by accident.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const HANDLER = join(SCRIPTS, 'lib/handlers/prd-phases.js');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const NODE = process.execPath;

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'prd-phases-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

/** Run the lane's own phase-listing function, lifted from the script. */
function phasesVia(prdPath: string): { lines: string[]; rc: number; err: string } {
  const src = readFileSync(ORCH, 'utf8');
  const start = src.indexOf('  _prd_phases() {');
  expect(start, 'the phase-listing function is gone').toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n  }', start) + 4)
    .split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n');

  const r = spawnSync('bash', ['-c',
    `NODE_BIN=${JSON.stringify(NODE)}
     SCRIPT_DIR=${JSON.stringify(SCRIPTS)}
     error(){ echo "ERR: $*" >&2; }
${body}
     mapfile -t P < <(_prd_phases ${JSON.stringify(prdPath)})
     printf '%s\\n' "\${P[@]}"`,
  ], { encoding: 'utf8' });
  return {
    lines: r.stdout.split('\n').filter(Boolean),
    rc: r.status ?? -1,
    err: r.stderr,
  };
}

function prdWith(phases: Record<string, string[]>): string {
  const p = join(work, 'prd.json');
  writeFileSync(p, JSON.stringify({ implementationOrder: phases, stories: [] }));
  return p;
}

describe('a lane with no phases did nothing and said success', () => {
  it('the handler carries no unsubstituted shell placeholder', () => {
    // The literal defect: '$1' extracted into JavaScript as a filename.
    const body = readFileSync(HANDLER, 'utf8')
      .split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    expect(body, "the handler still reads a file named '$1'").not.toMatch(/readFileSync\('\$\d'/);
    expect(body, 'the handler takes no argument').toMatch(/process\.argv\[2\]/);
  });

  it('the caller forwards the PRD path it was given', () => {
    const src = readFileSync(ORCH, 'utf8');
    const start = src.indexOf('  _prd_phases() {');
    const body = src.slice(start, src.indexOf('\n  }', start));
    expect(body, 'the function still drops its argument').toMatch(/\$\{1:-/);
    expect(body, 'the handler is still invoked with no path')
      .toMatch(/prd-phases\.js" "\$_pp_prd"/);
  });

  it('returns the phases a real PRD declares', () => {
    const got = phasesVia(prdWith({ scaffold: [], core: ['S-1'] }));
    expect(got.lines, 'a PRD with two phases did not yield two').toEqual(['scaffold', 'core']);
  });

  it('an UNREADABLE PRD yields no phases AND says so — it is not silent', () => {
    // The whole defect: silent-empty is read by the caller as "nothing to do".
    const got = phasesVia(join(work, 'does-not-exist.json'));
    expect(got.lines, 'an unreadable PRD produced phases').toEqual([]);
    expect(got.err, 'the failure is still swallowed — the lane would report success')
      .toMatch(/could not read the phases/i);
  });

  it('the diagnosis names the consequence, not just the file', () => {
    // "cannot read X" sends the reader to the file. The thing they need to know is that a lane
    // with no phases does nothing and still reports success.
    const src = readFileSync(ORCH, 'utf8');
    const start = src.indexOf('  _prd_phases() {');
    expect(src.slice(start, start + 1400))
      .toMatch(/does nothing and reports success/i);
  });

  it('a PRD that genuinely declares no phases is still a legitimate empty answer', () => {
    // The fix must not turn "no phases" into an error — some PRDs legitimately have none.
    const got = phasesVia(prdWith({}));
    expect(got.lines).toEqual([]);
    expect(got.err, 'an empty-but-valid PRD was reported as a failure')
      .not.toMatch(/could not read/i);
  });
});
