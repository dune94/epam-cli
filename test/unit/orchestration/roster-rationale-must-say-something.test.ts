/**
 * A REQUIRED FIELD THAT ACCEPTS ANYTHING IS NOT A REQUIRED FIELD.
 *
 * `rationale` is marked required in the mint's JSON schema, so a model cannot omit it. Live
 * 2026-08-07: every one of five minted agents came back with the rationale `"..."`. The schema
 * was satisfied; nothing was said.
 *
 * That field is not decoration. It is:
 *   - the justification the operator reads at the roster pause, which exists precisely so a
 *     human can assess the team before it is handed any work — five agents each explaining
 *     themselves with an ellipsis makes that review impossible;
 *   - the seed line of every minted agent's KB ("Minted for this project because: ...");
 *   - what a corrective cycle is told about the roles it is KEEPING, so a replacement can be
 *     positioned against them.
 *
 * The check is structural, never a vocabulary list: count the letters and digits after
 * collapsing whitespace. "..." and "-" and "  " carry none. This says nothing about what a
 * rationale must ARGUE — only that it argues something. The threshold is
 * EPAM_ROSTER_RATIONALE_MIN_CHARS.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roster = require('../../../orchestrations/scripts/lib/agent-roster.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => {
  delete process.env.EPAM_PROJECT_CONFIG_DIR;
  delete process.env.EPAM_PROJECT_INVESTIGATORS_FILE;
  delete process.env.EPAM_ROSTER_RATIONALE_MIN_CHARS;
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'rationale-')); dirs.push(dir);
  const profilesPath = join(dir, 'profiles.json');
  writeFileSync(profilesPath, JSON.stringify({ 'canonical-agent': 'CANONICAL' }, null, 2));
  return { dir, profilesPath };
}

const GOOD = {
  name: 'some-domain-engineer',
  kind: 'implementer',
  codeline: '*',
  systemPrompt: 'You own a distinct domain of this project. '.repeat(12),
  rationale: 'This project has a scheduling domain that no canonical role covers.',
};

function merge(rationale: unknown) {
  const { dir, profilesPath } = workspace();
  const res = roster.mergeProjectAgents({
    profilesPath, agentsDir: dir, proposals: [{ ...GOOD, rationale }],
  });
  const profiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
  return { res, profiles, dir };
}

describe('the fixture is real', () => {
  it('a proposal with a substantive rationale is minted — the check is not refusing everything', () => {
    const { res, profiles } = merge(GOOD.rationale);
    expect(res.rejected).toEqual([]);
    expect(res.minted.map((m: any) => m.name)).toEqual([GOOD.name]);
    expect(profiles[GOOD.name]).toBe(GOOD.systemPrompt);
  });
});

describe('a rationale that says nothing is refused', () => {
  // The live case, exactly as it came back.
  it('"..." is rejected — this is the defect that reached a real roster', () => {
    const { res, profiles } = merge('...');
    expect(res.minted).toEqual([]);
    expect(res.rejected.length).toBe(1);
    expect(
      profiles[GOOD.name],
      'an agent with no stated reason was written into the roster anyway',
    ).toBeUndefined();
  });

  it('the rejection says what was wrong, so a corrective cycle can act on it', () => {
    const { res } = merge('...');
    expect(res.rejected[0].reason).toMatch(/rationale/i);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   \n\t '],
    ['punctuation only', '-- ... !!'],
    ['a single letter', 'x'],
    ['missing entirely', undefined],
    ['not a string', 42],
  ])('%s is refused', (_label, value) => {
    expect(merge(value).res.minted).toEqual([]);
  });
});

describe('the threshold is a length, not a vocabulary', () => {
  it('no word is required or forbidden — any text of sufficient length passes', () => {
    // Deliberately unlike the sample wording: nothing may key off particular terms.
    const { res } = merge('zzzz qqqq wwww vvvv yyyy jjjj kkkk hhhh gggg ffff');
    expect(res.minted.length).toBe(1);
  });

  it('length is counted in letters and digits, not raw characters', () => {
    // 60 characters, 4 of them alphanumeric — padding must not buy a pass.
    const { res } = merge(`why  ${' . '.repeat(20)}`);
    expect(res.minted).toEqual([]);
  });

  it('the threshold is configurable, and the default is not zero', () => {
    process.env.EPAM_ROSTER_RATIONALE_MIN_CHARS = '4';
    expect(merge('need').res.minted.length, 'a lowered threshold was not honoured').toBe(1);

    process.env.EPAM_ROSTER_RATIONALE_MIN_CHARS = '500';
    expect(merge(GOOD.rationale).res.minted, 'a raised threshold was not honoured').toEqual([]);

    delete process.env.EPAM_ROSTER_RATIONALE_MIN_CHARS;
    expect(merge('...').res.minted, 'the default admits an ellipsis').toEqual([]);
  });
});

describe('the KB seed carries the reason, so it is never seeded with an ellipsis', () => {
  it('a minted agent KB states why it exists', () => {
    const { dir } = merge(GOOD.rationale);
    const kb = readFileSync(join(dir, `KB-${GOOD.name}.md`), 'utf8');
    expect(kb).toContain('scheduling domain');
    expect(kb).not.toMatch(/no rationale recorded/);
  });
});
