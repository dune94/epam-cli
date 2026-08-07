/**
 * THE REVIEWER MUST DEMAND CAPABILITY CHECKS WITHOUT NAMING A STACK.
 *
 * Its first live run found seven blocking defects, every one evidenced — but all by reading
 * manifests. It established that a dependency was or was not DECLARED and stopped there, so a
 * brief asserting a configuration key that does not exist inside the installed artefact passed
 * unchallenged, in four briefs, while the reviewer held resolution tools it never reached for.
 *
 * The correction is method, not vocabulary: presence is not capability. Encoding it as a list
 * of things to check — identifier syntax, where exports live, which manifest matters — would
 * put one ecosystem's facts into the generic engine under another name. The agent decides WHAT
 * to verify; the project's plugins know HOW; the engine names neither.
 *
 * So this test asserts two things at once: that the instruction exists, and that it is free of
 * any stack, framework, package, directory or filename.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS = join(__dirname, '../../../orchestrations/agents');
const FILES = ['profiles.json.original', 'profiles.canonical.json', 'profiles.json'];

const briefs = FILES.map(f => ({
  file: f,
  brief: JSON.parse(readFileSync(join(AGENTS, f), 'utf8'))['roster-reviewer'] as string,
}));

describe('the reviewer exists in every profile file', () => {
  it.each(FILES)('%s carries the roster-reviewer', (f) => {
    const b = briefs.find(x => x.file === f)!.brief;
    expect(b, `${f} has no roster-reviewer`).toBeTruthy();
    expect(b.length).toBeGreaterThan(1000);
  });
});

describe('it demands capability checks, not presence checks', () => {
  it.each(FILES)('%s separates presence from capability', (f) => {
    const b = briefs.find(x => x.file === f)!.brief;
    expect(b).toMatch(/PRESENCE IS NOT CAPABILITY/);
    expect(
      b,
      'nothing tells it to resolve the thing itself rather than the package around it',
    ).toMatch(/resolve THAT/);
    expect(b).toMatch(/at the version this project actually\s+pins/);
  });

  it('it names the dangerous shape — installed but mislabelled', () => {
    const b = briefs[0].brief;
    expect(b).toMatch(/attribute to it a capability it does not have/i);
    expect(b).toMatch(/resolves, builds and quietly does nothing/i);
  });

  it('an unsettleable claim is reported unverified, not guessed either way', () => {
    const b = briefs[0].brief;
    expect(b).toMatch(/report it as unverified/i);
    expect(b, 'it may promote an unchecked claim to sound').toMatch(/never upgrade an unchecked claim/i);
    expect(b, 'it may condemn a claim it merely could not reach').toMatch(/never downgrade one you simply could not/i);
  });

  it('it judges the project in front of it, not how such projects usually look', () => {
    const b = briefs[0].brief;
    expect(b).toMatch(/never against how such projects usually look/i);
    expect(b).toMatch(/only a defect when/i);
  });
});

describe('THE RULE: no stack, package, directory or filename in the brief', () => {
  const FORBIDDEN = [
    /\bjest\b/i, /\bvitest\b/i, /\bmocha\b/i, /\bpytest\b/i,
    /\bnpm\b/i, /\byarn\b/i, /\bpip\b/i, /\bmaven\b/i, /\bcargo\b/i,
    /node_modules/i, /package\.json/i, /requirements\.txt/i, /go\.mod/i,
    /\btypescript\b/i, /\bjavascript\b/i, /\bpython\b/i, /\bjava\b/i,
    /\breact\b/i, /\bnext\.js\b/i, /\bangular\b/i, /\bvue\b/i,
    /\bsrc\//i, /\bdist\//i, /\.tsx?\b/i, /\.spec\b/i, /\.test\b/i,
  ];

  it.each(FILES)('%s names no ecosystem', (f) => {
    const b = briefs.find(x => x.file === f)!.brief;
    for (const re of FORBIDDEN) {
      expect(b, `the reviewer brief hardcodes ${re} — it must judge any stack`).not.toMatch(re);
    }
  });

  it('all three files carry the identical brief — no drift between them', () => {
    const [a, ...rest] = briefs.map(x => x.brief);
    for (const b of rest) expect(b).toBe(a);
  });
});
