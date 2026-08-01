/**
 * contextualize-stories.sh's --apply block must actually persist
 * cpaEffortTier onto the story — the field resolve_effort_settings()
 * (claude.sh) reads to upgrade the real iteration/token budget (see
 * cpa-effort-tier-upgrades-iterations.test.ts). A typo or dropped field here
 * would silently defeat that fix even though claude.sh's own logic is
 * correct — the same class of gap as the original bug (a real signal
 * computed but never reaching the field that matters).
 *
 * Extracts the REAL, unmodified jq write block verbatim from the script and
 * runs it for real against representative CPA output for each gate/effort
 * combination, rather than re-implementing the write logic.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPT_PATH = join(REPO_ROOT, 'orchestrations/scripts/contextualize-stories.sh');
const src = readFileSync(SCRIPT_PATH, 'utf8');

function extractBlock(startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(`block not found (start=${start}, end=${end}) — has the script moved/changed shape?`);
  }
  return src.slice(start, end);
}

// From the ladder-tier case statement through the end of the jq write call.
const applyBlock = extractBlock(
  'case "$b_gate" in',
  "\"$PRD_FILE\" > \"${PRD_FILE}.tmp\" && mv \"${PRD_FILE}.tmp\" \"$PRD_FILE\""
) + '"$PRD_FILE" > "${PRD_FILE}.tmp" && mv "${PRD_FILE}.tmp" "$PRD_FILE"';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function applyFor(gate: string, effort: string, iterEstimate = 1): any {
  const dir = mkdtempSync(join(tmpdir(), 'cpa-write-'));
  dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'AMSD-2041', effort }] }));

  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `PRD_FILE='${prd}'`,
    `backup='${prd}'`,
    `b_gate='${gate}'`,
    `b_eff='${effort}'`,
    `b_iter_estimate='${iterEstimate}'`,
    'b_min=1; b_cost=0.1; b_tok=100; b_turns=5; b_mhrs=0.01; b_conf=0.7; sid="AMSD-2041"',
    applyBlock,
    `jq -c '.stories[] | select(.id=="AMSD-2041")' "$PRD_FILE"`,
  ].join('\n');
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

describe('contextualize-stories.sh --apply writes cpaEffortTier (real extracted script block)', () => {
  it('gate=review always writes cpaEffortTier=high, regardless of input effort', () => {
    expect(applyFor('review', 'low').cpaEffortTier).toBe('high');
  });

  it('gate=block always writes cpaEffortTier=high', () => {
    expect(applyFor('block', 'low').cpaEffortTier).toBe('high');
  });

  it('gate=pass with effort=high writes cpaEffortTier=high', () => {
    expect(applyFor('pass', 'high').cpaEffortTier).toBe('high');
  });

  it('gate=pass with effort=low writes cpaEffortTier=medium (matches ladderTier, not a downgrade signal)', () => {
    const applied = applyFor('pass', 'low');
    expect(applied.cpaEffortTier).toBe('medium');
    expect(applied.cpaEffortTier).toBe(applied.ladderTier);
  });

  it('writes cpaIterationEstimate from the CPA result', () => {
    expect(applyFor('review', 'low', 80).cpaIterationEstimate).toBe(80);
  });

  it('defaults cpaIterationEstimate to 1 when the CPA result omits it', () => {
    expect(applyFor('pass', 'low').cpaIterationEstimate).toBe(1);
  });
});
