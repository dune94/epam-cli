/**
 * A FINDING WHOSE CHECK COULD NOT RUN MUST NOT BE ABLE TO HALT A RUN.
 *
 * Live 2026-08-09, AMSD-2041 cycle 2. The roster reviewer raised this, at severity `blocking`:
 *
 *   "The package @contentstack/live-preview-utils is NOT declared in any of the three
 *    codelines' manifests. The brief itself acknowledges this and instructs the implementer to
 *    install it. However, since the package is not installed, I cannot verify the symbols or
 *    the option keys against the installed package. The brief correctly instructs the
 *    implementer to verify these symbols after installation. THIS IS NOT A DEFECT IN THE BRIEF
 *    — the brief is appropriately cautious. UNVERIFIED: the symbols cannot be checked until
 *    the package is installed."
 *
 * The finding says outright that it is not a defect, and carries the severity that stops the
 * pipeline. Both correction cycles were spent on it.
 *
 * verify-findings could not save this one. It refutes a finding whose check RAN and agreed
 * with the brief; here the check could not run at all (nothing to resolve the symbols
 * against), so it fell into "unsettled — keep" and kept full blocking weight.
 *
 * The rule is structural, not a reading of the prose: an open question is not a defect. A
 * finding whose mechanical check could not be executed is downgraded to advisory — kept,
 * surfaced, and unable to halt anything. Nothing here matches on words like "UNVERIFIED";
 * the signal is whether the check ran.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { verifyFindings } = require('../../../orchestrations/scripts/lib/verify-findings.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A codeline whose manifest CAN be read, so "could not run" is never accidental. */
function codeline() {
  const dir = mkdtempSync(join(tmpdir(), 'unrunnable-')); dirs.push(dir);
  const repo = join(dir, 'one');
  mkdirSync(join(repo, '.epam'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ devDependencies: { present_dep: '1.0.0' } }));
  writeFileSync(join(repo, '.epam', 'dependency-check.json'),
    JSON.stringify({ manifestFile: 'package.json', manifestKeys: ['dependencies', 'devDependencies'] }));
  return [{ name: 'one', path: repo }];
}

/** A codeline with NO dependency-check config — the check cannot be settled there. */
function unsettleableCodeline() {
  const dir = mkdtempSync(join(tmpdir(), 'unsettleable-')); dirs.push(dir);
  const repo = join(dir, 'one');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ devDependencies: {} }));
  return [{ name: 'one', path: repo }];
}

const finding = (over: Record<string, unknown> = {}) => ({
  agent: 'some-engineer', severity: 'blocking',
  claim: 'the SDK exposes init() with these option keys',
  checked: 'resolve the package symbols against the installed package',
  found: 'the package is not installed, so the symbols cannot be checked',
  verification: {
    kind: 'dependency_declared', codeline: 'one',
    subject: 'absent_dep', expected: 'absent', briefAsserts: 'absent',
  },
  ...over,
});

describe('the harness settles checks when it can — no vacuous pass', () => {
  it('a runnable check really runs', () => {
    const f = finding({ verification: { kind: 'dependency_declared', codeline: 'one', subject: 'present_dep', expected: 'present', briefAsserts: 'absent' } });
    const r = verifyFindings([f], codeline());
    expect(r.kept.length + r.refuted.length).toBe(1);
    expect(r.unsettled.length).toBe(0);
  });
});

describe('THE DEFECT: an unrunnable check keeps blocking severity', () => {
  it('the finding is still kept — it is not thrown away', () => {
    const r = verifyFindings([finding()], unsettleableCodeline());
    expect(r.kept.length + r.unsettled.length).toBeGreaterThan(0);
  });

  it('but it can no longer be blocking', () => {
    const r = verifyFindings([finding()], unsettleableCodeline());
    const survivors = [...r.kept, ...r.unsettled];
    expect(
      survivors.filter((f: any) => f.severity === 'blocking'),
      'a check that could not be executed still carried the severity that halts the pipeline — ' +
      'two correction cycles were spent on exactly this on 2026-08-09',
    ).toEqual([]);
  });

  it('it is downgraded to advisory, not deleted', () => {
    const r = verifyFindings([finding()], unsettleableCodeline());
    const survivors = [...r.kept, ...r.unsettled];
    expect(survivors.some((f: any) => f.severity === 'advisory')).toBe(true);
  });

  it('the reason is recorded, so an operator can see why it was downgraded', () => {
    const r = verifyFindings([finding()], unsettleableCodeline());
    const f: any = [...r.kept, ...r.unsettled][0];
    expect(String(f._why || f._downgraded || '')).toMatch(/could not|unrunnable|not.*(run|settle)/i);
  });

  it('an advisory finding that could not run stays advisory', () => {
    const r = verifyFindings([finding({ severity: 'advisory' })], unsettleableCodeline());
    const f: any = [...r.kept, ...r.unsettled][0];
    expect(f.severity).toBe('advisory');
  });
});

describe('findings whose check DID run are untouched', () => {
  it('a real contradiction keeps its blocking severity', () => {
    // brief says absent, the manifest declares it — a genuine defect, and it must still halt.
    const f = finding({ verification: { kind: 'dependency_declared', codeline: 'one', subject: 'present_dep', expected: 'present', briefAsserts: 'absent' } });
    const r = verifyFindings([f], codeline());
    expect(r.kept.length).toBe(1);
    expect(r.kept[0].severity).toBe('blocking');
  });

  it('a judgement no tool settles keeps its severity — it was never a mechanical claim', () => {
    const f = finding({ verification: { kind: 'not_mechanically_checkable' } });
    const r = verifyFindings([f], codeline());
    expect(r.kept[0].severity).toBe('blocking');
  });

  it('a finding with no verification block keeps its severity', () => {
    const f: any = finding(); delete f.verification;
    expect(verifyFindings([f], codeline()).kept[0].severity).toBe('blocking');
  });
});
