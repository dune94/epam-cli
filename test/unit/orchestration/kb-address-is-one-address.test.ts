/**
 * THE KB IS SEEDED AT ONE ADDRESS AND READ AT ANOTHER, SO NOTHING EVER ACCUMULATES.
 *
 * mergeProjectAgents seeds `KB-<role>.md` for each minted agent. claude.sh's
 * _kb_file_for_story reads and appends `KB-<codeline>.md`. The two never meet.
 *
 * Evidence on disk 2026-08-08: 36 KB files, ALL role-keyed, ZERO codeline-keyed. Every seeded
 * brief is write-only, and because role names are minted fresh each run they accumulate
 * forever — KB-contentful-cms-engineer.md still sits there from the run where a vendor was
 * hallucinated. Live consequence, from the cost estimator on AMSD-2041:
 *
 *     KB coverage: 5 chunks retrieved  0 cited  cov: 0%
 *     ⚠ All 5 KB sources are empty stubs — zero technical content
 *
 * Cross-run learning is the one thing the KB exists for, and it has never once happened.
 *
 * The fix is one address, agreed by both sides, normalised identically in JavaScript and in
 * bash — which is what these tests pin.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roster = require('../../../orchestrations/scripts/lib/agent-roster.js');
const CLAUDE_SH = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The bash side, executed — never a reimplementation of it. */
function bashAddress(codeline: string, kbDir = '/kb'): string {
  const start = CLAUDE_SH.indexOf('_kb_file_for_story() {');
  expect(start, 'the KB address resolver is gone from claude.sh').toBeGreaterThan(-1);
  const fn = CLAUDE_SH.slice(start, CLAUDE_SH.indexOf('\n}', start) + 2);
  const dir = mkdtempSync(join(tmpdir(), 'kb-addr-')); dirs.push(dir);
  const sh = join(dir, 'r.sh');
  writeFileSync(sh, `#!/usr/bin/env bash\nset -u\n${fn}\n_kb_file_for_story "" ${JSON.stringify(kbDir)}\n`);
  return execFileSync('bash', [sh], {
    encoding: 'utf8', env: { ...process.env, EPAM_CODELINE: codeline, PRD_FILE: '', MAIN_PRD_FILE: '' },
  }).trim();
}

describe('there is ONE address function', () => {
  it('the roster library exposes it', () => {
    expect(typeof roster.kbFileForCodeline).toBe('function');
  });

  it('both sides agree, character for character', () => {
    for (const cl of ['gotransit', 'next.gotransit.com', 'Mock-Alpha', 'up_express']) {
      expect(
        roster.kbFileForCodeline('/kb', cl),
        `the seed and the reader disagree for "${cl}" — the file written is not the file read`,
      ).toBe(bashAddress(cl));
    }
  });

  it('a codeline with no name falls back to the shared store, on both sides', () => {
    expect(roster.kbFileForCodeline('/kb', '')).toBe(bashAddress(''));
    expect(roster.kbFileForCodeline('/kb', '')).toMatch(/KB-shared\.md$/);
  });

  it('the address is normalised, so label punctuation and case cannot fork the store', () => {
    // ID-1: the same repository has appeared as "gotransit" and "nextgotransitcom" across
    // runs. Normalisation cannot fix that, but it must not ADD forks of its own.
    expect(roster.kbFileForCodeline('/kb', 'Next.GoTransit.com'))
      .toBe(roster.kbFileForCodeline('/kb', 'next-gotransit-com'));
  });
});

describe('the mint seeds the address that is actually read', () => {
  function mint(codelines: { name: string }[]) {
    const dir = mkdtempSync(join(tmpdir(), 'kb-seed-')); dirs.push(dir);
    const profilesPath = join(dir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({ 'canonical-agent': 'CANONICAL' }));
    roster.mergeProjectAgents({
      profilesPath, agentsDir: dir, codelines,
      proposals: [
        { name: 'alpha-investigator', kind: 'investigator', codeline: 'alpha',
          systemPrompt: 'x'.repeat(80), rationale: 'This codeline needs its own investigator here.' },
        { name: 'some-engineer', kind: 'implementer', codeline: '*',
          systemPrompt: 'y'.repeat(80), rationale: 'Nothing in the canonical core owns this domain.' },
      ],
    });
    return dir;
  }

  it('a KB file exists at the CODELINE address the reader will use', () => {
    const dir = mint([{ name: 'alpha' }, { name: 'beta' }]);
    for (const cl of ['alpha', 'beta']) {
      expect(
        existsSync(roster.kbFileForCodeline(dir, cl)),
        `nothing seeded at ${roster.kbFileForCodeline(dir, cl)} — the reader finds an empty store forever`,
      ).toBe(true);
    }
  });

  it('NO role-keyed KB file is created', () => {
    // Role names are minted fresh each run, so a role-keyed file is unreachable by any later
    // run and accumulates forever: 36 such files were on disk, none readable.
    const dir = mint([{ name: 'alpha' }]);
    const roleKeyed = readdirSync(dir)
      .filter((f) => /^KB-.*\.md$/.test(f))
      .filter((f) => /engineer|investigator|specialist/.test(f));
    expect(roleKeyed, 'role-keyed KB files are write-only and never read').toEqual([]);
  });

  it('the shared store is seeded too, for work that spans the project', () => {
    const dir = mint([{ name: 'alpha' }]);
    expect(existsSync(join(dir, 'KB-shared.md'))).toBe(true);
  });

  it('an existing KB is never overwritten — accumulated knowledge survives a re-mint', () => {
    const dir = mint([{ name: 'alpha' }]);
    const f = roster.kbFileForCodeline(dir, 'alpha');
    writeFileSync(f, '# KB — alpha\n\n- [2026-01-01] a rule learned on an earlier run\n');
    mint([{ name: 'alpha' }]);
    // second mint into a DIFFERENT dir, so re-seed the same one explicitly
    roster.mergeProjectAgents({
      profilesPath: join(dir, 'profiles.json'), agentsDir: dir, codelines: [{ name: 'alpha' }],
      proposals: [{ name: 'alpha-investigator', kind: 'investigator', codeline: 'alpha',
        systemPrompt: 'z'.repeat(80), rationale: 'Re-minted on a later run for this codeline.' }],
    });
    expect(readFileSync(f, 'utf8'), 'a re-mint wiped what previous runs had learned')
      .toContain('a rule learned on an earlier run');
  });
});
