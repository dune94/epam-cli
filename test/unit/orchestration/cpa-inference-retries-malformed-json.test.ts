/**
 * A GOOD REVIEW, THROWN AWAY FOR ONE UNESCAPED QUOTE.
 *
 * Live 2026-09-08, run 20260908T215555Z (pipeline-tests-48, claude set, brownfield AMSD-1919):
 * the spec pass passed, and Step 2 — the CPA pre-pass — halted the whole codeline with
 *
 *     ⚠  CPA review did not happen: parse error: No valid JSON object found in response
 *     [CPA ERR] 1 story/stories in BLOCK gate — resolve before orchestration
 *     [orch] HALT: codeline 'gotransit' failed.
 *
 * The model had NOT wandered off. Langfuse trace 3560e7c2 holds the reply: a complete review —
 * confidence 0.80, complexityAdjustment 0.95, five substantive risk flags, five real KB gaps.
 * It failed to parse on ONE character class, at position 959 of the fenced body:
 *
 *     "toLowerCase() is ASCII-only; non-ASCII domain names (e.g., "user@münchen.de") may be ..."
 *                                                                ^ unescaped inner quotes
 *
 * extractJSON's `{`…`}` fallback cannot reach that: the damage is INTERIOR, not at the boundary.
 *
 * THE MECHANISM FOR THIS ALREADY EXISTED AND WAS NEVER WIRED. content-retry.js's own header
 * names this exact site as one of the four it was extracted for:
 *
 *     cpa-inference.js       'No valid JSON object found in response'
 *
 * ...and cpa-inference.js contained not one reference to it. The library retries with the reason
 * fed back, climbs a rung per attempt, and persists the whole rejected reply. Wiring it is the
 * fix; nothing here repairs or guesses at the model's JSON, because inventing an escape the model
 * did not write is how a silently wrong estimate gets authorised.
 *
 * The fixture is the reply Langfuse recorded, byte for byte — not a hand-written approximation
 * of it.
 */
import { createRequire } from 'module';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { provisionProject, cleanupProvisioned } from '../../support/provisioned-project';

const require = createRequire(import.meta.url);
const CPA = require.resolve('../../../orchestrations/scripts/lib/cpa-inference.js');
const { extractJSON } = require(CPA);

/** The actual bytes the model returned on 2026-09-08, pulled from the Langfuse observation. */
const REAL_MALFORMED = readFileSync(
  join(__dirname, '../../fixtures/cpa/reply-unescaped-quotes.txt'), 'utf8');

const GOOD = JSON.stringify({
  confidence: 0.8, complexityAdjustment: 0.95,
  adjustedEstimate: { aiMinutes: 72, cost: 0.22, tokens: 14500, turns: 4 },
  riskFlags: ['a real flag'], missingKbCoverage: [], citedSources: [],
  reasoning: 'ok',
});

beforeAll(() => { process.env.EPAM_PROJECT_CONFIG_DIR = provisionProject(['cpa-inference']); });
afterAll(() => { delete process.env.EPAM_PROJECT_CONFIG_DIR; cleanupProvisioned(); });

const INPUT = {
  story: { id: 'AMSD-1919', title: 'Email comparison should be case-insensitive',
           acceptanceCriteria: ['emails compare case-insensitively'] },
  formulaEstimate: { aiMinutes: 30, cost: 0.1, tokens: 5000, turns: 3 },
  systemPrompt: 'You are a CPA reviewer.',
};

/**
 * Drives the REAL main() with a stub runner that answers differently per attempt, so what is
 * asserted is what cpa-inference actually emitted — not what a mocked library was asked for.
 */
function runWithReplies(replies: string[], extraEnv: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'cpa-retry-'));
  replies.forEach((r, i) => writeFileSync(join(d, `reply${i + 1}.txt`), r));
  const runner = join(d, 'runner.sh');
  // Counts its own invocations on disk: the call count is evidence, not an assumption.
  // COUNTS ONLY THIS SEAM'S OWN CALLS. content-retry also drives the self-heal analyst on every
  // rejection — a real, separate agent invocation through the same runner. Keying on the
  // EPAM_AGENT_NAME the production code stamps keeps the attempt count honest, and proves the
  // seam identity is actually set on the spawn.
  writeFileSync(runner, `#!/usr/bin/env bash
if [ "\${EPAM_AGENT_NAME:-}" != "cpa-inference" ]; then cat > /dev/null; echo '{}'; exit 0; fi
n=1; [ -f "${d}/count" ] && n=\$(( \$(cat "${d}/count") + 1 ))
echo "\$n" > "${d}/count"
cat > "${d}/prompt\$n.txt"
f="${d}/reply\$n.txt"; [ -f "\$f" ] || f="${d}/reply${replies.length}.txt"
cat "\$f"
`);
  chmodSync(runner, 0o755);
  const r = spawnSync(process.execPath, [CPA], {
    input: JSON.stringify(INPUT), encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, AI_RUNNER_CMD: runner, OUTPUT_DIR: d, LOG_DIR: d, ...extraEnv },
  });
  const calls = Number((() => { try { return readFileSync(join(d, 'count'), 'utf8'); } catch { return '0'; } })());
  const prompts = [1, 2, 3].map(i => { try { return readFileSync(join(d, `prompt${i}.txt`), 'utf8'); } catch { return ''; } });
  return { dir: d, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, calls, prompts,
           cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

describe('the reply that halted run 20260908T215555Z', () => {
  it('is a COMPLETE review that extractJSON cannot parse — an interior unescaped quote', () => {
    // Guards against a vacuous fixture: an empty file would make every assertion below trivial.
    expect(REAL_MALFORMED.length).toBeGreaterThan(2000);
    expect(REAL_MALFORMED).toContain('"user@münchen.de"');
    expect(REAL_MALFORMED).toContain('"confidence": 0.80');
    expect(() => extractJSON(REAL_MALFORMED)).toThrow(/No valid JSON object found/);
  });
});

describe('cpa-inference recovers from a malformed reply instead of blocking the run', () => {
  it('retries with the reason fed back and USES the second answer', () => {
    const h = runWithReplies([REAL_MALFORMED, GOOD]);
    try {
      expect(h.calls, 'the runner was called once — no retry fired').toBe(2);
      const out = JSON.parse(h.stdout.trim());
      expect(out.confidence, 'the recovered review was discarded').toBe(0.8);
      expect(JSON.stringify(out.riskFlags))
        .not.toMatch(/CPA review did not happen/);
      // The retry must carry WHY, or it is the same coin flipped again.
      expect(h.prompts[1]).toMatch(/münchen|did not parse|No valid JSON/i);
    } finally { h.cleanup(); }
  });

  it('still degrades to a BLOCKing review when every attempt is malformed — never a false pass', () => {
    const h = runWithReplies([REAL_MALFORMED, REAL_MALFORMED, REAL_MALFORMED]);
    try {
      expect(h.status, 'a give-up must not crash the stage').toBe(0);
      const out = JSON.parse(h.stdout.trim());
      expect(out.confidence).toBe(0);
      expect(out._inferenceFailed).toBe(true);
      expect(JSON.stringify(out.riskFlags)).toMatch(/CPA review did not happen/);
    } finally { h.cleanup(); }
  });

  it('KEEPS THE FULL REPLY ON DISK — the evidence that stderr threw away', () => {
    const h = runWithReplies([REAL_MALFORMED, REAL_MALFORMED, REAL_MALFORMED]);
    try {
      const kept = readdirSync(h.dir).filter(f => /^rejected-.*\.txt$/.test(f));
      expect(kept.length, 'no rejected reply was persisted anywhere').toBeGreaterThan(0);
      const body = readFileSync(join(h.dir, kept[0]), 'utf8');
      // WHOLE, not the 400-char stderr excerpt that made this run undiagnosable.
      expect(body.length).toBe(REAL_MALFORMED.length);
      expect(body).toContain('user@münchen.de');
    } finally { h.cleanup(); }
  });
});
