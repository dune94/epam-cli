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
function extractFnByName(fnStart: string): string {
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => l.startsWith(fnStart));
  if (start === -1) throw new Error(`${fnStart} not found`);
  let nextFn = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{/.test(lines[i])) { nextFn = i; break; }
  }
  let end = -1;
  for (let i = nextFn - 1; i > start; i--) {
    if (/^\}\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) throw new Error(`${fnStart} has no closing brace at column 0`);
  return lines.slice(start, end + 1).join('\n');
}
function extractLoopFn(): string {
  // _run_codeline_loop now calls _run_work_dir, which scopes lane working files to THIS
  // run instead of a machine-global /tmp namespace shared by every project. A harness that
  // extracts the loop ALONE loses that callee, every lane PRD path comes out empty and no
  // lane runs — the harness would then "prove" a halt that never happened.
  return `${extractFnByName('_run_work_dir() {')}\n${extractFnByName('_run_codeline_loop() {')}`;
}
const LOOP_FN = extractLoopFn();
// _run_codeline_loop calls _kill_lane_tree (a SEPARATE function) to actually
// stop a lane's real descendant process tree — without extracting the real
// definition too, the harness's stub had no such function at all, so every
// kill attempt failed with "command not found" and silently no-op'd. This
// means the ORIGINAL cascade-abort behavior was never actually verified to
// kill anything by this suite either — only its log message was checked.
const KILL_LANE_TREE_FN = extractFnByName('_kill_lane_tree() {');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * Run the real loop over two lanes. `failing` is the codeline whose pipeline
 * invocation exits non-zero after its retries are spent.
 */
function runLanes(
  failing: string,
  opts: {
    markDelivered?: string;
    parallel?: boolean;
    slowLane?: string;
    slowDelaySecs?: number;
    cascadeAbort?: boolean;
  } = {},
): { entered: string[]; exit: number; out: string; prd: string } {
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
  # Callee: which lane is this? The lane PRD is <run-work-dir>/<codeline>-prd.json.
  # It used to be /tmp/orch-<codeline>-prd-<pid>.json — a flat, machine-global namespace
  # every project shared, which is how one run's archiver picked up another project's PRD.
  _cl=\$(basename "\${PRD_FILE:-}" | sed -E 's/^(.*)-prd\\.json$/\\1/')
  echo "\$_cl" >> "${marker}"
  # Record the LOG_DIR this lane was handed, and write a baseline SHA into it —
  # the file that corrupted across lanes live on 2026-07-29.
  echo "\$_cl \${LOG_DIR:-unset}" >> "${marker}.logdirs"
  if [ -n "\${LOG_DIR:-}" ]; then
    mkdir -p "\$LOG_DIR" 2>/dev/null || true
    echo "sha-of-\$_cl" > "\$LOG_DIR/phase-baseline-sha.txt"
    printf '{"story_id":"T-1","codeline":"%s","task_cost_usd":0.25}\n' "\$_cl" \
      >> "\$LOG_DIR/phase-cost.jsonl"
  fi
  # A deliberately slow lane: still "running" when a sibling has already
  # failed, so the cascade-abort/let-finish behavior actually has something
  # to differ on. Without this every lane finishes near-instantly and the
  # poll never observes real overlap either way.
  if [ "\$_cl" = "${opts.slowLane || '__none__'}" ]; then
    sleep ${opts.slowDelaySecs ?? 0}
  fi
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
LOG_DIR="${join(dir, 'logdir')}"
mkdir -p "$LOG_DIR"
export LOG_DIR
# The health gate is a separate contract with its own tests; here it would abort
# before any lane ran and the halt assertion would pass vacuously.
export SKIP_CODELINE_HEALTH=1
log()   { echo "[log] \$*"; }
error() { echo "[ERROR] \$*"; }
warn()  { echo "[WARN] \$*"; }
warning() { echo "[WARN] \$*"; }
info()  { echo "[info] \$*"; }
_run_codeline_bridge() { :; }

${KILL_LANE_TREE_FN}

${LOOP_FN}

_run_codeline_loop "${prdPath}" "${join(dir, 'run.log')}" "core"
echo "LOOP_EXIT=\$?"
`);
  chmodSync(harness, 0o755);

  const r = spawnSync('bash', [harness], {
    encoding: 'utf8', timeout: 120000, cwd: dir,
    env: {
      ...process.env,
      EPAM_PARALLEL_CODELINES: opts.parallel === false ? '0' : '1',
      ...(opts.cascadeAbort ? { EPAM_CASCADE_ABORT_ON_LANE_FAILURE: '1' } : {}),
    },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const entered = existsSync(marker)
    ? readFileSync(marker, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  const m = out.match(/LOOP_EXIT=(\d+)/);
  return { entered, exit: m ? Number(m[1]) : -1, out, prd: prdPath };
}

describe('the lane loop halts once a codeline has finally failed (sequential mode)', () => {
  it('the harness drives both lanes when nothing fails', () => {
    // Guards the harness itself: if the loop never reached lane-b for an
    // unrelated reason, the halt assertion below would pass vacuously.
    const { entered, exit } = runLanes('none', { parallel: false });
    expect(entered, 'the harness never ran both lanes — the halt test proves nothing')
      .toEqual(['lane-a', 'lane-b']);
    expect(exit).toBe(0);
  });

  it('does NOT start the next codeline after one fails', () => {
    const { entered, out } = runLanes('lane-a', { parallel: false });
    expect(entered,
      `lane-a failed after its retries were spent, yet the run continued into ` +
      `${entered.slice(1).join(', ')} — the live AMSD-2041 behaviour:\n${out}`)
      .toEqual(['lane-a']);
  });

  it('reports failure rather than exiting clean', () => {
    const { exit } = runLanes('lane-a', { parallel: false });
    expect(exit, 'a halted run must not report success').not.toBe(0);
  });

  it('says why it stopped', () => {
    const { out } = runLanes('lane-a', { parallel: false });
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
    const { out } = runLanes('lane-a', { parallel: false });
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
  const delivered = () => runLanes('lane-b', { markDelivered: 'lane-a', parallel: false });

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

describe('parallel lanes — the same guarantees, differently enforced', () => {
  // Lanes now run concurrently by default (EPAM_PARALLEL_CODELINES=1). That
  // changes HOW the halt rule is honoured, not whether it is. Sequencing
  // prevented spend outright: a failed first lane meant later lanes never
  // started. In parallel they have already started, so the equivalent is to
  // abort the survivors the moment one fails — money already spent cannot be
  // recovered, money not yet spent still can.
  //
  // What must NOT change is the outcome contract: a failed lane fails the run,
  // and a story delivered in only some of its lanes is not delivered.
  it('starts every lane rather than waiting its turn', () => {
    const { entered } = runLanes('none', { parallel: true });
    expect(entered.sort(), 'lanes did not run concurrently').toEqual(['lane-a', 'lane-b']);
  });

  it('a failed lane still fails the whole run', () => {
    expect(runLanes('lane-a', { parallel: true }).exit,
      'a lane failed and the run reported success').not.toBe(0);
  });

  it('says it is aborting the lanes still running', () => {
    const { out } = runLanes('lane-a', { parallel: true });
    // Either message is a correct halt: "aborting the survivors" when lanes are
    // still running, or the per-lane statement when they had all finished by
    // the time the poll noticed. What is NOT acceptable is a non-zero exit with
    // no explanation of which lane died.
    expect(out, 'the run failed without naming the lane that caused it')
      .toMatch(/HALT: codeline 'lane-a' failed|HALT: a codeline failed|Aborting the codeline/i);
  });

  it('STILL refuses a partial solution when one lane delivered and another failed', () => {
    // The rule that survives both modes, and the one that matters most.
    const { prd, exit } = runLanes('lane-b', { markDelivered: 'lane-a', parallel: true });
    const story = JSON.parse(readFileSync(prd, 'utf8')).stories
      .find((s: { id: string }) => s.id === 'T-1');
    expect(story.completed,
      'a story delivered in one of two lanes was accepted as complete')
      .not.toBe(true);
    expect(exit).not.toBe(0);
  });
});

describe('cross-lane cascade: a failed lane must not kill a sibling still doing real work', () => {
  // Live Writer Retest run, 2026-08-02 (AMSD-2041): gotransit failed on a
  // deterministic gate's FALSE positive (an unrelated, pre-existing broken
  // import — see run_relative_import_check's scope fix, same incident).
  // That failure SIGTERM'd upexpress and metrolinx mid-attempt, discarding
  // real, valid, independent work those lanes were still producing. The
  // overall-failure contract (tested above) must survive unchanged; what
  // changes is whether a lane that is still genuinely working gets to
  // finish. lane-b sleeps past at least one 5s poll cycle so there is a
  // real window where the OLD code would have killed it mid-flight.
  it('by DEFAULT, lets a still-running sibling finish and record its real delivery', () => {
    const { prd, out } = runLanes('lane-a', {
      slowLane: 'lane-b', slowDelaySecs: 8, markDelivered: 'lane-b', parallel: true,
    });
    const story = JSON.parse(readFileSync(prd, 'utf8')).stories
      .find((s: { id: string }) => s.id === 'T-1');
    expect(story.perCodeline?.['lane-b']?.completed,
      `lane-b was still running when lane-a failed but never got to finish:\n${out.slice(-2000)}`)
      .toBe(true);
  });

  it('with EPAM_CASCADE_ABORT_ON_LANE_FAILURE=1, restores the old behavior — the still-running sibling is killed before it can deliver', () => {
    const { prd, out } = runLanes('lane-a', {
      slowLane: 'lane-b', slowDelaySecs: 8, markDelivered: 'lane-b', parallel: true, cascadeAbort: true,
    });
    const story = JSON.parse(readFileSync(prd, 'utf8')).stories
      .find((s: { id: string }) => s.id === 'T-1');
    expect(story.perCodeline?.['lane-b']?.completed,
      `expected the opt-in to still kill lane-b, but it delivered anyway:\n${out.slice(-2000)}`)
      .not.toBe(true);
    expect(out).toMatch(/HALT: a codeline failed after its retries and self-heal completed/);
  });

  it('the overall-failure contract is unchanged by either mode: a failed lane always fails the run', () => {
    expect(runLanes('lane-a', { slowLane: 'lane-b', slowDelaySecs: 8, parallel: true }).exit).not.toBe(0);
    expect(
      runLanes('lane-a', { slowLane: 'lane-b', slowDelaySecs: 8, parallel: true, cascadeAbort: true }).exit,
    ).not.toBe(0);
  });
});

describe('parallel lanes cannot read each other\'s state', () => {
  // Live metrolinx 2026-07-29, the reason that run was killed. Every lane
  // inherited one LOG_DIR, and phase-baseline-sha.txt in it is READ BACK as
  // state — the git SHA every diff-based gate uses to decide what changed. Last
  // writer won, so two of three lanes diffed against a commit absent from their
  // repository: empty diff, and the review gates passed on ZERO files.
  //
  // A crash halts the run. This reported success on unreviewed code, which is
  // why it is tested by what each lane can SEE, not by whether it errored.
  const laneLogDirs = (dir: string): Record<string, string> => {
    const f = `${dir}.logdirs`;
    if (!existsSync(f)) return {};
    const out: Record<string, string> = {};
    for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      const [cl, ld] = line.trim().split(/\s+/);
      if (cl) out[cl] = ld;
    }
    return out;
  };

  it('hands every lane a DIFFERENT LOG_DIR', () => {
    const r = runLanes('none', { parallel: true });
    const dirs = laneLogDirs(join(r.prd, '..', 'entered.txt'));
    const values = Object.values(dirs);
    expect(values.length, `lanes did not report a LOG_DIR: ${JSON.stringify(dirs)}`).toBe(2);
    expect(new Set(values).size,
      `both lanes share one LOG_DIR (${values[0]}) — baseline SHA, the ` +
      'review-incomplete flag and the story-outputs manifest all collide')
      .toBe(2);
  });

  it('each lane sees only its OWN baseline SHA', () => {
    const r = runLanes('none', { parallel: true });
    const dirs = laneLogDirs(join(r.prd, '..', 'entered.txt'));
    for (const [cl, ld] of Object.entries(dirs)) {
      const f = join(ld, 'phase-baseline-sha.txt');
      expect(existsSync(f), `${cl} wrote no baseline`).toBe(true);
      expect(readFileSync(f, 'utf8').trim(),
        `${cl} is reading a baseline written by another lane — its gates would ` +
        'diff against a commit that does not exist in its repository')
        .toBe(`sha-of-${cl}`);
    }
  });
});

describe('per-lane cost is aggregated back to the canonical ledger', () => {
  // Per-lane LOG_DIR fixed state corruption and fragmented the cost ledger:
  // every reader of the canonical phase-cost.jsonl — dashboard,
  // validate-dashboards.sh, the run report — saw ZERO for a parallel run while
  // the real records sat under lanes/<codeline>/. A cost ledger that silently
  // reports zero is worse than one that is missing, because zero looks like an
  // answer. Real cost tracking is the project's stated first priority.
  it('the parent ledger contains every lane\'s records', () => {
    const r = runLanes('none', { parallel: true });
    const parent = join(r.prd, '..', 'logdir', 'phase-cost.jsonl');
    expect(existsSync(parent),
      'no aggregated ledger at the canonical path — every cost reader sees zero')
      .toBe(true);
    const aggLines = readFileSync(parent, 'utf8').split('\n').filter(Boolean);
    const aggLanes = new Set(aggLines.map((l) => { try { return JSON.parse(l).codeline; } catch { return null; } }));
    expect(aggLanes.has('lane-a') && aggLanes.has('lane-b'),
      `canonical ledger under-reports: ${[...aggLanes].join(',')}`).toBe(true);
    return;
    // The harness runs the loop with LOG_DIR defaulting to the run dir; locate
    // the aggregated ledger next to the lanes/ directory the loop created.
    const dir = join(r.prd, '..');
    const { readdirSync } = require('node:fs');
    const found: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'phase-cost.jsonl') found.push(p);
      }
    };
    walk(dir);
    const aggregated = found.filter((f) => !f.includes(`${require('node:path').sep}lanes${require('node:path').sep}`));
    expect(aggregated.length, `no aggregated ledger; only per-lane files: ${found.join(', ')}`)
      .toBeGreaterThan(0);
    const lines = aggregated.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean));
    const lanes = new Set(lines.map((l) => { try { return JSON.parse(l).codeline; } catch { return null; } }));
    expect(lanes.has('lane-a') && lanes.has('lane-b'),
      `canonical ledger is missing a lane's cost — readers would under-report: ${[...lanes].join(',')}`)
      .toBe(true);
    void parent;
  });
});
