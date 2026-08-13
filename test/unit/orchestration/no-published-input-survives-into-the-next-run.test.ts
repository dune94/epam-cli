/**
 * NO PUBLISHED AGENT INPUT SURVIVES INTO THE NEXT RUN.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * Agent outputs now travel through a store under LOG_DIR. That store is exactly the kind of thing
 * the operator has already ruled on, twice:
 *
 *   "I never granted permission to persist ANY such file across runs."
 *   "agent kb files = remove all after every run — there can be no lingering anything to skew runs."
 *
 * The reason is on the record. A review written on 2026-08-09 was handed to a writer on
 * 2026-08-12 as "your previous attempt"; it was a different run against code that no longer
 * existed, and the writer obeyed all of it and was blamed for over-reaching.
 *
 * A published fix-plan is the same hazard with a shorter fuse: the detective re-runs each time,
 * and yesterday's plan looks exactly like today's to every consumer. So the reset must clear the
 * store, and — because this reset has already been caught twice enumerating names while a sibling
 * artefact survived — it must clear it by pattern, and must ABORT rather than announce a clean
 * slate it did not deliver.
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

/** A LOG_DIR carrying a previous run's published inputs, then the REAL reset block over it. */
function resetOver(files: Record<string, string>): { logDir: string; out: string; rc: number } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-io-reset-')); dirs.push(dir);
  const logDir = join(dir, 'logs');
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(logDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }

  // Lift the store-clearing block out of the real script and run it. Extracting by marker rather
  // than copying keeps this a test OF the reset, not a test of a paraphrase of it.
  const src = readFileSync(RESET, 'utf8');
  const start = src.indexOf('_AGENT_IO_DIR=');
  if (start === -1) {
    return { logDir, out: 'the reset does not clear the published-input store at all', rc: 99 };
  }
  const end = src.indexOf('\n\n', start);
  const block = src.slice(start, end === -1 ? undefined : end);

  const script = `set -uo pipefail
LOG_DIR=${JSON.stringify(logDir)}
info() { printf '%s\\n' "$*"; }
fail_contamination() { printf 'CONTAMINATION: %s\\n' "$*"; exit 9; }
${block}
`;
  try {
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    return { logDir, out, rc: 0 };
  } catch (e: any) {
    return { logDir, out: (e.stdout || '') + (e.stderr || ''), rc: e.status ?? -1 };
  }
}

describe('THE STORE IS CLEARED BEFORE A RUN STARTS', () => {
  it("a previous run's published plan does not survive", () => {
    const r = resetOver({
      'agent-io/AMSD-1/fix-plan': 'YESTERDAY-PLAN',
      'agent-io/AMSD-1/fix-plan.from': 'code-graph-detective',
    });
    expect(r.rc, r.out).toBe(0);
    expect(existsSync(join(r.logDir, 'agent-io/AMSD-1/fix-plan')),
      "a previous run's plan is still published, and every consumer would act on it").toBe(false);
  });

  it('EVERY kind goes, not the ones somebody remembered to name', () => {
    // This reset has twice been caught clearing by name while a sibling artefact survived. A kind
    // published for the first time tomorrow must be covered by what is written today.
    const r = resetOver({
      'agent-io/AMSD-1/fix-plan': 'a',
      'agent-io/AMSD-1/review-feedback': 'b',
      'agent-io/AMSD-1/a-kind-invented-after-this-test-was-written': 'c',
      'agent-io/AMSD-2/diagnosis': 'd',
    });
    expect(r.rc, r.out).toBe(0);
    expect(existsSync(join(r.logDir, 'agent-io/AMSD-1')), 'one story kept its inputs').toBe(false);
    expect(existsSync(join(r.logDir, 'agent-io/AMSD-2')), 'another story kept its inputs').toBe(false);
  });

  it('it says what it cleared, rather than clearing in silence', () => {
    const r = resetOver({ 'agent-io/AMSD-1/fix-plan': 'x' });
    expect(r.out, 'the reset cleared published inputs without reporting it').toMatch(/publish|input|agent-io/i);
  });

  it('an empty store is not an error — a first run has nothing to clear', () => {
    const r = resetOver({ 'unrelated.json': '{}' });
    expect(r.rc, r.out).toBe(0);
  });

  it('it leaves everything that is NOT a published input alone', () => {
    const r = resetOver({ 'agent-io/AMSD-1/fix-plan': 'x', 'spec-summary.json': 'KEEP-ME' });
    expect(r.rc, r.out).toBe(0);
    expect(readFileSync(join(r.logDir, 'spec-summary.json'), 'utf8'),
      'the reset deleted an artefact that is not a published input').toBe('KEEP-ME');
  });
});

describe('IT NEVER ANNOUNCES A CLEAN SLATE IT DID NOT DELIVER', () => {
  it('a store that could not be cleared ABORTS the run', () => {
    // Exit 9 is this pipeline's contamination status. Starting a run on another run's inputs is
    // the whole defect; reporting success while they survive is worse than failing.
    const dir = mkdtempSync(join(tmpdir(), 'agent-io-reset-')); dirs.push(dir);
    const logDir = join(dir, 'logs');
    const storyDir = join(logDir, 'agent-io', 'AMSD-1');
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(join(storyDir, 'fix-plan'), 'SURVIVES');

    const src = readFileSync(RESET, 'utf8');
    const start = src.indexOf('_AGENT_IO_DIR=');
    expect(start, 'the reset does not clear the published-input store at all').toBeGreaterThan(-1);
    const end = src.indexOf('\n\n', start);
    const block = src.slice(start, end === -1 ? undefined : end);

    // rm cannot remove the file because the directory is not writable — the real way this fails.
    const script = `set -uo pipefail
LOG_DIR=${JSON.stringify(logDir)}
info() { printf '%s\\n' "$*"; }
fail_contamination() { printf 'CONTAMINATION: %s\\n' "$*"; exit 9; }
chmod a-w ${JSON.stringify(storyDir)}
${block}
`;
    let rc = 0; let out = '';
    try {
      out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    } catch (e: any) {
      rc = e.status ?? -1; out = (e.stdout || '') + (e.stderr || '');
    } finally {
      execFileSync('chmod', ['-R', 'u+w', dir]);
    }
    expect(rc, `a run started on surviving published inputs. output:\n${out}`).toBe(9);
    expect(out).toMatch(/CONTAMINATION/);
  });
});
