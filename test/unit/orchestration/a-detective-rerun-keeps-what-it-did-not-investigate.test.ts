/**
 * RE-INVESTIGATING ONE CODELINE MUST NOT DISCARD THE OTHER TWO.
 *
 * The PRD carries a fix-site prescription per codeline. `changeRequired` — the boolean that
 * says "this file is part of the fix but needs no edit of its own" — was added to the
 * detective's contract AFTER this PRD was written, so all 13 sites carry it as `undefined`.
 * A downstream gate demands a real diff in every site, and one site's own prescription reads
 * "no code change required", so the story is unwinnable on every lane.
 *
 * The full spec pass would fix it by regenerating everything — acceptance criteria,
 * verification criteria, splits — to obtain one field. Re-running the detective alone is the
 * narrow blast radius: it regenerates fixSiteAnalysis and nothing else.
 *
 * THE FAILURE THIS GUARDS. A re-run that succeeds on one codeline and fails on another must
 * keep the failed one's existing prescription. The pipeline has destroyed correct partial work
 * exactly this way before (2026-08-09: a completeness rejection reset deleted work that was
 * right, because "we could not confirm it" was treated as "we proved it wrong"). An empty
 * answer here is false-because-unknown. It must never overwrite.
 *
 * Written BEFORE the driver.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const DRIVER = join(ROOT, 'orchestrations/scripts/detective-rerun-step.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'detrerun-')); dirs.push(d); return d;
}

/**
 * A synthetic multi-codeline PRD in the shape the real one has.
 *
 * Generic names on purpose: a fixture that named this project's codelines would let a driver
 * that hardcodes them still pass.
 */
function prdFixture() {
  const site = (file: string, cl: string) => ({
    file, function: 'f', reason: 'r', fix: 'x', helper: '', brokenLine: '',
    fixVerified: true, fileVerified: true, codeline: cl,
  });
  return {
    project: {
      name: 'fixture',
      outputDirs: [
        { codeline: 'cl-one', path: '/nonexistent/one' },
        { codeline: 'cl-two', path: '/nonexistent/two' },
        { codeline: 'cl-three', path: '/nonexistent/three' },
      ],
    },
    stories: [{
      id: 'S-1',
      title: 't',
      codeline: 'cl-one',
      codelines: ['cl-one', 'cl-two', 'cl-three'],
      fixSiteAnalysis: [
        site('a.x', 'cl-one'), site('b.x', 'cl-one'),
        site('c.x', 'cl-two'),
        site('d.x', 'cl-three'), site('e.x', 'cl-three'),
      ],
      fixSiteAnalysisPerCodeline: {
        'cl-one': [site('a.x', 'cl-one'), site('b.x', 'cl-one')],
        'cl-two': [site('c.x', 'cl-two')],
        'cl-three': [site('d.x', 'cl-three'), site('e.x', 'cl-three')],
      },
    }],
  };
}

function load() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  return require(DRIVER);
}

/** A finding in the shape the detective returns, carrying the field the re-run exists to get. */
const found = (file: string, changeRequired: boolean) => ({
  file, function: 'f', reason: 'fresh', fix: 'x', helper: '', brokenLine: '',
  changeRequired, requiredPackages: [],
});

describe('the driver exists and exposes a testable seam', () => {
  it('the driver file is present', () => {
    expect(existsSync(DRIVER), 'orchestrations/scripts/detective-rerun-step.js does not exist').toBe(true);
  });

  it('the detective is injectable, so the merge can be tested without spending an agent call', () => {
    const m = load();
    expect(typeof m.runRerun, 'runRerun must be exported').toBe('function');
    expect(typeof m.codelinesFromPrd).toBe('function');
  });
});

describe('codelines come from the PRD, never from the engine', () => {
  it('reads the codeline list out of the PRD', () => {
    const { codelinesFromPrd } = load();
    expect(codelinesFromPrd(prdFixture()).map((c: any) => c.name))
      .toEqual(['cl-one', 'cl-two', 'cl-three']);
  });

  it('a PRD declaring no codelines yields none rather than a guess', () => {
    const { codelinesFromPrd } = load();
    expect(codelinesFromPrd({ project: {}, stories: [] })).toEqual([]);
  });
});

describe('THE CORE INVARIANT: only an investigated codeline is rewritten', () => {
  it('a codeline the detective answered for is REPLACED, stamped with its codeline', async () => {
    const { runRerun } = load();
    const prd = prdFixture();
    const detective = async (story: any) =>
      (story.codeline === 'cl-two' ? [found('c-new.x', true)] : []);

    await runRerun({ prd, detective, codelines: ['cl-two'], logDir: tmp() });

    const per = prd.stories[0].fixSiteAnalysisPerCodeline;
    expect(per['cl-two'].map((f: any) => f.file)).toEqual(['c-new.x']);
    expect(per['cl-two'][0].changeRequired).toBe(true);
    expect(per['cl-two'][0].codeline, 'a finding must carry the codeline it was found in').toBe('cl-two');
  });

  it('codelines NOT selected keep their existing prescription byte-for-byte', async () => {
    const { runRerun } = load();
    const prd = prdFixture();
    const before = JSON.stringify(prd.stories[0].fixSiteAnalysisPerCodeline['cl-three']);

    await runRerun({
      prd, codelines: ['cl-two'], logDir: tmp(),
      detective: async () => [found('c-new.x', true)],
    });

    expect(JSON.stringify(prd.stories[0].fixSiteAnalysisPerCodeline['cl-three'])).toBe(before);
  });

  it('an EMPTY answer keeps the existing sites — absent is not proven-empty', async () => {
    const { runRerun } = load();
    const prd = prdFixture();
    const before = JSON.stringify(prd.stories[0].fixSiteAnalysisPerCodeline['cl-one']);

    const res = await runRerun({
      prd, codelines: ['cl-one'], logDir: tmp(),
      detective: async () => [],
    });

    expect(
      JSON.stringify(prd.stories[0].fixSiteAnalysisPerCodeline['cl-one']),
      'an empty detective answer destroyed a correct prescription',
    ).toBe(before);
    expect(res.results.find((r: any) => r.codeline === 'cl-one').status).toBe('kept');
  });

  it('a THROWN detective keeps the existing sites and reports the failure', async () => {
    const { runRerun } = load();
    const prd = prdFixture();
    const before = JSON.stringify(prd.stories[0].fixSiteAnalysisPerCodeline['cl-one']);

    const res = await runRerun({
      prd, codelines: ['cl-one'], logDir: tmp(),
      detective: async () => { throw new Error('model timeout'); },
    });

    expect(JSON.stringify(prd.stories[0].fixSiteAnalysisPerCodeline['cl-one'])).toBe(before);
    const row = res.results.find((r: any) => r.codeline === 'cl-one');
    expect(row.status).toBe('failed');
    expect(row.error, 'a failure that says nothing cannot be diagnosed').toMatch(/timeout/);
  });
});

describe('the flat list stays the union of the per-codeline truth', () => {
  it('rebuilding keeps every codeline represented and mixes none of them', async () => {
    const { runRerun } = load();
    const prd = prdFixture();

    await runRerun({
      prd, codelines: ['cl-two'], logDir: tmp(),
      detective: async () => [found('c-new.x', true)],
    });

    const flat = prd.stories[0].fixSiteAnalysis;
    // Every entry names the codeline it belongs to, and the per-codeline map agrees.
    for (const f of flat) {
      const per = prd.stories[0].fixSiteAnalysisPerCodeline[f.codeline];
      expect(per.some((p: any) => p.file === f.file),
        `${f.file} is in the flat list under ${f.codeline} but not in that codeline's own list`).toBe(true);
    }
    expect(flat.filter((f: any) => f.codeline === 'cl-one').length).toBe(2);
    expect(flat.filter((f: any) => f.codeline === 'cl-two').map((f: any) => f.file)).toEqual(['c-new.x']);
    expect(flat.filter((f: any) => f.codeline === 'cl-three').length).toBe(2);
  });
});

describe('THE POINT OF THE RE-RUN: it reports whether the field actually arrived', () => {
  it('a codeline whose sites still lack the boolean is reported unresolved', async () => {
    const { runRerun } = load();
    const prd = prdFixture();

    const res = await runRerun({
      prd, codelines: ['cl-one', 'cl-two'], logDir: tmp(),
      // cl-one answers WITHOUT the field; cl-two answers with it.
      detective: async (story: any) => (story.codeline === 'cl-one'
        ? [{ file: 'a.x', reason: 'r', fix: 'x' }]
        : [found('c-new.x', false)]),
    });

    expect(res.unresolved.map((u: any) => u.codeline),
      'a site with no changeRequired leaves the gate exactly as unwinnable as before').toContain('cl-one');
    expect(res.unresolved.map((u: any) => u.codeline)).not.toContain('cl-two');
  });

  it('changeRequired:false is a real answer, not a missing one', async () => {
    const { runRerun } = load();
    const prd = prdFixture();
    const res = await runRerun({
      prd, codelines: ['cl-two'], logDir: tmp(),
      detective: async () => [found('c.x', false)],
    });
    expect(res.unresolved).toEqual([]);
    expect(prd.stories[0].fixSiteAnalysisPerCodeline['cl-two'][0].changeRequired).toBe(false);
  });
});

describe('the PRD is not overwritten without a backup beside it', () => {
  it('writing the PRD leaves a restorable copy', () => {
    const { writePrd } = load();
    const d = tmp();
    const p = join(d, 'prd.json');
    writeFileSync(p, JSON.stringify({ stories: [], marker: 'original' }));

    writePrd(p, { stories: [], marker: 'rewritten' });

    expect(JSON.parse(readFileSync(p, 'utf8')).marker).toBe('rewritten');
    const backups = readdirSync(d).filter((f) => f.startsWith('prd.json.') && f !== 'prd.json');
    expect(backups.length, 'the PRD was rewritten with no backup to restore from').toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(d, backups[0]), 'utf8')).marker).toBe('original');
  });
});

describe('no project fact entered the engine', () => {
  it('the driver names none of this project\'s codelines or paths', () => {
    // Derived from the PROJECT's own PRD, so this test carries no client fact either.
    const prdPath = join(ROOT, 'orchestrations/projects/metrolinx/prd.json');
    if (!existsSync(prdPath)) return;
    const real = JSON.parse(readFileSync(prdPath, 'utf8'));
    const dirsDeclared = (real.project && real.project.outputDirs) || [];
    expect(dirsDeclared.length, 'no codelines to check against — this sweep would pass vacuously')
      .toBeGreaterThan(0);

    const src = readFileSync(DRIVER, 'utf8');
    const code = src.split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');

    for (const d of dirsDeclared) {
      expect(code, `codeline '${d.codeline}' is named in the driver`).not.toContain(d.codeline);
      expect(code, `path '${d.path}' is hardcoded in the driver`).not.toContain(d.path);
    }
  });
});
