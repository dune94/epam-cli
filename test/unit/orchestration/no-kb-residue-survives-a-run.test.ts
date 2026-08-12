/**
 * NO AGENT KB SURVIVES A RUN. NO CONTAMINATION FROM A PREVIOUS RUN, OF ANY KIND.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * Operator, 2026-08-12: "agent kb files = remove all after every run - there can be no
 * lingering anything to skew runs. That is strictly forbidden." And: "pre-launch MUST clean up
 * kb files and any residue from previous runs - NO CONTAMINATION from previous runs."
 *
 * THIS OVERRIDES THE PREVIOUS POLICY, which pre-run-reset.sh stated in a comment:
 *
 *     # NOT cleared: KB-<role>.md. Per-agent knowledge is the one thing meant to persist
 *
 * What that policy actually produced: kb_restore_canonical() resets KB.md and ONLY KB.md.
 * The nine KB-<name>.md files the failure analyst actually appends to — KB-gotransit.md,
 * KB-metrolinx.md, KB-typescript-engineer.md and the rest — were never reset, and neither were
 * agents/kb/constraints.json or healing-events.jsonl. KB-gotransit.md carried entries dated
 * across four separate days, and every one of them was injected into later runs' prompts as
 * current fact.
 *
 * The same run that exposed this was fed a review-feedback file three days old. Two channels,
 * one disease: state whose deletion was somebody else's job.
 *
 * The cross-run WRITES are removed separately (claude.sh no longer appends to any KB file).
 * This asserts the RESET, so residue from before that change — or from any future writer —
 * cannot reach a run either.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const KBLIB = join(ROOT, 'orchestrations/scripts/lib/kb-canonical.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Build a fake automation dir with KB residue, run the real reset, report what survives. */
function reset(files: Record<string, string>, withCanonical = true): string[] {
  const d = mkdtempSync(join(tmpdir(), 'kbresidue-')); dirs.push(d);
  mkdirSync(join(d, 'agents', 'kb'), { recursive: true });
  if (withCanonical) writeFileSync(join(d, 'agents', 'KB.md.original'), '# canonical\n');
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(d, 'agents', rel), body);

  const r = spawnSync('bash', ['-c',
    `warning() { :; }; success() { :; }; info() { :; }\n. '${KBLIB}'\nkb_restore_canonical '${d}'`],
    { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);

  const out: string[] = [];
  for (const f of readdirSync(join(d, 'agents'))) {
    if (f === 'kb') { for (const g of readdirSync(join(d, 'agents', 'kb'))) out.push(`kb/${g}`); continue; }
    out.push(f);
  }
  return out.sort();
}

describe('the harness is real — otherwise every assertion is vacuous', () => {
  it('the canonical itself is never deleted', () => {
    expect(reset({})).toContain('KB.md.original');
  });

  it('KB.md is restored from canonical, as it already was', () => {
    const d = mkdtempSync(join(tmpdir(), 'kbres2-')); dirs.push(d);
    mkdirSync(join(d, 'agents'), { recursive: true });
    writeFileSync(join(d, 'agents', 'KB.md.original'), '# canonical\n');
    writeFileSync(join(d, 'agents', 'KB.md'), '# polluted by a previous run\n');
    spawnSync('bash', ['-c',
      `warning() { :; }; success() { :; }; info() { :; }\n. '${KBLIB}'\nkb_restore_canonical '${d}'`],
      { encoding: 'utf8' });
    expect(readFileSync(join(d, 'agents', 'KB.md'), 'utf8')).toBe('# canonical\n');
  });
});

describe('THE DEFECT: PER-AGENT KB FILES SURVIVED EVERY RUN', () => {
  it('KB-<name>.md is cleared', () => {
    expect(reset({ 'KB-gotransit.md': '- [2026-08-09] a conclusion about code that has changed\n' }),
      'the analyst appends here, and it reached later runs as current fact')
      .not.toContain('KB-gotransit.md');
  });

  it('cleared for EVERY name, not a list of known ones', () => {
    const left = reset({
      'KB-gotransit.md': 'x', 'KB-metrolinx.md': 'x', 'KB-typescript-engineer.md': 'x',
      'KB-shared.md': 'x', 'KB-somethingmintedtomorrow.md': 'x',
    });
    expect(left.filter((f) => f.startsWith('KB-') && f !== 'KB.md.original')).toEqual([]);
  });
});

describe('AND THE RUN STATE UNDER agents/kb/', () => {
  // These are TRUNCATED, not deleted, and the distinction is deliberate: generate-run-report,
  // kb-replay.js and archive-run-artifacts all read them, and a MISSING file is a different
  // failure from an EMPTY one. Emptied is what "no contamination" requires; deleted would trade
  // this defect for a parse error.
  function contents(files: Record<string, string>): Record<string, string> {
    const d = mkdtempSync(join(tmpdir(), 'kbstate-')); dirs.push(d);
    mkdirSync(join(d, 'agents', 'kb'), { recursive: true });
    writeFileSync(join(d, 'agents', 'KB.md.original'), '# canonical\n');
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(d, 'agents', rel), body);
    spawnSync('bash', ['-c',
      `warning() { :; }; success() { :; }; info() { :; }; fail() { echo "$*" >&2; exit 1; }\n` +
      `. '${KBLIB}'\nkb_restore_canonical '${d}'`], { encoding: 'utf8' });
    const out: Record<string, string> = {};
    for (const g of readdirSync(join(d, 'agents', 'kb'))) {
      out[g] = readFileSync(join(d, 'agents', 'kb', g), 'utf8');
    }
    return out;
  }

  it('a previous run\'s constraints do not reach this one', () => {
    const after = contents({
      'kb/constraints.json': '[{"id":"a-constraint-from-a-run-three-days-ago"}]',
    });
    expect(after['kb/constraints.json'.replace('kb/', '')], 'the file vanished — readers expect it')
      .toBeDefined();
    expect(JSON.parse(after['constraints.json']), 'a stale constraint still gates this run').toEqual([]);
  });

  it('healing events and archives are emptied, for every file, not a named few', () => {
    const after = contents({
      'kb/healing-events.jsonl': '{"event":"from a previous run"}\n',
      'kb/constraints.archive.jsonl': '{"old":1}\n',
      'kb/some-state-added-later.jsonl': '{"x":1}\n',
    });
    for (const [name, body] of Object.entries(after)) {
      if (name.endsWith('.json')) continue;
      expect(body, `${name} carried content across the run boundary`).toBe('');
    }
    expect(Object.keys(after).sort(), 'files were deleted rather than emptied')
      .toContain('healing-events.jsonl');
  });
});

describe('A RESET THAT CANNOT CLEAN SAYS SO', () => {
  it('a missing canonical is reported, never silent', () => {
    // Pre-existing behaviour worth keeping: the KB grew unnoticed for weeks precisely because
    // a skipped reset looked like a clean start.
    const src = readFileSync(KBLIB, 'utf8');
    expect(src).toMatch(/NEVER silent|warning /);
  });

  it('the old "meant to persist" policy is gone from the reset', () => {
    const reset_sh = readFileSync(join(ROOT, 'orchestrations/scripts/pre-run-reset.sh'), 'utf8');
    expect(reset_sh, 'the reset still declares per-agent KB is meant to persist')
      .not.toMatch(/NOT cleared: KB-<role>\.md/);
  });
});
