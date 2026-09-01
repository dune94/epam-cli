/**
 * _iteration_exhaustion_bump — a dynamic, symptom-driven iteration bump
 * added 2026-08-01 after a live Metrolinx sandbox run on AMSD-2041: CPA never
 * populated cpaIterationEstimate (null) for that story, so
 * _brownfield_rung_bump's scaling produced almost nothing and the story sat
 * at the effort-tier default (10-15 iterations), hitting "capability failure
 * (max iterations)" 11 times in one run. This bump responds to the OBSERVED
 * failure instead of trusting a single static estimate: every real
 * max-iterations failure logs an event, and each prior occurrence for THIS
 * story adds a real bump on top of whatever the CPA-based scaling already
 * computed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`);
  const end = src.indexOf('\n}', start) + 2;
  return src.slice(start, end);
}

function runBump(storyId: string, events: Array<{ story_id: string; timestamp: string }>, envOverrides: Record<string, string> = {}): number {
  const dir = mkdtempSync(join(tmpdir(), 'iteration-exhaustion-'));
  try {
    if (events.length > 0) {
      writeFileSync(join(dir, 'iteration-exhaustion.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    }
    // SOURCED, NOT COPIED. LOG_DIR and the overrides are passed as environment rather than written
    // into a script beside a copied body, so the function under test is the one in claude.sh.
    const res = spawnSync('bash', ['-c',
      `. ${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts/claude.sh'))} >/dev/null 2>&1
       set +e
       # AFTER sourcing: claude.sh assigns LOG_DIR unconditionally at file scope, so passing it as
       # environment is silently overwritten and the function reads the REAL log tree — which has
       # exhaustion events in it, and answered 60 where the fixture says 0.
       LOG_DIR=${JSON.stringify(dir)}
       ${Object.entries(envOverrides).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join('\n       ')}
       _iteration_exhaustion_bump "${storyId}"`], {
      encoding: 'utf8', timeout: 180_000, cwd: REPO_ROOT,
      env: { ...process.env, NODE_BIN: process.execPath, LOG_DIR: dir,
        EPAM_PROJECT_CONFIG_DIR: join(REPO_ROOT, 'orchestrations/projects/mock3'),
        EPAM_COVERAGE_GATED: '0', ...envOverrides },
    });
    return Number((res.stdout ?? '').trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('_iteration_exhaustion_bump', () => {
  it('returns 0 when no exhaustion log exists yet (first attempt, nothing to react to)', () => {
    expect(runBump('AMSD-2041', [])).toBe(0);
  });

  it('returns 0 for a story with no prior exhaustion events, even if OTHER stories have some', () => {
    const events = [
      { story_id: 'OTHER-1', timestamp: '2026-08-01T18:30:00Z' },
      { story_id: 'OTHER-1', timestamp: '2026-08-01T18:31:00Z' },
    ];
    expect(runBump('AMSD-2041', events)).toBe(0);
  });

  it('adds EPAM_ITERATION_EXHAUSTION_BUMP (default 30) per prior occurrence for this story', () => {
    const events = [
      { story_id: 'AMSD-2041', timestamp: '2026-08-01T18:29:41Z' },
      { story_id: 'AMSD-2041', timestamp: '2026-08-01T18:31:59Z' },
      { story_id: 'AMSD-2041', timestamp: '2026-08-01T18:33:26Z' },
    ];
    expect(runBump('AMSD-2041', events)).toBe(90); // 3 * 30
  });

  it('only counts events for the matching story_id, not the whole file', () => {
    const events = [
      { story_id: 'AMSD-2041', timestamp: '2026-08-01T18:29:41Z' },
      { story_id: 'OTHER-1', timestamp: '2026-08-01T18:30:00Z' },
      { story_id: 'OTHER-1', timestamp: '2026-08-01T18:31:00Z' },
    ];
    expect(runBump('AMSD-2041', events)).toBe(30);
    expect(runBump('OTHER-1', events)).toBe(60);
  });

  it('respects a custom EPAM_ITERATION_EXHAUSTION_BUMP', () => {
    const events = [{ story_id: 'AMSD-2041', timestamp: 't1' }, { story_id: 'AMSD-2041', timestamp: 't2' }];
    expect(runBump('AMSD-2041', events, { EPAM_ITERATION_EXHAUSTION_BUMP: '10' })).toBe(20);
  });

  it('caps the bump at EPAM_ITERATION_EXHAUSTION_MAX_BUMP (default 200) so a repeatedly-failing story does not get an unbounded budget', () => {
    const events = Array.from({ length: 20 }, (_, i) => ({ story_id: 'AMSD-2041', timestamp: `t${i}` }));
    // 20 * 30 = 600, should be capped at the default 200.
    expect(runBump('AMSD-2041', events)).toBe(200);
  });

  it('respects a custom EPAM_ITERATION_EXHAUSTION_MAX_BUMP cap', () => {
    const events = Array.from({ length: 20 }, (_, i) => ({ story_id: 'AMSD-2041', timestamp: `t${i}` }));
    expect(runBump('AMSD-2041', events, { EPAM_ITERATION_EXHAUSTION_MAX_BUMP: '50' })).toBe(50);
  });
});

describe('classify_failure_class — logs an iteration-exhaustion event on capability failure (max iterations)', () => {
  function extractBlock(startMarker: string, endMarker: string): string {
    const start = claudeSrc.indexOf(startMarker);
    const end = claudeSrc.indexOf(endMarker, start);
    return claudeSrc.slice(start, end + endMarker.length);
  }

  it('appends a {story_id, timestamp} record to iteration-exhaustion.jsonl when this failure class fires', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-failure-'));
    try {
      const block = extractBlock('classify_failure_class() {', '\n}\n');
      const rawFile = join(dir, 'raw.txt');
      const resultFile = join(dir, 'result.json');
      writeFileSync(rawFile, 'some non-empty raw output');
      writeFileSync(resultFile, JSON.stringify({ result: 'Agent reached maximum iterations without completing.' }));
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `LOG_DIR="${dir}"\n` +
          `log() { :; }\nwarning() { :; }\n` +
          `${block}\n` +
          `classify_failure_class "${rawFile}" "${resultFile}" 0 "AMSD-9999"\n`
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const logPath = join(dir, 'iteration-exhaustion.jsonl');
      const lines = readFileSync(logPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]);
      expect(record.story_id).toBe('AMSD-9999');
      expect(typeof record.timestamp).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
