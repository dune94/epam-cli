/**
 * A run must report what the provider actually BILLED, not only what it tallied.
 *
 * Live metrolinx 2026-07-26, the first clean run. The narrative's cost table read:
 *
 *     Tracked total        $0.6021
 *     Billed by provider   $?
 *
 * The tracked figure is correct — it is the sum of per-call costs the pipeline
 * recorded. The billed figure was unknown for a subtler reason than it first
 * appears: every runner DOES read the provider's usage counter and log
 * `OpenRouter usage before:`/`after:`, which is exactly what the report parser
 * looks for. But those lines go to the script's STDOUT — the launch log, which
 * the run's own pre-run-reset deletes — while the report is generated from
 * $LOG_FILE, the /tmp log that receives only the tee'd phase output. Two
 * streams, and the numbers land in the one the report never reads.
 *
 * A self-reported tally is the weaker number: it is blind to retries the
 * pipeline did not attribute, to a provider that prices differently than
 * expected, and to any call made outside the accounting path. The billed
 * difference is ground truth, and the whole reason the balance is read before
 * anything is spent.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const RUNNERS = ['tier3-metrolinx-run.sh', 'tier3-travel-app-run.sh', 'tier3-skyscanner-app-run.sh'];

function archiveBlock(src: string): string {
  const i = src.indexOf('_archive_run_artifacts() {');
  if (i < 0) return '';
  const j = src.indexOf('\n}', i);
  return src.slice(i, j > i ? j : i + 4000);
}

describe('every runner captures the provider balance', () => {
  for (const runner of RUNNERS) {
    const src = (() => { try { return readFileSync(join(SCRIPTS, runner), 'utf8'); } catch { return ''; } })();
    if (!src) continue;

    it(`${runner}: records usage before and after`, () => {
      expect(src).toMatch(/usage before/i);
      expect(src, 'a starting balance with no ending balance measures nothing')
        .toMatch(/usage after/i);
    });

    it(`${runner}: writes the usage lines into the log the REPORT reads`, () => {
      // Logging them to stdout is not enough: stdout is the launch log, which
      // pre-run-reset deletes, and the report is built from $LOG_FILE. The
      // numbers must reach the file that outlives the reset.
      for (const marker of ['usage before', 'usage after']) {
        const i = src.toLowerCase().indexOf(marker);
        expect(src.slice(i, i + 200),
          `"${marker}" is emitted but never written to $LOG_FILE, so the report ` +
          'shows "Billed by provider $?" on every run')
          .toMatch(/LOG_FILE/);
      }
    });
  }
});
