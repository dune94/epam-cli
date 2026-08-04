/**
 * A review that cannot stop anything is not a gate.
 *
 * LIVE EVIDENCE, run 20260804T035435Z. The coordinator reviewed all three lanes, used
 * list_files to check the manifest against the repository, and returned:
 *
 *     gotransit  verdict = needs_review
 *     upexpress  verdict = needs_review
 *     metrolinx  verdict = needs_review,  qualityScore 0.45
 *
 * Two of those lanes had a manifest naming a file that does not exist — the condition
 * that sent a writer into a 120-iteration, ~2M-token loop. The reviewer caught it. The
 * pipeline recorded the verdict into story.specReview, counted it in summary.stats, and
 * proceeded to implementation.
 *
 * The only verdict the code ever branches on is 'fail', which the review schema
 * (approved|needs_review) never emits. So needs_review is unreachable as a blocking
 * state: the reviewer can express concern but owns no word that stops anything. That is
 * a mechanism that reports and never enforces — the silent-failure class the project
 * forbids, and it would have caught this defect on its own.
 *
 * ENFORCED AT THE PRE-WRITER BOUNDARY, deterministically, from the PRD the spec pass
 * wrote. Configurable: SPEC_REVIEW_ENFORCE toggles it, SPEC_REVIEW_MIN_QUALITY sets the
 * bar. Nothing here names a project, codeline or vendor.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const GUARDS = join(REPO_ROOT, 'orchestrations/scripts/lib/story-guards.sh');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Review { verdict?: string; qualityScore?: number | null }

/** Run the real guard against a PRD the spec pass could have written. */
function runGuard(reviews: (Review | null)[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-review-'));
  dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(
    prd,
    JSON.stringify({
      stories: reviews.map((r, i) => ({
        id: `ST-${i + 1}`,
        status: 'pending',
        ...(r ? { specReview: r } : {}),
      })),
    }),
  );
  const script = join(dir, 'probe.sh');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      'log(){ echo "[log] $*"; }; info(){ echo "[info] $*"; }',
      'warning(){ echo "[warn] $*"; }; error(){ echo "[error] $*" >&2; }',
      'success(){ echo "[ok] $*"; }',
      `source ${JSON.stringify(GUARDS)}`,
      `spec_review_gate ${JSON.stringify(prd)}; echo "RC=$?"`,
    ].join('\n'),
  );
  const r = spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, ...env },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const rc = Number((out.match(/RC=(\d+)/) || [])[1] ?? -1);
  return { out, rc };
}

describe('a needs_review verdict actually blocks', () => {
  it('REPRODUCES THE LIVE GAP: needs_review halts instead of proceeding', () => {
    const { rc, out } = runGuard([{ verdict: 'needs_review', qualityScore: 0.45 }]);
    expect(
      rc,
      'the coordinator reviewed three lanes, returned needs_review on all of them, and the ' +
        'pipeline went straight to implementation. A review that cannot stop anything is ' +
        'not a gate.',
    ).not.toBe(0);
    expect(out).toMatch(/ST-1/);
  });

  it('names the story and its verdict, so the block is actionable', () => {
    const { out } = runGuard([{ verdict: 'needs_review', qualityScore: 0.45 }]);
    expect(out).toMatch(/needs_review/);
    expect(out).toMatch(/0\.45/);
  });

  it('approved passes', () => {
    expect(runGuard([{ verdict: 'approved', qualityScore: 0.9 }]).rc).toBe(0);
  });

  it('blocks the whole phase when ANY story fails, not just the first', () => {
    const { rc, out } = runGuard([
      { verdict: 'approved', qualityScore: 0.9 },
      { verdict: 'approved', qualityScore: 0.95 },
      { verdict: 'needs_review', qualityScore: 0.4 },
    ]);
    expect(rc).not.toBe(0);
    expect(out, 'the failing story was not identified').toMatch(/ST-3/);
  });
});

describe('quality score is a threshold, not decoration', () => {
  it('an approved verdict BELOW the bar still blocks', () => {
    const { rc } = runGuard([{ verdict: 'approved', qualityScore: 0.3 }]);
    expect(
      rc,
      'a reviewer can approve while scoring the work 0.3 — the score must mean something',
    ).not.toBe(0);
  });

  it('the bar is CONFIGURABLE', () => {
    const low = { SPEC_REVIEW_MIN_QUALITY: '0.2' };
    expect(runGuard([{ verdict: 'approved', qualityScore: 0.3 }], low).rc).toBe(0);
  });

  it('a missing score does not block on its own — absent is not zero', () => {
    expect(
      runGuard([{ verdict: 'approved', qualityScore: null }]).rc,
      'a reviewer that omitted the score would fail every story',
    ).toBe(0);
  });
});

describe('the gate is controllable and fails safe', () => {
  it('SPEC_REVIEW_ENFORCE=0 disables it — an operator can override deliberately', () => {
    expect(runGuard([{ verdict: 'needs_review', qualityScore: 0.1 }], { SPEC_REVIEW_ENFORCE: '0' }).rc).toBe(0);
  });

  it('a story with NO review recorded does not block (spec pass may be skipped)', () => {
    expect(
      runGuard([null]).rc,
      'a resumed run skips the spec pass, so an absent review must not halt it',
    ).toBe(0);
  });

  it('an unreadable PRD fails LOUD rather than passing silently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-review-bad-'));
    dirs.push(dir);
    const bad = join(dir, 'prd.json');
    writeFileSync(bad, '{not json');
    const script = join(dir, 'p.sh');
    writeFileSync(script, [
      '#!/usr/bin/env bash', 'set -uo pipefail',
      'log(){ :; }; info(){ :; }; warning(){ echo "[warn] $*"; }; error(){ echo "[error] $*" >&2; }; success(){ :; }',
      `source ${JSON.stringify(GUARDS)}`,
      `spec_review_gate ${JSON.stringify(bad)}; echo "RC=$?"`,
    ].join('\n'));
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 20000 });
    const out = `${r.stdout}${r.stderr}`;
    expect(out, 'a corrupt PRD passed the gate silently').toMatch(/RC=[1-9]|error|warn/i);
  });

  it('names no project, codeline or vendor', () => {
    const src = readFileSync(GUARDS, 'utf8');
    const i = src.indexOf('spec_review_gate()');
    const body = src.slice(i, src.indexOf('\n}\n', i));
    expect(body).not.toMatch(/metrolinx|gotransit|upexpress|contentstack/i);
  });
});
