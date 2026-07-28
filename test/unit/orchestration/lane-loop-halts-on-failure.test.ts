/**
 * A failed codeline must stop the run, not fund the next one.
 *
 * Live AMSD-2041, 2026-07-28 — a ticket spanning three codelines:
 *
 *   20:07:32  [orch] Phase 'core' — codeline 'gotransit'...
 *   20:12:52  FATAL — speckit returned null after 3 attempt(s). Aborting pipeline.
 *   20:12:52  ERROR [orch] Phase 'core' for 'gotransit' failed (exit 1)
 *   20:12:57  [orch] Merged codeline 'gotransit' story state back into canonical PRD
 *   20:12:57  [orch] Phase 'core' — codeline 'upexpress'...      <-- kept going
 *
 * Retries (3/3) and the self-heal retry had both already completed and the step
 * was STILL failed. The standing mandate is to halt there. Instead the loop
 * moved to the next lane and would have paid for a third, reproducing a
 * deterministic failure twice more at full ladder price.
 *
 * The cause is one word. `_run_codeline_loop` has two nested loops — phases
 * inside codelines — and the failure path ends in a bare `break`, which leaves
 * the PHASE loop while the CODELINE loop carries on. A comment a few lines
 * below even asserts the opposite ("Lane failures already stop the loop"),
 * which is how this survived: the belief was documented, never executed.
 *
 * WHY THE TEST IS SHAPED THIS WAY. Asserting on source text — that a `break 2`
 * appears, or that some marker sits inside the loop — is exactly the mistake
 * that let the wrong comment stand. So this EXECUTES the real function,
 * extracted by its own definition boundaries rather than a byte window, and
 * makes the failing lane fail for real. The loop re-invokes the pipeline as
 * `bash "$0" --reset`; the harness IS `$0`, so it answers that call, records
 * which lanes were entered, and fails the first one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');
const NODE_BIN = process.execPath;

/**
 * The function bounded by its OWN definition — not an offset guess.
 *
 * The first column-0 `}` is NOT the end: the function embeds JS via
 * `"$NODE_BIN" -e "..."`, and those object literals close at column 0 too
 * (lines 2508 and 2533 at time of writing). Cutting there truncated a shell
 * string mid-quote and bash failed to parse the harness at all. So the end is
 * the LAST column-0 `}` before the next top-level function definition.
 */
function extractLoopFn(): string {
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => l.startsWith('_run_codeline_loop() {'));
  if (start === -1) throw new Error('_run_codeline_loop not found');
  let nextFn = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{/.test(lines[i])) { nextFn = i; break; }
  }
  let end = -1;
  for (let i = nextFn - 1; i > start; i--) {
    if (/^\}\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) throw new Error('_run_codeline_loop has no closing brace at column 0');
  return lines.slice(start, end + 1).join('\n');
}
const LOOP_FN = extractLoopFn();

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * Run the real loop over two lanes. `failing` is the codeline whose pipeline
 * invocation exits non-zero after its retries are spent.
 */
function runLanes(failing: string, opts: { markDelivered?: string } = {}):
  { entered: string[]; exit: number; out: string; prd: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lane-halt-'));
  dirs.push(dir);

  const laneA = join(dir, 'lane-a');
  const laneB = join(dir, 'lane-b');
  const marker = join(dir, 'entered.txt');
  mkdirSync(laneA, { recursive: true });
  mkdirSync(laneB, { recursive: true });

  const prd = {
    project: {
      outputDirs: [
        { codeline: 'lane-a', path: laneA },
        { codeline: 'lane-b', path: laneB },
      ],
    },
    implementationOrder: { core: ['T-1'] },
    stories: [{ id: 'T-1', title: 'spans both lanes', codelines: ['lane-a', 'lane-b'] }],
  };
  const prdPath = join(dir, 'prd.json');
  writeFileSync(prdPath, JSON.stringify(prd, null, 2));

  // The harness is BOTH the caller and the `bash "$0" --reset` callee, exactly
  // as the real script is. In callee mode it records the lane and sets its exit
  // status; in caller mode it runs the extracted loop.
  const harness = join(dir, 'harness.sh');
  writeFileSync(harness, `#!/usr/bin/env bash
set -uo pipefail

if [ "\${1:-}" = "--reset" ]; then
  # Callee: which lane is this? PRD_FILE is /tmp/orch-<codeline>-prd-<pid>.json
  _cl=\$(basename "\${PRD_FILE:-}" | sed -E 's/^orch-(.*)-prd-[0-9]+\\.json$/\\1/')
  echo "\$_cl" >> "${marker}"
  # A lane that DELIVERS marks the story complete in its own filtered PRD,
  # exactly as claude.sh does during a real run. This is what makes the
  # partial-success case reachable: one lane genuinely succeeded.
  if [ "\$_cl" = "${opts.markDelivered || '__none__'}" ]; then
    "${NODE_BIN}" -e '
      const fs = require("fs"), p = process.env.PRD_FILE;
      const prd = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const s of prd.stories) {
        s.status = "completed"; s.completed = true;
        s.completedAt = "2026-07-28T00:00:00.000Z";
      }
      fs.writeFileSync(p, JSON.stringify(prd, null, 2));
    '
  fi
  # Self-heal retries have already run by the time the loop inspects this
  # status; exit 1 (not 2) so no gate remediation is attempted.
  [ "\$_cl" = "${failing}" ] && exit 1
  exit 0
fi

NODE_BIN="${NODE_BIN}"
SCRIPT_DIR="${join(REPO_ROOT, 'orchestrations/scripts')}"
# The health gate is a separate contract with its own tests; here it would abort
# before any lane ran and the halt assertion would pass vacuously.
export SKIP_CODELINE_HEALTH=1
log()   { echo "[log] \$*"; }
error() { echo "[ERROR] \$*"; }
warn()  { echo "[WARN] \$*"; }
info()  { echo "[info] \$*"; }
_run_codeline_bridge() { :; }

${LOOP_FN}

_run_codeline_loop "${prdPath}" "${join(dir, 'run.log')}" "core"
echo "LOOP_EXIT=\$?"
`);
  chmodSync(harness, 0o755);

  const r = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 120000, cwd: dir });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const entered = existsSync(marker)
    ? readFileSync(marker, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  const m = out.match(/LOOP_EXIT=(\d+)/);
  return { entered, exit: m ? Number(m[1]) : -1, out, prd: prdPath };
}

describe('the lane loop halts once a codeline has finally failed', () => {
  it('the harness drives both lanes when nothing fails', () => {
    // Guards the harness itself: if the loop never reached lane-b for an
    // unrelated reason, the halt assertion below would pass vacuously.
    const { entered, exit } = runLanes('none');
    expect(entered, 'the harness never ran both lanes — the halt test proves nothing')
      .toEqual(['lane-a', 'lane-b']);
    expect(exit).toBe(0);
  });

  it('does NOT start the next codeline after one fails', () => {
    const { entered, out } = runLanes('lane-a');
    expect(entered,
      `lane-a failed after its retries were spent, yet the run continued into ` +
      `${entered.slice(1).join(', ')} — the live AMSD-2041 behaviour:\n${out}`)
      .toEqual(['lane-a']);
  });

  it('reports failure rather than exiting clean', () => {
    const { exit } = runLanes('lane-a');
    expect(exit, 'a halted run must not report success').not.toBe(0);
  });

  it('says why it stopped', () => {
    const { out } = runLanes('lane-a');
    // Matched against the specific halt message, not a loose alternation: an
    // earlier draft used /halt|not starting|remaining/i and passed on incidental
    // text while the loop was still running every lane.
    expect(out, 'the halt gives the operator nothing to act on')
      .toMatch(/HALT: codeline 'lane-a' failed after its retries/);
  });

  it('still records the failed lane state before halting', () => {
    // The merge is what makes the failure visible in the canonical PRD; halting
    // must not cost that. Absence of the merge line would mean the operator
    // sees a run that stopped with no record of where.
    const { out } = runLanes('lane-a');
    expect(out).toMatch(/Merged codeline 'lane-a'/);
  });
});

describe('a partial solution is never accepted', () => {
  // The user's rule, stated 2026-07-28: "any hard failure in a lane after
  // retries and self healing and laddering should halt the whole run — a
  // partial solution will not be accepted."
  //
  // Halting is only half of that. The sharper case is a story that one lane
  // GENUINELY delivered while another failed: the work is real, the commit is
  // real, and the temptation is to call the story done. It is not done — it was
  // declared against both codelines.
  const delivered = () => runLanes('lane-b', { markDelivered: 'lane-a' });

  it('runs the delivering lane and then fails on the second', () => {
    // Guard: if lane-a never delivered, "not completed" below proves nothing.
    const { entered } = delivered();
    expect(entered).toEqual(['lane-a', 'lane-b']);
  });

  it('does NOT mark the spanning story complete when one lane failed', () => {
    const { prd } = delivered();
    const after = JSON.parse(readFileSync(prd, 'utf8'));
    const story = after.stories.find((s: { id: string }) => s.id === 'T-1');
    expect(story.completed,
      'a story delivered in only one of its two codelines was reported complete')
      .not.toBe(true);
    expect(story.status, 'status claims completion despite a failed lane')
      .not.toBe('completed');
  });

  it('records which lane did deliver, so the partial work is not lost', () => {
    // Refusing to call it complete must not erase the evidence that lane-a
    // succeeded — a rerun needs to know what is already done.
    const { prd } = delivered();
    const story = JSON.parse(readFileSync(prd, 'utf8')).stories
      .find((s: { id: string }) => s.id === 'T-1');
    expect(story.perCodeline, 'no per-lane record survived the halt').toBeTruthy();
    expect(story.perCodeline['lane-a'].completed,
      "the delivering lane's result was discarded").toBe(true);
  });

  it('still exits non-zero — partial delivery is a failed run', () => {
    expect(delivered().exit).not.toBe(0);
  });
});
