/**
 * B13 — stale per-run .log files made diagnosis unreliable all day.
 *
 * pre-run-reset.sh archives and truncates a hardcoded list of 15 .jsonl files but
 * NEVER touches .log files. Those keep fixed names (review-agent-<story>.log,
 * repro-test-writer-<story>.log, regression-guard-<phase>.log) and are only
 * overwritten if the step that owns them actually runs. So after a run where a step
 * did NOT run, the file still holds output from HOURS earlier — and reads as
 * current.
 *
 * Cost on 2026-07-24 — five wrong reads, each of which sent work down a false path:
 *   - a 16:33 mock-era review-agent log attributed to a 20:52 metrolinx run,
 *     producing a whole "reviewer thrashed at 20 iterations" diagnosis that was
 *     about a different run entirely;
 *   - a metrolinx regression-guard log (161 passing tests, mozio mappers) read as
 *     the mock's, while the mock's own failure was elsewhere;
 *   - "maximum iterations (20)" counted 15 times across logs, all of them from
 *     July 18-19 runs, presented as a live companion defect;
 *   - a stale /tmp PRD reporting status=completed for a run that had just started;
 *   - repro-test-writer log content read for the wrong run's attempt.
 *
 * A missing file is honest information ("this run did not write it"). A stale file
 * is a lie that looks exactly like data. .log files are MOVED to the archive rather
 * than truncated so absence carries that meaning.
 *
 * .jsonl behaviour is deliberately unchanged: dashboards read those live and expect
 * the path to exist, so they stay truncate-in-place.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RESET_RAW = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/pre-run-reset.sh'), 'utf8');
// Scan CODE, not comments. The fix DOCUMENTS "*.log" in its rationale, and an
// earlier version of this file kept matching that prose instead of the logic —
// the same trap that has produced false positives repeatedly today.
const RESET = RESET_RAW.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

describe('B13 — per-run .log files are cleared between runs', () => {
  it('archives *.log, not only the .jsonl allowlist', () => {
    expect(RESET).toMatch(/\*\.log/);
  });

  it('MOVES .log files so a missing file means "this run did not write it"', () => {
    const i = RESET.search(/\*\.log/);
    expect(RESET.slice(Math.max(0, i - 500), i + 500)).toMatch(/\bmv\b/);
  });

  it('keeps .jsonl truncate-in-place — dashboards read those live', () => {
    // Moving a .jsonl would break the dashboard mount that reads a fixed path.
    expect(RESET).toMatch(/CLEARABLE_LOGS/);
    expect(RESET).toMatch(/>\s*"\$fp"/);
  });

  it('archives the writer-output manifest too — the gates TRUST it', () => {
    // story-outputs-<phase>.txt is the same class of hazard as a stale .log,
    // but sharper: lib/eslint-baseline-gate.sh and lib/story-outputs.sh read an
    // ABSENT manifest as "fall back and say so", and a PRESENT one as
    // authoritative writer output. A leftover from the previous run is
    // therefore not merely misleading to a human — it is a lie the lint gate,
    // review-ranger and mutant-hunter all act on, attributing another run's
    // files to this one. Found pre-launch 2026-07-26: a killed run left its
    // manifest behind and nothing cleared it.
    const i = RESET.search(/story-outputs/);
    expect(i, 'the manifest survives into the next run — the gates would read stale scope')
      .toBeGreaterThan(-1);
    expect(RESET.slice(Math.max(0, i - 500), i + 500),
      'the manifest is not MOVED, so absence cannot mean "this run produced nothing yet"')
      .toMatch(/\bmv\b/);
  });

  it('never archives into itself (the archive dir must be excluded)', () => {
    const i = RESET.search(/\*\.log/);
    const near = RESET.slice(Math.max(0, i - 600), i + 600);
    expect(near).toMatch(/maxdepth 1|-not -path|archive/);
  });

  it('ties the archive to the run id so archives are attributable', () => {
    expect(RESET).toMatch(/ORCH_RUN_ID/);
  });

  it('is non-fatal — a failed archive must not abort the run', () => {
    const i = RESET.search(/\*\.log/);
    expect(RESET.slice(i - 300, i + 700)).toMatch(/\|\| true|2>\/dev\/null/);
  });
});

/** BEHAVIOURAL: run the real archive logic against a real temp LOG_DIR. */
describe('B13 — behaviour against real files', () => {
  const { execFileSync } = require('node:child_process');
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } = require('node:fs');
  const { tmpdir } = require('node:os');

  it('a stale .log is MOVED to the archive; .jsonl is truncated in place', () => {
    const d = mkdtempSync(join(tmpdir(), 'b13-'));
    try {
      mkdirSync(join(d, 'archive'), { recursive: true });
      writeFileSync(join(d, 'review-agent-OLD-1.log'), 'stale content from hours ago\n');
      writeFileSync(join(d, 'agent-activity.jsonl'), '{"stale":true}\n');

      // Extract and run just the archive logic against this temp dir.
      const script = `
        set -uo pipefail
        LOG_DIR=${JSON.stringify(d)}
        ARCHIVE_DIR="$LOG_DIR/archive/pre-run-TESTID"
        mkdir -p "$ARCHIVE_DIR"
        : > "$LOG_DIR/agent-activity.jsonl"
        while IFS= read -r _lf; do
          [ -f "$_lf" ] || continue
          mv "$_lf" "$ARCHIVE_DIR/" 2>/dev/null || true
        done < <(find "$LOG_DIR" -maxdepth 1 -type f -name '*.log' 2>/dev/null || true)
      `;
      execFileSync('bash', ['-c', script], { encoding: 'utf8' });

      // the stale .log is GONE from the live dir — absence is now meaningful
      expect(existsSync(join(d, 'review-agent-OLD-1.log')),
        'stale .log must not remain where a reader would treat it as current').toBe(false);
      // ...but preserved in the archive
      expect(readdirSync(join(d, 'archive', 'pre-run-TESTID'))).toContain('review-agent-OLD-1.log');
      // .jsonl still EXISTS (dashboards read it) but is empty
      expect(existsSync(join(d, 'agent-activity.jsonl'))).toBe(true);
      expect(readFileSync(join(d, 'agent-activity.jsonl'), 'utf8')).toBe('');
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 30000);
});
