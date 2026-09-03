/**
 * THE AUDIT THAT COUNTS PROJECT DECISIONS BAKED INTO THE ENGINE — and whether it can still see.
 *
 * Its own header records how it went blind: it scanned .sh/.js/.ts and declared "a .sh/.js/.ts file
 * is not a config file", which made RELOCATION look like repair. `/^docs\./i` moved out of
 * codeline-discovery.js into orchestrations/config/codeline-scan.json, stopped being counted, and
 * went on deciding which client repository was excluded from every project.
 *
 * And it records its own calibration failures: the numeric category needed a NAMED knob, so
 * `topN = 8` matched nothing; the truncation category required two digits, so `slice(0, 3)` was
 * invisible; and there was no category at all for another tenant's schema, a fixed vocabulary of
 * domain values, or prose addressed to a model.
 *
 * A detector that has gone blind reports ZERO and looks like success. That is the failure this
 * covers — every assertion below is that the audit still SEES something it is supposed to see.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/hardcoding-audit.sh');

function audit(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 180_000,
    cwd: join(__dirname, '../../..'),
    env: { ...process.env, NODE_BIN: process.execPath, EPAM_COVERAGE_GATED: '0', ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('the hardcoding audit still sees what it is meant to see', () => {
  it('--calibrate passes, which is the guard on the detector itself', () => {
    // Calibration is what proves each category can still match. Its own tests once sat in .bats
    // files that executed nothing, so a blind detector and a test suite that could not notice were
    // the pairing this audit exists to prevent.
    const r = audit(['--calibrate']);
    expect(r.code, `the audit cannot see its own planted cases:\n${r.out.slice(0, 1500)}`).toBe(0);
  }, 240_000);

  it('running it over the engine produces a report, not silence', () => {
    const r = audit([]);
    expect(r.out.trim(), 'the audit produced no output at all').not.toBe('');
  }, 240_000);

  it('--verify lists the matching lines for a category', () => {
    // --verify <n> and --files <n> take a CATEGORY NUMBER. They are how an operator checks that a
    // count is real rather than an artefact of a widened pattern.
    const r = audit(['--verify', '1']);
    expect(r.code, r.out.slice(0, 400)).toBe(0);
    expect(r.out, 'the category was not named in its own report').toMatch(/###/);
  }, 240_000);

  it('--files gives per-file counts for a category', () => {
    const r = audit(['--files', '1']);
    expect(r.code, r.out.slice(0, 400)).toBe(0);
    expect(r.out).toMatch(/###/);
  }, 240_000);

  it('--scope states what is covered, and that a PROJECT config is deliberately absent', () => {
    // A project's facts belong in the project's config; these are the engine's, and apply to every
    // project. Scanning a project's config would count its own decisions as engine hardcoding.
    const r = audit(['--scope']);
    expect(r.code).toBe(0);
    expect(r.out, 'the scope does not say a project config is excluded on purpose')
      .toMatch(/PROJECT|project's facts/i);
  }, 240_000);

  it('an unknown flag is refused rather than silently ignored', () => {
    // Silently ignoring it means an operator believes they scoped an audit that was never scoped.
    // Every unrecognised argument used to fall through to the default report, so `--calibrat`
    // printed a full audit and the operator believed calibration had passed. A typo in the one
    // command that proves this detector can still SEE is the typo that must not pass quietly.
    const r = audit(['--not-a-real-flag']);
    expect(r.code, 'an unknown flag was accepted and a report printed over it').not.toBe(0);
    expect(r.out, 'the refusal does not list what the real options are').toMatch(/--calibrate/);

    const typo = audit(['--calibrat']);
    expect(typo.code, 'a typo of --calibrate printed a report that looks like calibration passed')
      .not.toBe(0);
  }, 240_000);
});
