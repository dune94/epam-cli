/**
 * Root cause of a live cost/design defect (run #14, 2026-07-04): SKY-004 spent
 * 4 of 8 attempts (half its retry budget) on MiniMax-M3, the weakest configured
 * model, despite 4 DIFFERENT failures surfacing in that window (wrong import
 * path -> incomplete mock factory -> missing test import/mock export -> ...).
 * Model escalation only happened at attempt 5 (Rung 2), by which point the
 * base model had already demonstrated it couldn't converge on this story.
 *
 * Fix: check_failure_diversity() mirrors check_healing_effectiveness (which
 * detects the SAME diagnosis repeating) but inverted — it detects consecutive
 * DIFFERENT diagnoses while still on the un-escalated base model (Rung 0-1,
 * retries 0-3). A genuine capability gap looks like "a new kind of mistake
 * every attempt," not a single repeated slip. When detected, it sets
 * EARLY_ESCALATION_NEEDED=1, and the retry loop (mirroring the existing
 * HEALING_BROKEN handling) jumps retry_count straight to 4 — the start of
 * Rung 2, where model escalation happens — instead of exhausting the rest of
 * the base-model budget.
 *
 * This check makes zero LLM calls (pure local text comparison against
 * healing-events.jsonl), so it can be verified against the exact real SKY-004
 * diagnosis sequence from run #14 at zero token cost.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBodyBraceCounted(name: string): string {
  const start = claudeSrc.indexOf(`${name}()`);
  const braceStart = claudeSrc.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < claudeSrc.length; i++) {
    if (claudeSrc[i] === '{') depth++;
    else if (claudeSrc[i] === '}') {
      depth--;
      if (depth === 0) return claudeSrc.slice(start, i + 1);
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

describe('claude.sh — check_failure_diversity() design', () => {
  const body = extractFunctionBodyBraceCounted('check_failure_diversity');

  it('function is defined', () => {
    expect(claudeSrc).toMatch(/check_failure_diversity\s*\(\)/);
  });

  it('no-ops once the model has already escalated (rung >= 2)', () => {
    expect(body).toMatch(/_rung=\$\(\(\s*retry_num\s*\/\s*2\s*\)\)/);
    expect(body).toMatch(/\[ "\$_rung" -ge 2 \] && return 0/);
  });

  it('reuses the same token-overlap same_root_cause() logic as check_healing_effectiveness (consistency between the two signals)', () => {
    expect(body).toMatch(/STOPWORDS/);
    expect(body).toMatch(/min\(3,\s*len\(ta\),\s*len\(tb\)\)/);
    expect(body).toMatch(/ratio >= 0\.4/);
  });

  it('compares the current diagnosis against the IMMEDIATELY PRECEDING one, not the whole history', () => {
    expect(body).toMatch(/events\[-2\],\s*events\[-1\]/);
  });

  it('sets EARLY_ESCALATION_NEEDED=1 only when diagnoses are NOT the same root cause', () => {
    expect(body).toMatch(/is_different"\s*=\s*"true"/);
    expect(body).toContain('EARLY_ESCALATION_NEEDED=1');
    expect(body).toContain('export EARLY_ESCALATION_NEEDED');
  });

  it('is called from run_failure_analyst alongside check_healing_effectiveness', () => {
    const analystStart = claudeSrc.indexOf('run_failure_analyst() {');
    const callIdx = claudeSrc.indexOf('check_failure_diversity "$story_id" "$retry_num" "$diagnosis"', analystStart);
    const healingIdx = claudeSrc.indexOf('check_healing_effectiveness "$story_id" "$diagnosis"', analystStart);
    expect(callIdx).toBeGreaterThan(analystStart);
    expect(callIdx).toBeGreaterThan(healingIdx);
  });
});

describe('claude.sh — retry loop jumps to Rung 2 on EARLY_ESCALATION_NEEDED', () => {
  const jumpIdx = claudeSrc.indexOf('EARLY_ESCALATION_NEEDED:-0}" -eq 1');
  const healingBrokenIdx = claudeSrc.indexOf('HEALING_BROKEN:-0}" -eq 1');

  it('the jump block appears after the HEALING_BROKEN block (mutually exclusive, no ordering conflict)', () => {
    expect(healingBrokenIdx).toBeGreaterThan(-1);
    expect(jumpIdx).toBeGreaterThan(healingBrokenIdx);
  });

  it('resets EARLY_ESCALATION_NEEDED to 0 after handling (no bleed into the next story)', () => {
    const block = claudeSrc.slice(jumpIdx, jumpIdx + 400);
    expect(block).toMatch(/EARLY_ESCALATION_NEEDED=0/);
    expect(block).toMatch(/export EARLY_ESCALATION_NEEDED/);
  });

  it('only jumps when retry_count is still below 4 (does nothing once already at or past Rung 2)', () => {
    const block = claudeSrc.slice(jumpIdx, jumpIdx + 400);
    expect(block).toMatch(/\[ "\$retry_count" -lt 4 \]/);
    expect(block).toMatch(/retry_count=4/);
  });

  // Root cause this fixes (found live, 2026-07-06): SKY-002-impl failed 8 times
  // with 8 DIFFERENT bugs (JSON-typing, nesting, tsconfig, wrong error-message
  // wording) — the exact signature check_failure_diversity/EARLY_ESCALATION_NEEDED
  // already detects (non-repeating failure classes). Non-repeating failures
  // across attempts indicate token-selection variance, not a capability gap —
  // the model is making a DIFFERENT plausible mistake each time. Pinning
  // temperature to 0 for the rest of this story makes exact-string ACs (e.g. a
  // literal error-message substring) reachable instead of a moving target.
  it('pins EPAM_TEMPERATURE to 0 for the remainder of the story when failure diversity is detected', () => {
    const block = claudeSrc.slice(jumpIdx, jumpIdx + 1400);
    expect(block).toMatch(/export EPAM_TEMPERATURE="0"/);
  });
});

describe('claude.sh — EPAM_TEMPERATURE reset at story start (no leak across stories)', () => {
  it('resets EPAM_TEMPERATURE before resolving effort/provider settings for a new story — restoring a launcher floor if one was captured, else unsetting (see temperature-floor-restore.test.ts for full behavior coverage)', () => {
    const resetIdx = claudeSrc.indexOf('Reset temperature override at story start');
    expect(resetIdx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(resetIdx, resetIdx + 700);
    expect(block).toMatch(/unset EPAM_TEMPERATURE/);
    expect(block).toMatch(/_claude_temperature_floor/);
  });
});

describe('check_failure_diversity — REAL execution against the exact SKY-004 diagnosis sequence from run #14 (zero LLM calls)', () => {
  function runSequence(diagnoses: string[]): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'failure-diversity-test-'));
    try {
      const fnBody = extractFunctionBodyBraceCounted('check_failure_diversity');
      const healLog = join(dir, 'healing-events.jsonl');
      const scriptPath = join(dir, 'run.sh');

      const steps = diagnoses
        .map((diag, i) => `
python3 -c "
import json
with open('${healLog}', 'a') as f:
    f.write(json.dumps({'story_id': 'SKY-004', 'retry': ${i}, 'diagnosis': '''${diag.replace(/'/g, '')}'''}) + chr(10))
"
EARLY_ESCALATION_NEEDED=0
check_failure_diversity "SKY-004" "${i}" "${diag.replace(/'/g, '')}"
echo "retry=${i} EARLY_ESCALATION_NEEDED=\${EARLY_ESCALATION_NEEDED:-0}"
`)
        .join('\n');

      writeFileSync(
        scriptPath,
        `LOG_DIR="${dir}"\nwarning() { :; }\n${fnBody}\n${steps}`,
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      return output.trim().split('\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reproduces the exact live sequence: fires right after attempt 3 (retry=2), the mock-factory bug genuinely differing from the repeated import-path bug', () => {
    const results = runSequence([
      "Agent imported the skyscanner client but file lives at src skyscanner client ts ignored layout verification skill",
      "Agent wrote the skyscanner client import but file is at skyscanner client ts didn't run the prescribed find verification",
      "vi mock factory for SkyscannerClient is incomplete unmocked methods are undefined handlers throw error middleware returns 500 instead of expected status",
      "Test file missing import expect from vitest and vi mock factory missing searchFlights export",
      "Env check middleware registered after routes returns 500 not 503 server calls a method name that does not exist on SkyscannerClient",
      "Code uses public index html from src server ts but file lives at src public index html so readFileSync resolves to a missing path",
      "Agent referenced src public index html but didn't create the file and used wrong relative path",
    ]);

    expect(results[0]).toBe('retry=0 EARLY_ESCALATION_NEEDED=0'); // no prior diagnosis to compare
    expect(results[1]).toBe('retry=1 EARLY_ESCALATION_NEEDED=0'); // repeat of the same import-path bug
    expect(results[2]).toBe('retry=2 EARLY_ESCALATION_NEEDED=1'); // genuinely new bug (mock factory) — fires
    expect(results[4]).toBe('retry=4 EARLY_ESCALATION_NEEDED=0'); // rung >= 2 now — model already escalated, no-op
    expect(results[5]).toBe('retry=5 EARLY_ESCALATION_NEEDED=0');
    expect(results[6]).toBe('retry=6 EARLY_ESCALATION_NEEDED=0');
  });

  it('does NOT fire when every attempt repeats the same root cause (that is check_healing_effectiveness\'s job, not this one)', () => {
    const results = runSequence([
      "Agent imported the wrong client path and it does not resolve",
      "Agent imported the wrong client path again and it does not resolve",
      "Agent imported the wrong client path a third time and it does not resolve",
    ]);
    expect(results.every(r => r.endsWith('EARLY_ESCALATION_NEEDED=0'))).toBe(true);
  });

  it('does NOT fire on the very first attempt (no prior diagnosis exists to compare against)', () => {
    const results = runSequence(['First ever failure for this story']);
    expect(results[0]).toBe('retry=0 EARLY_ESCALATION_NEEDED=0');
  });
});

describe('retry-loop EARLY_ESCALATION_NEEDED handling — REAL execution, proves temperature pinning actually happens', () => {
  function extractRetryLoopBlock(): string {
    const idx = claudeSrc.indexOf('EARLY_ESCALATION_NEEDED:-0}" -eq 1');
    const start = claudeSrc.lastIndexOf('if [', idx);
    const end = claudeSrc.indexOf('\n            fi\n', start) + '\n            fi\n'.length;
    return claudeSrc.slice(start, end);
  }

  function runBlock(opts: { earlyEscalationNeeded: '0' | '1'; retryCount: number; maxRetries: number }): {
    stdout: string;
    finalTemperature: string;
    finalRetryCount: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'temp-pin-test-'));
    try {
      const block = extractRetryLoopBlock();
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `story_id="SKY-002-impl"`,
          `warning() { echo "WARN: $*"; }`,
          `EARLY_ESCALATION_NEEDED=${opts.earlyEscalationNeeded}`,
          `retry_count=${opts.retryCount}`,
          `MAX_RETRIES=${opts.maxRetries}`,
          block,
          `echo "FINAL_TEMPERATURE=${'$'}{EPAM_TEMPERATURE:-unset}"`,
          `echo "FINAL_RETRY_COUNT=${'$'}retry_count"`,
        ].join('\n')
      );
      const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const tempMatch = stdout.match(/FINAL_TEMPERATURE=(\S+)/);
      const retryMatch = stdout.match(/FINAL_RETRY_COUNT=(\S+)/);
      return {
        stdout,
        finalTemperature: tempMatch ? tempMatch[1] : 'MISSING',
        finalRetryCount: retryMatch ? retryMatch[1] : 'MISSING',
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live fix: when failure diversity fires, EPAM_TEMPERATURE is pinned to 0 (matches the SKY-002-impl 8-diverse-failures pattern)', () => {
    const result = runBlock({ earlyEscalationNeeded: '1', retryCount: 1, maxRetries: 8 });
    expect(result.finalTemperature).toBe('0');
    expect(result.finalRetryCount).toBe('4');
    expect(result.stdout).toMatch(/Pinning temperature to 0/);
  });

  it('does not touch EPAM_TEMPERATURE when failure diversity did not fire', () => {
    const result = runBlock({ earlyEscalationNeeded: '0', retryCount: 1, maxRetries: 8 });
    expect(result.finalTemperature).toBe('unset');
    expect(result.finalRetryCount).toBe('1');
  });

  it('still pins temperature even when the Rung-2 jump itself is a no-op (already past retry 4)', () => {
    const result = runBlock({ earlyEscalationNeeded: '1', retryCount: 5, maxRetries: 8 });
    expect(result.finalTemperature).toBe('0');
    expect(result.finalRetryCount).toBe('5'); // jump condition (retry_count < 4) is false, unchanged
  });
});
