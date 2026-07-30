/**
 * Measure the detective before capping it.
 *
 * Measured 2026-07-30 across three lanes of one AMSD-2041 run:
 *
 *   lane        spec pass   detective   share
 *   gotransit   16.2 min    11.6 min    72%
 *   upexpress   16.1 min     9.8 min    61%
 *   metrolinx   14.7 min     9.4 min    64%
 *
 * openspec and speckit together take ~1.5 min. The spec pass IS the detective,
 * and the spec pass is 84-98% of a lane's wall clock. Every lane took roughly
 * the same time on a one-line ticket — the signature of a fixed exploration
 * budget rather than work proportional to the story.
 *
 * The obvious move is to cut CODEGRAPH_DETECTIVE_MAX_TOOL_CALLS from 7. The
 * reason not to do that blind: the detective produces fixSiteAnalysis — the fix
 * site AND the prescribed helper that the new write-time reuse guard depends
 * on. Starving it would trade cycle time for exactly the prescription quality
 * we just built enforcement around. The comment on that 7 records that it was
 * itself arrived at empirically ("the prompt's 6 calls plus the pre-seeded
 * explore, and one successful live pass used 7 round-trips"), and that raising
 * EPAM_MAX_ITERATIONS three times never helped because it was the wrong limit.
 *
 * So: instrument first. One line per attempt, recording what the round cost and
 * what it yielded — enough to answer "do the later rounds find anything, or
 * re-read?" and "is the cap being hit at all?" from a real run.
 *
 * phase2Used is the interesting field. It marks an attempt that explored, ended
 * in prose, and needed a SECOND no-tools call to extract the JSON — a full extra
 * round-trip that produced no new investigation. If that is common, the fix is
 * the prompt, not the cap.
 *
 * Telemetry must never break a run: every path here fails soft.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const runnerPath = join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js');
const SRC = readFileSync(runnerPath, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function ws() {
  const d = mkdtempSync(join(tmpdir(), 'detround-'));
  dirs.push(d);
  return d;
}

/** Call the real recorder out of the real module. */
function record(logDir: string | null, row: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(runnerPath);
  const fn = mod.recordDetectiveRound;
  expect(fn, 'recordDetectiveRound is not exported — it cannot be tested, and an ' +
    'untested telemetry path is how we end up trusting an empty file').toBeTypeOf('function');
  return fn(logDir, row);
}

function readRounds(d: string) {
  const f = join(d, 'detective-rounds.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('every detective round is recorded', () => {
  it('writes one line per attempt', () => {
    const d = ws();
    record(d, { storyId: 'AMSD-2041', attempt: 1, elapsedSec: 560, findings: 0 });
    record(d, { storyId: 'AMSD-2041', attempt: 2, elapsedSec: 240, findings: 1 });
    const rows = readRounds(d);
    expect(rows.length, 'rounds are not being recorded — the cap decision would ' +
      'still be a guess').toBe(2);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it('carries the fields the cap decision needs', () => {
    const d = ws();
    record(d, {
      storyId: 'AMSD-2041', attempt: 1, maxAttempts: 3, model: 'z-ai/glm-5.1',
      elapsedSec: 560, maxToolCalls: 7, phase1Findings: 0, phase2Used: true,
      findings: 2, exploreChars: 41000, hitIterationCap: false,
    });
    const r = readRounds(d)[0];
    // Cost of the round, what it yielded, and whether it wasted a round-trip.
    for (const k of ['elapsedSec', 'maxToolCalls', 'findings', 'phase1Findings',
      'phase2Used', 'hitIterationCap', 'exploreChars', 'model', 'attempt']) {
      expect(r, `missing ${k} — the measurement cannot answer its own question`)
        .toHaveProperty(k);
    }
  });

  it('stamps a timestamp so rounds can be placed on the run timeline', () => {
    const d = ws();
    record(d, { storyId: 'X', attempt: 1 });
    expect(readRounds(d)[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('appends rather than truncating across stories', () => {
    const d = ws();
    record(d, { storyId: 'A', attempt: 1 });
    record(d, { storyId: 'B', attempt: 1 });
    expect(readRounds(d).map((r) => r.storyId)).toEqual(['A', 'B']);
  });
});

describe('telemetry cannot break the run', () => {
  it('survives a null log dir', () => {
    expect(() => record(null, { storyId: 'X', attempt: 1 })).not.toThrow();
  });

  it('survives an unwritable directory', () => {
    // A run must not die because it could not write a measurement.
    const d = ws();
    const ro = join(d, 'ro');
    mkdtempSync(join(tmpdir(), 'x-')); // keep tmp churn out of the assertion
    writeFileSync(join(d, 'blocker'), 'x');
    chmodSync(d, 0o500);
    try {
      expect(() => record(ro, { storyId: 'X', attempt: 1 })).not.toThrow();
    } finally {
      chmodSync(d, 0o700);
    }
  });

  it('survives a row containing a circular reference', () => {
    const d = ws();
    const row: Record<string, unknown> = { storyId: 'X', attempt: 1 };
    row.self = row;
    expect(() => record(d, row)).not.toThrow();
  });
});

describe('it is wired into the detective, not just defined', () => {
  it('records a round where findings are resolved', () => {
    // A recorder nobody calls measures nothing. Anchored to the attempt loop.
    expect(SRC, 'recordDetectiveRound is never invoked')
      .toMatch(/recordDetectiveRound\(logDir/);
  });

  it('times the attempt from before the explore phase', () => {
    const started = SRC.indexOf('_roundStarted');
    const explore = SRC.indexOf('PHASE 1 — EXPLORE');
    expect(started, '_roundStarted is not set').toBeGreaterThan(-1);
    expect(started, 'the round clock starts AFTER the explore phase, so the ' +
      'measurement excludes the very thing being measured').toBeLessThan(explore);
  });
});
