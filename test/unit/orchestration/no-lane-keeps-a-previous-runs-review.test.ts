/**
 * NO LANE STARTS ON A PREVIOUS RUN'S REVIEW FINDINGS.
 *
 * WRITTEN BEFORE THE FIX. Found 2026-08-13 while auditing the metrolinx writer prompt.
 *
 * The reset clears run-scoped review artefacts at `-maxdepth 1` — the parent LOG_DIR only. A lane
 * runs with LOG_DIR=$LOG_DIR/lanes/<codeline>, and the writer reads
 * $LOG_DIR/review-feedback-<story>.json. So every lane's feedback survived every reset.
 *
 * On the day this was found, all three lanes still held files written on 2026-08-05 — metrolinx's
 * carried NINE issues including FOUR blockers, about an implementation discarded a week earlier.
 * A metrolinx run would have opened its writer's prompt with "A prior code review requested
 * changes. This is the highest priority", followed by demands about code that no longer exists.
 *
 * The operator has described this exact failure before: "a review written on 2026-08-09 was still
 * being handed to the writer on 2026-08-12 ... The writer obeyed all of it, and was blamed for
 * over-reaching."
 *
 * It is also the second time the reset has been caught missing lane-scoped state — the published
 * agent-input store was the first, earlier the same day. So the rule under test is not "clear this
 * file" but "clear this CLASS of file wherever a lane can read it".
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Run the REAL review-artefact block over a LOG_DIR laid out as a run lays it out. */
function resetOver(files: Record<string, string>): { logDir: string; out: string; rc: number } {
  const dir = mkdtempSync(join(tmpdir(), 'lane-review-')); dirs.push(dir);
  const logDir = join(dir, 'logs');
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(logDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  const src = readFileSync(RESET, 'utf8');
  const start = src.indexOf('_RUN_ARTIFACT_DIR=');
  expect(start, 'the review-artefact reset is gone').toBeGreaterThan(-1);
  const end = src.indexOf('\n\n', start);
  const block = src.slice(start, end === -1 ? undefined : end);

  const script = `set -uo pipefail
LOG_DIR=${JSON.stringify(logDir)}
info() { printf '%s\\n' "$*"; }
fail_contamination() { printf 'CONTAMINATION: %s\\n' "$*"; exit 9; }
${block}
`;
  try {
    return { logDir, out: execFileSync('bash', ['-c', script], { encoding: 'utf8' }), rc: 0 };
  } catch (e: any) {
    return { logDir, out: (e.stdout || '') + (e.stderr || ''), rc: e.status ?? -1 };
  }
}

describe('A LANE DOES NOT INHERIT A PREVIOUS RUN\'S REVIEW', () => {
  it("a lane's review feedback does not survive the reset", () => {
    // THE LIVE CASE. metrolinx held 9 issues, 4 blockers, eight days old.
    const r = resetOver({
      'lanes/metrolinx/review-feedback-AMSD-2041.json': '{"issues":[{"severity":"blocker"}]}',
    });
    expect(r.rc, r.out).toBe(0);
    expect(existsSync(join(r.logDir, 'lanes/metrolinx/review-feedback-AMSD-2041.json')),
      "a lane kept a previous run's blockers, and its writer would act on them").toBe(false);
  });

  it('EVERY lane is cleared, not the one someone remembered', () => {
    const r = resetOver({
      'lanes/gotransit/review-feedback-AMSD-2041.json': '{}',
      'lanes/metrolinx/review-feedback-AMSD-2041.json': '{}',
      'lanes/upexpress/review-feedback-AMSD-2041.json': '{}',
      'review-feedback-AMSD-2041.json': '{}',
    });
    expect(r.rc, r.out).toBe(0);
    for (const p of ['lanes/gotransit', 'lanes/metrolinx', 'lanes/upexpress', '.']) {
      expect(existsSync(join(r.logDir, p, 'review-feedback-AMSD-2041.json')),
        `${p} kept its stale review`).toBe(false);
    }
  });

  it('the count it reports includes the lanes', () => {
    // "Cleared 1" while four files went is a report nobody can rely on.
    const r = resetOver({
      'review-feedback-A.json': '{}',
      'lanes/x/review-feedback-A.json': '{}',
      'lanes/y/review-feedback-A.json': '{}',
    });
    expect(r.out).toMatch(/Cleared 3 /);
  });

  it('it leaves everything that is not a run-scoped review artefact alone', () => {
    const r = resetOver({
      'lanes/x/review-feedback-A.json': '{}',
      'lanes/x/phase-cost.jsonl': 'KEEP-ME',
      'spec-summary.json': 'KEEP-ME',
    });
    expect(r.rc, r.out).toBe(0);
    expect(readFileSync(join(r.logDir, 'lanes/x/phase-cost.jsonl'), 'utf8')).toBe('KEEP-ME');
    expect(readFileSync(join(r.logDir, 'spec-summary.json'), 'utf8')).toBe('KEEP-ME');
  });

  it('nothing to clear is not an error — a first run has no prior review', () => {
    expect(resetOver({ 'spec-summary.json': '{}' }).rc).toBe(0);
  });
});

describe('IT NEVER ANNOUNCES A CLEAN SLATE IT DID NOT DELIVER', () => {
  it("a lane's review that cannot be removed ABORTS the run", () => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-review-')); dirs.push(dir);
    const logDir = join(dir, 'logs');
    const laneDir = join(logDir, 'lanes', 'metrolinx');
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(join(laneDir, 'review-feedback-A.json'), '{}');

    const src = readFileSync(RESET, 'utf8');
    const start = src.indexOf('_RUN_ARTIFACT_DIR=');
    const end = src.indexOf('\n\n', start);
    const block = src.slice(start, end === -1 ? undefined : end);
    const script = `set -uo pipefail
LOG_DIR=${JSON.stringify(logDir)}
info() { printf '%s\\n' "$*"; }
fail_contamination() { printf 'CONTAMINATION: %s\\n' "$*"; exit 9; }
chmod a-w ${JSON.stringify(laneDir)}
${block}
`;
    let rc = 0; let out = '';
    try { out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }); }
    catch (e: any) { rc = e.status ?? -1; out = (e.stdout || '') + (e.stderr || ''); }
    finally { execFileSync('chmod', ['-R', 'u+w', dir]); }
    expect(rc, `a run started on a lane's surviving review. output:\n${out}`).toBe(9);
    expect(out).toMatch(/CONTAMINATION/);
  });
});
