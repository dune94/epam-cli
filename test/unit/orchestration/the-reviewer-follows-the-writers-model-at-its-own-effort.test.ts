/**
 * THE REVIEWER FOLLOWS THE WRITER'S MODEL, AT ITS OWN EFFORT AND TEMPERATURE.
 *
 * Operator, 2026-10-11 (cost recommendation #1, superseding the 2026-08-22 "same rung EXACT setup" rule for effort and
 * temperature): AMSD-2974 run 9's team-lead review took the writer's top rung — Opus 5.5, effort max, temperature 0.8 —
 * because at the top of the model chain next_ladder_step raises effort as "the only lever left". Seven such reviews were
 * $42.99 of the run's $83.51. The reviewer still follows the writer UP the model ladder (model + provider from the
 * story's rung record); its reasoning effort is its own rung-0 effort and its temperature is its own seam's.
 *
 * EXECUTED: the reviewer's real rung block, lifted from team-lead-review.sh, with a writer rung record on disk, the
 * real lib/model-ladders.sh, and the seam's temperature as seam_ladder_export leaves it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
const SRC = readFileSync(join(S, 'team-lead-review.sh'), 'utf8');

/** From the rung reads to the line that logs what the reviewer will run on. */
function rungBlock(): string {
  const start = SRC.indexOf('_rung_model=$(story_rung_get "$LOG_DIR" "$story_id" model)');
  const endMarker = SRC.indexOf('log "  review-agent follows', start) >= 0 ? SRC.indexOf('log "  review-agent follows', start) : SRC.indexOf('log "  review-agent takes', start);
  const end = SRC.indexOf('\n', endMarker);
  if (start < 0 || endMarker < 0) throw new Error('the reviewer\'s rung block was not found — the harness is stale');
  return SRC.slice(start, end).replace(/\n\s*continue\n/g, '\n return 1\n');
}

function review(env: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'reviewer-rung-'));
  mkdirSync(join(d, 'story-rung'));
  writeFileSync(join(d, 'story-rung', 'S-1.json'), JSON.stringify({
    model: 'writer-top-model', provider: 'writer-provider', reasoningEffort: 'max', temperature: '0.8',
  }));
  const script = [
    'set -uo pipefail',
    'log(){ :; }; error(){ :; }; warning(){ :; }',
    `SCRIPT_DIR=${JSON.stringify(S)}; LOG_DIR=${JSON.stringify(d)}; story_id=S-1; ISSUES=()`,
    '. "$SCRIPT_DIR/lib/story-retry-state.sh"; . "$SCRIPT_DIR/lib/story-outputs.sh"',
    '. "$SCRIPT_DIR/lib/model-ladders.sh"',
    // What seam_ladder_export leaves for this seam: its own temperature.
    'export EPAM_TEMPERATURE=0.1',
    'review_one(){',
    rungBlock(),
    '}',
    'review_one',
    'printf "MODEL=%s\\nPROVIDER=%s\\nEFFORT=%s\\nTEMP=%s\\n" "$_rung_model" "$_rung_provider" "${EPAM_REASONING_EFFORT:-}" "${EPAM_TEMPERATURE:-}"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', ...env } });
  const out = `${r.stdout}${r.stderr}`;
  const v = (k: string) => (out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
  return { out, model: v('MODEL'), provider: v('PROVIDER'), effort: v('EFFORT'), temp: v('TEMP') };
}

describe('the reviewer follows the writer\'s model at its own effort', () => {
  it('model and provider are the writer\'s — the reviewer still climbs with the writer', () => {
    const r = review();
    expect(r.model, r.out).toBe('writer-top-model');
    expect(r.provider).toBe('writer-provider');
  });

  it('effort is NOT the writer\'s top-rung "max" — it is the reviewer\'s own rung-0 effort', () => {
    const r = review({ EPAM_RUNG0_REASONING_EFFORT: 'medium' });
    expect(r.effort, r.out).toBe('medium');
  });

  it('the rung-0 effort is read from the ladder configuration, not written into the reviewer', () => {
    expect(review({ EPAM_RUNG0_REASONING_EFFORT: 'high' }).effort).toBe('high');
  });

  it('temperature is the reviewer seam\'s own (0.1), not the writer\'s 0.8', () => {
    expect(review().temp).toBe('0.1');
  });
});
