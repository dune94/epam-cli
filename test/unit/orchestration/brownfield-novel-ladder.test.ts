/**
 * Novel brownfield code is always the high ladder. A defect may be medium.
 *
 * User rule, 2026-07-29. Not a heuristic and not a judgement call — the
 * classification already exists: the spec pass sets `storyKind` to "novel" or
 * "defect" (spec-mode-runner.js:2162).
 *
 * Why CPA cannot be trusted to decide this: an underspecified story looks CHEAP,
 * and underspecification is exactly what makes a novel feature expensive. Live
 * AMSD-2041 — an empty Jira ticket with no acceptance criteria — was rated
 * `effort: "low"`, `estimatedAiMinutes: 5.4214`, for a novel capability across
 * three repositories attaching to a hook with 236 callers. Every plan in every
 * lane independently called it "novel"; CPA still priced it at five minutes, so
 * it started on the cheapest rung and reached a capable model only by burning
 * two timeouts.
 *
 * A defect is different in kind: the fix site is already known and bounded, so
 * medium is a reasonable estimate. Novel code has to be designed into an
 * existing system first.
 *
 * The rule OVERRIDES CPA for novel, and leaves the defect case to CPA.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fnText(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name} not found`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

/** Run the real classifier against a story fixture. */
function tier(story: Record<string, unknown>, brownfield = '1'): string {
  const d = mkdtempSync(join(tmpdir(), 'ladder-'));
  dirs.push(d);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', ...story }] }));
  const script = join(d, 'run.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
PRD_FILE=${JSON.stringify(prd)}
MAIN_PRD_FILE=${JSON.stringify(prd)}
LOG_DIR=${JSON.stringify(d)}
EPAM_BROWNFIELD=${JSON.stringify(brownfield)}
${fnText('classify_ladder_tier')}
classify_ladder_tier S-1
`);
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
  return ((r.stdout || '') + (r.stderr || '')).trim().split('\n').pop() || '';
}

describe('a brownfield NOVEL story is always high', () => {
  it('is high even when CPA rated it low — the live AMSD-2041 case', () => {
    expect(tier({ storyKind: 'novel', effort: 'low' }),
      'a novel brownfield story started on the cheapest rung, as AMSD-2041 did')
      .toBe('high');
  });

  it('is high when CPA rated it medium', () => {
    expect(tier({ storyKind: 'novel', effort: 'medium' })).toBe('high');
  });

  it('stays high with no effort recorded at all', () => {
    // The empty-ticket case: nothing to estimate from.
    expect(tier({ storyKind: 'novel' })).toBe('high');
  });
});

describe('a defect is left to CPA', () => {
  it('does not force a defect to high', () => {
    const t = tier({ storyKind: 'defect', effort: 'medium' });
    expect(t, 'the novel rule leaked onto defects — medium is acceptable for a bug')
      .not.toBe('high');
  });
});

describe('the rule is scoped to brownfield', () => {
  it('does not apply when EPAM_BROWNFIELD is off', () => {
    // Greenfield has no existing system to design into; the reasoning does not
    // transfer, and forcing high there would raise cost for no reason.
    expect(tier({ storyKind: 'novel', effort: 'low' }, '0')).not.toBe('high');
  });
});

describe('an explicit ladderTier still wins', () => {
  it('respects a tier set deliberately on the story', () => {
    // A human or an earlier stage that pinned the tier must not be overridden.
    expect(tier({ storyKind: 'novel', ladderTier: 'medium' })).toBe('medium');
  });
});
