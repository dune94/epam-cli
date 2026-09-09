/**
 * THE SECOND SITE content-retry WAS EXTRACTED FOR, AND THE SECOND ONE NEVER WIRED.
 *
 * content-retry.js's header names four parse sites it exists to protect. Two were wired
 * (codeline-discovery, spec-mode) and two were not. cpa-inference — the first unwired one — halted
 * the live run 20260908T215555Z on an unescaped quote inside an otherwise complete review.
 *
 *     ac-gate.js       'No JSON in <what> response'
 *
 * is the other. It is less dangerous than cpa-inference was, and deliberately so: each of its
 * three call sites degrades to a value that BLOCKS rather than passes — 'unknown' for a verdict,
 * the inclusive split for a routing decision, and a rethrow for elaboration, which the file
 * documents at length after the 2026-07-29 cascade. So this never invented a green tick.
 *
 * It still threw away a paid call on the first malformed character, and left no evidence: the
 * reply reached stderr truncated at 200 characters and nothing captured that stream.
 *
 * These tests EXECUTE ac-gate.js against a stub runner that answers differently per attempt. The
 * ladder is real, so the model named on attempt 2 proves the retry climbed rather than reflipping
 * the same coin.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AC_GATE = join(__dirname, '../../../orchestrations/scripts/lib/ac-gate.js');

/** The real 2026-09-08 shape: a complete object with an unescaped quote inside a string value. */
const MALFORMED =
  '{"verdict":"sufficient","reason":"the field says "user@münchen.de" which is fine","gaps":[],'
  + '"enrichedAcs":[],"codeline":"core"}';
const GOOD =
  '{"verdict":"sufficient","reason":"ok","gaps":[],"enrichedAcs":[],"codeline":"core"}';

function run(replies: string[]) {
  const d = mkdtempSync(join(tmpdir(), 'acg-'));
  replies.forEach((r, i) => writeFileSync(join(d, `reply${i + 1}.txt`), r));
  const runner = join(d, 'runner.sh');
  // Records the MODEL each attempt ran on, so a climb is evidence rather than an assumption.
  writeFileSync(runner, `#!/usr/bin/env bash
n=1; [ -f "${d}/count" ] && n=\$(( \$(cat "${d}/count") + 1 ))
echo "\$n" > "${d}/count"
cat > "${d}/prompt\$n.txt"
echo "\${EPAM_MODEL:-none}" >> "${d}/models.txt"
f="${d}/reply\$n.txt"; [ -f "\$f" ] || f="${d}/reply${replies.length}.txt"
cat "\$f"
`);
  chmodSync(runner, 0o755);
  writeFileSync(join(d, 'issues.json'), JSON.stringify([{
    jiraKey: 'X-1', title: 't', description: 'd',
    acceptanceCriteria: ['a', 'b', 'c criterion long enough to read as meaningful'],
  }]));
  const r = spawnSync(process.execPath, [AC_GATE, '--issues', join(d, 'issues.json')], {
    encoding: 'utf8', timeout: 60_000,
    env: {
      ...process.env,
      AI_RUNNER_CMD: runner,
      JIRA_CODELINES: 'core',
      LOG_DIR: d, OUTPUT_DIR: d,
      EPAM_MODEL_LADDER_MEDIUM: 'model-A=model-B|model-B=model-C',
      EPAM_MODEL_LADDER_MEDIUM_START: 'model-A',
    },
  });
  const read = (f: string) => { try { return readFileSync(join(d, f), 'utf8'); } catch { return ''; } };
  return { dir: d, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status,
           calls: Number(read('count') || '0'), models: read('models.txt').trim().split('\n').filter(Boolean),
           prompt2: read('prompt2.txt'),
           cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

describe('ac-gate survives a malformed reply', () => {
  it('retries and uses the second answer instead of degrading to "unknown"', () => {
    const h = run([MALFORMED, GOOD]);
    try {
      expect(h.calls, 'no retry fired — the call was parsed once and abandoned').toBeGreaterThan(1);
      expect(h.stdout).not.toMatch(/"verdict"\s*:\s*"unknown"/);
      // The retry must say WHAT broke, or the model has no reason to answer differently.
      expect(h.prompt2).toMatch(/JSON|did not parse|unescaped/i);
    } finally { h.cleanup(); }
  });

  it('CLIMBS A RUNG between attempts — a retry on the same model is the same coin flipped again', () => {
    const h = run([MALFORMED, GOOD]);
    try {
      expect(h.models[0]).toBe('model-A');
      expect(h.models[1], 'attempt 2 re-ran the identical model').toBe('model-B');
    } finally { h.cleanup(); }
  });

  it('still refuses to invent a verdict when every attempt is malformed', () => {
    const h = run([MALFORMED, MALFORMED, MALFORMED]);
    try {
      expect(h.stdout).toMatch(/"verdict"\s*:\s*"unknown"/);
    } finally { h.cleanup(); }
  });

  it('KEEPS THE FULL REPLY ON DISK rather than 200 characters on an uncaptured stderr', () => {
    const h = run([MALFORMED, MALFORMED, MALFORMED]);
    try {
      const kept = readdirSync(h.dir).filter(f => /^rejected-.*\.txt$/.test(f));
      expect(kept.length, 'the rejected reply was persisted nowhere').toBeGreaterThan(0);
      expect(readFileSync(join(h.dir, kept[0]), 'utf8')).toContain('user@münchen.de');
    } finally { h.cleanup(); }
  });
});
