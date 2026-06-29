/**
 * Test story AC integrity — guards against the recurring failure where
 * openspec writes test story ACs that conflict with the actual implementation.
 *
 * Root cause: spec-mode runs BEFORE implementation exists, so ACs assert
 * behaviours the implementation never produces. This test suite catches
 * the specific failure patterns observed in runs 78/80 before the next run.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRD_PATH = join(__dirname, '../../../orchestrations/travel-app-prd.json');
const PROFILES_PATH = join(__dirname, '../../../orchestrations/agents/profiles.json');

const prd = JSON.parse(readFileSync(PRD_PATH, 'utf8'));
const profiles = JSON.parse(readFileSync(PROFILES_PATH, 'utf8'));
const byId = new Map(prd.stories.map((s: any) => [s.id, s]));

/** When a story has delegated its ACs to split children, collect ACs from all children too. */
function acsOf(s: any): string[] {
  const acs: string[] = s?.acceptanceCriteria ?? [];
  const delegated = acs.some((ac: string) => /Delegated to split children/i.test(ac));
  if (!delegated) return acs;
  return [
    ...acs,
    ...prd.stories
      .filter((c: any) => c?.specification?.createdFrom === s.id)
      .flatMap((c: any) => acsOf(c)),
  ];
}

/**
 * Find a story by the file it owns (suffix match against technicalNotes.files).
 * Searches all stories in the PRD — not just active ones — so spec-pass splits are found.
 * Returns the first match. If multiple stories own the same file (sequential ownership),
 * use storyByFileLast() to get the final writer.
 */
function storyByFile(fileSuffix: string): any {
  return prd.stories.find((s: any) =>
    (s.technicalNotes?.files ?? []).some((f: string) => f.endsWith(fileSuffix))
  );
}

/** Returns all stories that claim a given file suffix. */
function storiesByFile(fileSuffix: string): any[] {
  return prd.stories.filter((s: any) =>
    (s.technicalNotes?.files ?? []).some((f: string) => f.endsWith(fileSuffix))
  );
}

// ── 1. test-engineer profile enforces read-first ──────────────────────────────
describe('test-engineer agent profile — read-first mandate', () => {
  it('profile contains IMPLEMENTATION READ-FIRST MANDATE', () => {
    const profile: string = profiles['test-engineer'] ?? '';
    expect(profile).toContain('IMPLEMENTATION READ-FIRST MANDATE');
  });

  it('profile instructs agent to read source files before writing tests', () => {
    const profile: string = profiles['test-engineer'] ?? '';
    expect(profile).toMatch(/read.*\.ts.*before/i);
  });

  it('profile explicitly bans @jest/globals', () => {
    const profile: string = profiles['test-engineer'] ?? '';
    expect(profile).toContain('@jest/globals');
    expect(profile).toMatch(/NEVER use @jest\/globals/i);
  });

  it('profile states ACs are hints and source code is truth', () => {
    const profile: string = profiles['test-engineer'] ?? '';
    expect(profile).toMatch(/ACs.*hints.*source.*truth|source.*truth.*ACs.*hints/i);
  });

  it('profile warns against hardcoding column widths', () => {
    const profile: string = profiles['test-engineer'] ?? '';
    expect(profile).toMatch(/fixed column width|hardcode.*width/i);
  });
});

// ── 2. table.test.ts story ACs match dynamic implementation ──────────────────
describe('story owning table.test.ts — ACs match dynamic renderTable', () => {
  const story = storyByFile('table.test.ts');
  const acs: string[] = acsOf(story);
  const notes: string = story?.technicalNotes?.notes ?? '';

  it('a story exists that owns table.test.ts', () => {
    expect(story).toBeTruthy();
  });

  it('exactly one story owns table.test.ts on a clean spec-pass PRD', () => {
    if (!story) return; // pre-spec-pass: skip
    // Only enforce on clean spec-pass PRD (no stale accumulated splits from prior runs)
    const isClean = prd.stories.every((s: any) =>
      !s?.specification?.createdFrom || s?.specification?.splitOrigin === 'spec-pass'
    );
    if (!isClean) return; // stale accumulated PRD: skip
    expect(storiesByFile('table.test.ts')).toHaveLength(1);
  });

  it('no AC prescribes fixed column width as an assertion (Airline=15, Departure=10)', () => {
    // Pattern: AC asserting width IS a specific number (not warning against it)
    // Avoid matching "Do NOT hardcode widths like 15" or "not '2h'"
    const fixedWidthPattern = /width.*(?:are|is|must be|exactly)[^.]*\b15\b|Airline\s*=\s*15(?!\s*\w)|Departure\s*=\s*10(?!\s*\w)/i;
    const violating = acs.filter(ac => fixedWidthPattern.test(ac) && !/do not|NOT|avoid|never/i.test(ac.split(fixedWidthPattern)[0].slice(-20)));
    expect(violating).toHaveLength(0);
  });

  it('no AC prescribes "2h" as an expected duration cell value', () => {
    // Pattern: AC asserting duration renders as '2h' (not one saying it should NOT)
    const violating = acs.filter(ac =>
      /renders.*['"]2h['"]|cell.*['"]2h['"]|['"]2h['"].*expected|2h.*suffix/i.test(ac) &&
      !/no.*'?2h'?|not.*'?2h'?|'2h'.*not/i.test(ac)
    );
    expect(violating).toHaveLength(0);
  });

  it('ACs state column widths are DYNAMIC', () => {
    const hasDynamic = acs.some(ac => /dynamic/i.test(ac) || /Math\.max/i.test(ac));
    expect(hasDynamic).toBe(true);
  });

  it("ACs state renderTable([]) returns 'No flights found.'", () => {
    const hasEmpty = acs.some(ac => /No flights found/i.test(ac));
    expect(hasEmpty).toBe(true);
  });

  it('notes instruct agent to READ table.ts first', () => {
    expect(notes).toMatch(/read.*table\.ts|table\.ts.*first/i);
  });

  it('no AC references fixed header string with padded Airline column', () => {
    // The old wrong assertion: 'Airline        | Price | Departure  |...'
    const violating = acs.filter(ac => /Airline\s{7,}/.test(ac));
    expect(violating).toHaveLength(0);
  });
});

// ── 3. server.test.ts story ACs match actual server routes ───────────────────
describe('story owning server.test.ts — ACs match server.ts implementation', () => {
  const story = storyByFile('server.test.ts');
  const acs: string[] = acsOf(story);
  const notes: string = story?.technicalNotes?.notes ?? '';

  it('a story exists that owns server.test.ts', () => {
    expect(story).toBeTruthy();
  });

  it('exactly one story owns server.test.ts on a clean spec-pass PRD', () => {
    if (!story) return;
    const isClean = prd.stories.every((s: any) =>
      !s?.specification?.createdFrom || s?.specification?.splitOrigin === 'spec-pass'
    );
    if (!isClean) return;
    expect(storiesByFile('server.test.ts')).toHaveLength(1);
  });

  it('no AC asserts /cheapest endpoint exists', () => {
    // ACs may mention /cheapest in a "do not test" context — only flag prescriptive uses
    const violating = acs.filter(ac =>
      /\/cheapest/.test(ac) && !/no.*\/cheapest|\/cheapest.*not exist|There is NO/i.test(ac)
    );
    expect(violating).toHaveLength(0);
  });

  it('ACs use from/to query params for the request (not origin/destination)', () => {
    const hasFromTo = acs.some(ac => /\bfrom\b.*\bto\b|\?from=/.test(ac));
    expect(hasFromTo).toBe(true);
  });

  it('no AC prescribes 400 for adults=0 (server allows 0)', () => {
    const violating = acs.filter(ac =>
      /adults.*0.*400|400.*adults.*0|adults.*≤.*0/i.test(ac) &&
      !/do not|NOT|server allows|VALID/i.test(ac)
    );
    expect(violating).toHaveLength(0);
  });

  it('notes instruct agent to READ server.ts first', () => {
    expect(notes).toMatch(/read.*server\.ts|server\.ts.*first/i);
  });

  it('notes warn that there is NO /cheapest endpoint', () => {
    expect(notes).toMatch(/no.*cheapest|cheapest.*not exist/i);
  });
});

// ── 4. cli.test.ts story ACs match actual cli.ts ─────────────────────────────
describe('story owning cli.test.ts — ACs match cli.ts implementation', () => {
  const story = storyByFile('cli.test.ts');
  const acs: string[] = story?.acceptanceCriteria ?? [];
  const notes: string = story?.technicalNotes?.notes ?? '';

  it('a story exists that owns cli.test.ts', () => {
    expect(story).toBeTruthy();
  });

  it('exactly one story owns cli.test.ts on a clean spec-pass PRD', () => {
    if (!story) return;
    const isClean = prd.stories.every((s: any) =>
      !s?.specification?.createdFrom || s?.specification?.splitOrigin === 'spec-pass'
    );
    if (!isClean) return;
    expect(storiesByFile('cli.test.ts')).toHaveLength(1);
  });

  it('ACs state parseArguments([]) returns empty object (no defaults)', () => {
    const hasEmptyReturn = acs.some(ac =>
      /parseArguments\(\[\]\).*\{\}|returns.*\{\}.*empty|no.*default/i.test(ac)
    );
    expect(hasEmptyReturn).toBe(true);
  });

  it('no AC asserts default values like origin:LHR from parseArguments', () => {
    const violating = acs.filter(ac =>
      /parseArguments\(\[\]\).*origin.*LHR|default.*LHR|LHR.*default/i.test(ac)
    );
    expect(violating).toHaveLength(0);
  });

  it('ACs instruct mocking ./skyscanner/client (not ./client)', () => {
    const hasMockPath = acs.some(ac => /\.\/skyscanner\/client/.test(ac));
    expect(hasMockPath).toBe(true);
  });

  it('ACs ban @jest/globals', () => {
    const hasBan = acs.some(ac => /@jest\/globals|NEVER.*jest/i.test(ac));
    expect(hasBan).toBe(true);
  });

  it('notes instruct agent to READ cli.ts first', () => {
    expect(notes).toMatch(/read.*cli\.ts|cli\.ts.*first/i);
  });
});

// ── 5. client.test.ts story ACs match actual client.ts ───────────────────────
describe('story owning client.test.ts — ACs match client.ts implementation', () => {
  const story = storyByFile('client.test.ts');
  const acs: string[] = acsOf(story);
  const notes: string = story?.technicalNotes?.notes ?? '';

  it('a story exists that owns client.test.ts', () => {
    expect(story).toBeTruthy();
  });

  it('exactly one story owns client.test.ts on a clean spec-pass PRD', () => {
    if (!story) return;
    const isClean = prd.stories.every((s: any) =>
      !s?.specification?.createdFrom || s?.specification?.splitOrigin === 'spec-pass'
    );
    if (!isClean) return;
    expect(storiesByFile('client.test.ts')).toHaveLength(1);
  });

  it('ACs state fetch uses POST method (not GET)', () => {
    const hasPost = acs.some(ac => /POST/i.test(ac));
    expect(hasPost).toBe(true);
  });

  it('no AC asserts URL query params (fetch uses POST body)', () => {
    const violating = acs.filter(ac =>
      /url.*contain.*origin=|url.*contain.*destination=|url.*contain.*rapidapi-key=/i.test(ac)
    );
    expect(violating).toHaveLength(0);
  });

  it('ACs specify correct header name X-RapidAPI-Key', () => {
    const hasHeader = acs.some(ac => /X-RapidAPI-Key/i.test(ac));
    expect(hasHeader).toBe(true);
  });

  it('no AC prescribes x-rapidapi-host header as required (not in implementation)', () => {
    const violating = acs.filter(ac =>
      /x-rapidapi-host/i.test(ac) && !/no.*x-rapidapi-host|not.*x-rapidapi-host|There is no/i.test(ac)
    );
    expect(violating).toHaveLength(0);
  });

  it('notes instruct agent to READ client.ts first', () => {
    expect(notes).toMatch(/read.*client\.ts|client\.ts.*first/i);
  });

  it('ACs specify SkyscannerClient constructor takes an object { apiKey } not a plain string', () => {
    // Recurring failure: agents pass new SkyscannerClient("key") which is TS2345
    const hasObjectForm = acsOf(story).some(ac =>
      /\{\s*apiKey\s*\}|apiKey.*object|object.*apiKey|options.*object|new SkyscannerClient\(\{/i.test(ac)
    );
    expect(hasObjectForm).toBe(true);
  });
});

// ── 6. scaffold integrity — app package.json and tsconfig prerequisites ───────
describe('scaffold integrity — skyscanner-app package.json and tsconfig', () => {
  // These tests catch missing devDependencies and tsconfig gaps BEFORE a run.
  // If tests run against the actual app files, they fail fast rather than
  // wasting a full run (server.test.ts failing with TS2307 after 30 minutes).

  const appRoot = join(__dirname, '../../../orchestrations/../../../skyscanner-app');
  const appPkgPath = join(appRoot, 'package.json');
  const appTsconfigPath = join(appRoot, 'tsconfig.json');

  let appPkg: any = null;
  let appTsconfig: any = null;

  try { appPkg = JSON.parse(readFileSync(appPkgPath, 'utf8')); } catch { /* app not scaffolded yet */ }
  try { appTsconfig = JSON.parse(readFileSync(appTsconfigPath, 'utf8')); } catch { /* app not scaffolded yet */ }

  it('server.test.ts imports supertest — supertest must be in devDependencies', () => {
    if (!appPkg) return; // app not scaffolded yet, skip
    const deps = { ...appPkg.dependencies, ...appPkg.devDependencies };
    expect(Object.keys(deps)).toContain('supertest');
  });

  it('@types/supertest must be in devDependencies when supertest is used', () => {
    if (!appPkg) return;
    const deps = { ...appPkg.dependencies, ...appPkg.devDependencies };
    if (!deps['supertest']) return;
    expect(Object.keys(deps)).toContain('@types/supertest');
  });

  it('tsconfig.json types includes vitest/globals so tsc --noEmit resolves vi/expect/describe', () => {
    // Without "vitest/globals" in types, tsc --noEmit throws TS2304 for vi, expect, describe.
    // vitest globals=true in vitest.config.ts works at runtime but not for tsc.
    if (!appTsconfig) return;
    const types: string[] = appTsconfig?.compilerOptions?.types ?? [];
    expect(types).toContain('vitest/globals');
  });
});
