/**
 * SWAPPING THE PROVIDER SET BETWEEN RUNS MUST NOT FAIL PRE-FLIGHT ON THE LAST RUN'S LEFTOVERS.
 *
 * The operator requirement is that claude, codemie and openrouter are hot-swappable on one install
 * with no code change. Live 2026-09-11 on pipeline-tests-49: the previous run was openrouter, its
 * PRD still carried `AMSD-1919 -> MiniMax-M3`, the next launch was the claude set, and pre-flight
 * refused it — "a story is assigned a model that is on no declared ladder".
 *
 * Three checks above it in the same script had already decided the opposite about the same file:
 * "PRD carries stale specification data from a prior run, but Jira ingest overwrites this exact
 * file before anything reads it — deferred". `_prd_pending_ingest=1` is that decision. The model-
 * ladder block never consulted it, so a run was refused over data it was about to discard.
 *
 * This runs the REAL block, lifted from preflight-check.sh, both ways: pending ingest defers; a
 * PRD that will actually be read still fails.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const PREFLIGHT = join(SCRIPTS, 'preflight-check.sh');
const SETTINGS = join(ROOT, 'orchestrations/projects/metrolinx/llm-settings.json');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real [ Model ladders ] block, from "echo \"[ Model ladders ]\"" to the closing fi. */
function extractLadderBlock(): string {
  const lines = readFileSync(PREFLIGHT, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^echo "\[ Model ladders \]"/.test(l));
  if (start < 0) throw new Error('[ Model ladders ] block not found in preflight-check.sh');
  let depth = 0, end = -1;
  for (let i = start; i < lines.length; i++) {
    if (/^if\b/.test(lines[i])) depth++;
    if (/^fi\b/.test(lines[i])) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('[ Model ladders ] block has no closing fi');
  const block = lines.slice(start, end + 1).join('\n');
  if (!/stories_with_unladdered_models/.test(block)) throw new Error('extracted the wrong block');
  return block;
}

/** A model that is on no ladder of the claude set — what an openrouter run leaves behind. */
function offLadderModel(): string {
  const s = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  const rungs = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as object).forEach(walk);
    else if (typeof v === 'string') rungs.add(v);
  };
  walk(s);
  for (const m of ['MiniMax-M3', 'not-a-rung-anywhere']) if (!rungs.has(m)) return m;
  throw new Error('could not pick a model absent from every ladder');
}

function runBlock(pendingIngest: 0 | 1) {
  const d = mkdtempSync(join(tmpdir(), 'preflight-swap-')); dirs.push(d);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    project: { name: 'metrolinx' },
    stories: [{ id: 'AMSD-1919', jiraKey: 'AMSD-1919', model: offLadderModel(), codelines: ['x'] }],
  }));
  const harness = join(d, 'h.sh');
  writeFileSync(harness, [
    '#!/bin/bash',
    `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}`,
    `PRD_FILE=${JSON.stringify(prd)}`,
    `EPAM_LLM_SETTINGS_FILE=${JSON.stringify(SETTINGS)}`,
    `_prd_pending_ingest=${pendingIngest}`,
    'FAILS=0; PASS=0',
    'ok(){ echo "  ✓ $1"; }',
    'fail(){ echo "  ✗ $1"; FAILS=$((FAILS+1)); }',
    extractLadderBlock(),
    'echo "FAILS=$FAILS"',
  ].join('\n'));
  const r = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 60_000 });
  const m = /FAILS=(\d+)/.exec(r.stdout || '');
  return { out: (r.stdout || '') + (r.stderr || ''), fails: m ? Number(m[1]) : -1 };
}

describe('a set swap is not a pre-flight failure', () => {
  it('a PRD that WILL be read still fails on an off-ladder model — the check is not weakened', () => {
    const r = runBlock(0);
    expect(r.fails, `expected the ladder check to fail:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/on no declared ladder/);
  });

  it('a PRD that Jira ingest is about to overwrite is deferred, exactly like the checks above it', () => {
    const r = runBlock(1);
    expect(r.fails,
      `pre-flight refused a run over a stale assignment the run is about to discard:\n${r.out}`).toBe(0);
    expect(r.out, 'the deferral must be announced, not silent').toMatch(/deferred/);
  });
});
