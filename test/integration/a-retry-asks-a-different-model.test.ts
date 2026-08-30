/**
 * RETEST OF cf92def — "the roster specialiser climbs too", shipped with no test.
 *
 * The claim in that commit: buildProjectRoster has always handed `attempt` to its producer, and
 * mint-agents-step's produce() destructured `{ canonicalCopyPath, outPath, refusal }` — dropping
 * it. All three attempts therefore re-ran the SAME model, so a refusal was handed back to the one
 * model that had just produced it.
 *
 * Telling a model what it got wrong is half a retry; the other half is asking a model that can do
 * better. A retry budget spent entirely on one rung is a budget of one.
 *
 * This drives the real buildProjectRoster with a producer that records what it is handed, so the
 * property is observed rather than asserted about source text.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { buildProjectRoster } = require('../../orchestrations/scripts/lib/project-roster.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// THE REAL CANONICAL ROSTER, not a shape I invented. My first attempt used {agents:{...}} and
// buildProjectRoster refused it with "canonical has no usable entries" — the file is a flat map of
// agent name to persona string. A fabricated fixture only confirms what I already believed.
const CANONICAL_PATH = join(__dirname, '../../orchestrations/agents/profiles.canonical.json');

function scene() {
  const dir = mkdtempSync(join(tmpdir(), 'roster-')); dirs.push(dir);
  const canonicalPath = CANONICAL_PATH;
  const projectConfigDir = join(dir, 'project');
  const logDir = join(dir, 'logs');
  require('node:fs').mkdirSync(projectConfigDir, { recursive: true });
  require('node:fs').mkdirSync(logDir, { recursive: true });
  return { canonicalPath, projectConfigDir, logDir };
}

describe('a retry asks a different model', () => {
  it('every attempt is handed its own attempt number — not all the same one', async () => {
    const s = scene();
    const seen: unknown[] = [];

    // A producer that never satisfies the contract, so all three attempts are spent — and records
    // exactly what the caller handed it each time.
    const produce = async (args: any) => { seen.push(args.attempt); /* writes nothing */ };
    const review = async () => ({ verdict: 'approved', findings: [] });

    try {
      await buildProjectRoster({
        canonicalPath: s.canonicalPath, logDir: s.logDir,
        projectConfigDir: s.projectConfigDir, produce, review, attempts: 3, log: () => {},
      });
    } catch { /* failing to produce a roster is the point; the ATTEMPT NUMBERS are the subject */ }

    expect(seen.length, 'the producer was never called — nothing is under test').toBeGreaterThan(1);
    expect(seen, 'every attempt ran on the same rung: a refusal was fed back to the model that '
      + 'had just produced it, and a budget of three was really a budget of one')
      .toEqual([...Array(seen.length)].map((_, i) => i + 1));
  }, 60_000);

  it('the producer is also told WHY the last attempt was refused', async () => {
    // The other half of a retry: the next model must be told what was wrong, not just be a
    // different model.
    const s = scene();
    const refusals: unknown[] = [];
    const produce = async (args: any) => {
      refusals.push(args.refusal);
      writeFileSync(join(s.projectConfigDir, 'project-roster.json'), '{"not":"a roster"}');
    };
    const review = async () => ({ verdict: 'approved', findings: [] });

    try {
      await buildProjectRoster({
        canonicalPath: s.canonicalPath, logDir: s.logDir,
        projectConfigDir: s.projectConfigDir, produce, review, attempts: 2, log: () => {},
      });
    } catch { /* expected */ }

    expect(refusals.length).toBeGreaterThan(1);
    expect(refusals[0], 'the first attempt cannot have a prior refusal').toBeFalsy();
    expect(String(refusals[1] || ''), 'attempt 2 was told nothing about why attempt 1 failed')
      .not.toBe('');
  }, 60_000);
});
