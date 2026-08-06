/**
 * spec-mode-runner.js's bounded corrective detective re-invocation (fired
 * when SPEC_REVIEW flags planAlignment: "unexplained_mismatch") must count
 * against the detective's own inference ladder — same fix pattern as
 * Step 3.6's writer re-implementation and team-lead-review.sh's own
 * review-agent ladder, generalized per "the ladder logic applies to ALL
 * agents, not only Step 3.6."
 *
 * Without this, a rejected-but-technically-successful detective answer would
 * be corrected using the SAME model tier every time, even though the
 * reviewer explicitly judged the answer wrong — exactly the gap that made
 * the writer's ladder silently reset across review-rejection cycles.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const specModeRunner = require(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
const orchSrc = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function newLogDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'detective-ladder-'));
  dirs.push(d);
  mkdirSync(join(d), { recursive: true });
  return d;
}

describe('advanceAgentLadderEscalation — real execution', () => {
  it('persists a real, readable escalation count via the shared bash lib (not a JS reimplementation)', () => {
    const logDir = newLogDir();
    specModeRunner.advanceAgentLadderEscalation(logDir, 'code-graph-detective', 'AMSD-2041');
    const files = readdirSync(join(logDir, 'story-retry-state'));
    expect(files.length, 'no state file was written at all').toBeGreaterThan(0);
    const content = readFileSync(join(logDir, 'story-retry-state', files[0]), 'utf8').trim();
    expect(Number(content)).toBe(1);
  });

  it('is idempotent-safe to call repeatedly — each call advances by exactly one', () => {
    const logDir = newLogDir();
    specModeRunner.advanceAgentLadderEscalation(logDir, 'code-graph-detective', 'AMSD-2041');
    specModeRunner.advanceAgentLadderEscalation(logDir, 'code-graph-detective', 'AMSD-2041');
    specModeRunner.advanceAgentLadderEscalation(logDir, 'code-graph-detective', 'AMSD-2041');
    const files = readdirSync(join(logDir, 'story-retry-state'));
    const content = readFileSync(join(logDir, 'story-retry-state', files[0]), 'utf8').trim();
    expect(Number(content)).toBe(3);
  });

  it('is scoped per story — a different story gets its own counter', () => {
    const logDir = newLogDir();
    specModeRunner.advanceAgentLadderEscalation(logDir, 'code-graph-detective', 'AMSD-2041');
    specModeRunner.advanceAgentLadderEscalation(logDir, 'code-graph-detective', 'AMSD-2042');
    const files = readdirSync(join(logDir, 'story-retry-state'));
    expect(files.length).toBe(2);
  });

  it('never throws when logDir is missing/unwritable (best-effort — must not break the corrective call it guards)', () => {
    expect(() => specModeRunner.advanceAgentLadderEscalation('', 'code-graph-detective', 'AMSD-2041')).not.toThrow();
    expect(() => specModeRunner.advanceAgentLadderEscalation('/nonexistent/no/such/dir', 'code-graph-detective', 'AMSD-2041')).not.toThrow();
  });

  it('the SAME key ai-run.sh itself would derive (agent__story) — cross-checked against the real lib function', () => {
    const logDir = newLogDir();
    specModeRunner.advanceAgentLadderEscalation(logDir, 'code-graph-detective', 'AMSD-2041');
    const files = readdirSync(join(logDir, 'story-retry-state'));
    expect(files).toContain('code-graph-detective__AMSD-2041.count');
  });
});

describe('the corrective re-invocation site actually calls it (wiring, not just the helper existing)', () => {
  it('advanceAgentLadderEscalation is called BEFORE runCodeGraphDetective in the unexplained_mismatch branch', () => {
    const branchStart = orchSrc.indexOf("review.planAlignment === 'unexplained_mismatch'");
    expect(branchStart, 'the corrective branch itself was not found — has it moved/been renamed?').toBeGreaterThan(-1);
    const advanceIdx = orchSrc.indexOf('advanceAgentLadderEscalation(logDir', branchStart);
    const detectiveCallIdx = orchSrc.indexOf('await runCodeGraphDetective(story, logDir, {', branchStart);
    expect(advanceIdx, 'advanceAgentLadderEscalation is not called in the corrective branch at all').toBeGreaterThan(-1);
    expect(detectiveCallIdx).toBeGreaterThan(-1);
    expect(advanceIdx, 'the ladder must advance BEFORE re-invoking the detective, not after').toBeLessThan(detectiveCallIdx);
  });
});
