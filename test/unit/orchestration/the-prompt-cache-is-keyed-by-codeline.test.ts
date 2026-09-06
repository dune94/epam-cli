/**
 * THE PROMPT CACHE IS KEYED BY CODELINE — the operator's requirement, met as stated.
 *
 * Operator: "it does not have to be generated again and again ... I want it to be tagged to a
 * CODELINE and reused for the CODELINE."
 *
 * What shipped instead was a cache keyed per PROJECT: <project>/.prompt-cache/<id>.json. The
 * completion MARKER carries the codeline (.complete-<codeline>) but the entries it vouches for do
 * not, so a project working several codelines thrashes the cache — and worse, a run under codeline
 * B silently reuses prompts specialised for codeline A. Those prompts name A's repositories,
 * modules and dependencies; handing them to B is the cross-codeline contamination the marker was
 * introduced to prevent, arriving through the entries the marker points at.
 *
 * THE SEAM IS buildProjectPrompts ITSELF, driven for real, with generations COUNTED. A test that
 * inspected the cache path would pass on a path that nothing reads. Counting what runText is asked
 * to produce is the operator's sentence — "not regenerated" — turned into an assertion.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProjectPrompts } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js'));

/** One template, so what is measured is caching and nothing else. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'cache-codeline-'));
  const templates = join(dir, 'templates');
  const proj = join(dir, 'project');
  mkdirSync(templates, { recursive: true });
  mkdirSync(join(proj, 'prompts'), { recursive: true });
  writeFileSync(join(templates, 'probe.json'), JSON.stringify({
    id: 'probe', version: 1, description: 'a probe', layer: 'project', placeholders: ['__X__'],
    body: 'Do the work for __X__.',
  }));
  writeFileSync(join(templates, 'project-prompt-generation.json'), JSON.stringify({
    id: 'project-prompt-generation', version: 1, description: 'the generator', layer: 'project',
    placeholders: ['__GEN_TEMPLATE_ID__', '__GEN_TEMPLATE_BODY__'],
    body: 'Specialise __GEN_TEMPLATE_ID__:\n-----BEGIN TEMPLATE BODY-----\n__GEN_TEMPLATE_BODY__\n-----END TEMPLATE BODY-----',
  }));
  writeFileSync(join(dir, 'bootstrap.json'), JSON.stringify({
    copyVerbatim: ['project-prompt-generation'], generated: ['probe'],
  }));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ profiles: { probe: { template: 'probe' } } }));
  return { dir, templates, proj };
}

/** Runs the real builder under a declared codeline and reports how many prompts it GENERATED. */
async function runUnder(p: any, codeline: string | undefined, opts: any = {}) {
  let generations = 0;
  if (codeline === undefined) delete process.env.EPAM_CODELINE_ID;
  else process.env.EPAM_CODELINE_ID = codeline;
  const res = await buildProjectPrompts({
    templatesDir: p.templates,
    bootstrapFile: join(p.dir, 'bootstrap.json'),
    registryFile: join(p.dir, 'registry.json'),
    projectConfigDir: p.proj,
    projectContext: 'ctx', codelineContext: 'cl', mintedRoles: '',
    runText: async () => { generations += 1; return 'Do the work for __X__.'; },
    log: () => {},
    ...opts,
  });
  return { generations, res };
}

const cacheRoot = (p: any) => join(p.proj, '.prompt-cache');
const entriesUnder = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []);

let saved: string | undefined;
beforeEach(() => { saved = process.env.EPAM_CODELINE_ID; });
afterEach(() => {
  if (saved === undefined) delete process.env.EPAM_CODELINE_ID;
  else process.env.EPAM_CODELINE_ID = saved;
});

describe('the prompt cache is keyed by codeline', () => {
  it('GUARD: the cache is real — a second run under the SAME codeline generates nothing', async () => {
    // Without this, every "generated again" assertion below could pass on a builder that
    // caches nothing at all, and the suite would prove the opposite of what it claims.
    const p = project();
    try {
      const first = await runUnder(p, 'next.gotransit.com');
      expect(first.generations, 'the first run generated nothing — the harness produced no work')
        .toBeGreaterThan(0);
      const second = await runUnder(p, 'next.gotransit.com');
      expect(second.generations, 'the same codeline regenerated — the cache does not work at all')
        .toBe(0);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });

  it('a DIFFERENT codeline does not inherit the first codeline\'s prompts', async () => {
    // THE DEFECT. Today B reuses A's entries: the digest knows the template and the generator,
    // and nothing about which codeline the prompt was specialised for.
    const p = project();
    try {
      await runUnder(p, 'next.gotransit.com');
      const other = await runUnder(p, 'next.upexpress.com');
      expect(other.generations,
        'codeline next.upexpress.com reused prompts specialised for next.gotransit.com — those '
        + 'prompts name the other codeline\'s repositories, modules and dependencies')
        .toBeGreaterThan(0);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });

  it('the first codeline\'s entries SURVIVE a run by another codeline', async () => {
    // Regenerating for B is correct; destroying A's work while doing it is not — that turns one
    // paid regeneration into one per alternation, forever.
    const p = project();
    try {
      await runUnder(p, 'next.gotransit.com');
      await runUnder(p, 'next.upexpress.com');
      const back = await runUnder(p, 'next.gotransit.com');
      expect(back.generations,
        'returning to next.gotransit.com regenerated — the other codeline\'s run destroyed its cache')
        .toBe(0);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });

  it('BOTH codelines\' entries exist side by side, each under its own name', async () => {
    const p = project();
    try {
      await runUnder(p, 'next.gotransit.com');
      await runUnder(p, 'next.upexpress.com');
      const a = join(cacheRoot(p), 'next.gotransit.com');
      const b = join(cacheRoot(p), 'next.upexpress.com');
      expect(entriesUnder(a).length, 'no entries stored under next.gotransit.com').toBeGreaterThan(0);
      expect(entriesUnder(b).length, 'no entries stored under next.upexpress.com').toBeGreaterThan(0);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });

  it('THE OTHER END — an undeclared codeline changes nothing, and never adopts another\'s work', async () => {
    // No launcher in this repo sets EPAM_CODELINE_ID; the operator exports it. Making an
    // undeclared run stop reusing would charge a full regeneration for a forgotten variable, so
    // such a run reads the flat root exactly as it did before this change.
    const p = project();
    try {
      const first = await runUnder(p, undefined);
      expect(first.generations).toBeGreaterThan(0);
      const second = await runUnder(p, undefined);
      expect(second.generations, 'an undeclared run stopped reusing — behaviour changed silently')
        .toBe(0);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });

  it('an undeclared run\'s entries are NOT adopted by a codeline that runs later', async () => {
    // The dangerous half of migration. Flat entries carry no evidence of origin, so adopting them
    // is only honest for entries that PREDATE codeline keying. Once any codeline directory exists,
    // a flat file is a leftover from an undeclared run, and claiming it for a codeline would
    // attribute one codeline's prompts to another on no evidence at all.
    const p = project();
    try {
      await runUnder(p, 'next.gotransit.com');       // the cache is now keyed
      await runUnder(p, undefined);                  // an undeclared run drops entries at the root
      const other = await runUnder(p, 'next.upexpress.com');
      expect(other.generations,
        'next.upexpress.com adopted flat entries of unknown origin — attribution by guess')
        .toBeGreaterThan(0);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });

  it('a codeline name cannot escape the cache directory', async () => {
    // Codeline ids arrive from configuration and from a discovery step's output. A name carrying
    // a separator must not write outside <project>/.prompt-cache.
    const p = project();
    try {
      for (const evil of ['../../escaped', 'a/b', 'has space']) {
        await runUnder(p, evil);
        expect(existsSync(join(p.dir, 'escaped')), `codeline '${evil}' wrote outside the cache`)
          .toBe(false);
        expect(statSync(cacheRoot(p)).isDirectory()).toBe(true);
      }
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });

  it('MIGRATION: flat entries from before this change are adopted by the declared codeline', async () => {
    // metrolinx has 39 flat entries and a marker naming next.gotransit.com. Discarding them would
    // charge the operator a full regeneration for a change that is purely about where they live.
    const p = project();
    try {
      // Produce a real flat cache the old way: no codeline declared, entries at the cache root.
      await runUnder(p, undefined);
      const flat = entriesUnder(cacheRoot(p));
      expect(flat.length, 'the harness produced no flat entries — nothing to migrate').toBeGreaterThan(0);

      const after = await runUnder(p, 'next.gotransit.com');
      expect(after.generations,
        'the flat entries were not adopted by the declared codeline — the operator pays to '
        + 'regenerate prompts that already exist').toBe(0);
      expect(entriesUnder(join(cacheRoot(p), 'next.gotransit.com')).length,
        'nothing was migrated under the codeline').toBeGreaterThan(0);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });
});

describe('the codeline is DETECTED, never preset', () => {
  /**
   * Operator, 2026-09-06: "code line is detected in a live run ... this var will never be preset
   * in a live run."
   *
   * EPAM_CODELINE_ID is set by no launcher, no config file and no env file in this repo — every
   * one of its six readers only reads it. In a live run the codeline becomes known when discovery
   * resolves the PRD's scope, which is BEFORE the mint and the prompt builder run and AFTER
   * pre-run-reset has already finished. So the builder must read what the run detected rather than
   * wait for a variable nobody sets, or the cache silently never hits and the operator pays for a
   * full regeneration on every run while the log reports reuse as normal.
   *
   * PRD_FILE is exported by run-agent-orchestration.sh (line 231), so it is already in this
   * process's environment. Reading it here means there is no call site to wire and no seam that
   * can rot — the artifact the run wrote is the input.
   */
  let savedPrd: string | undefined;
  beforeEach(() => { savedPrd = process.env.PRD_FILE; });
  afterEach(() => {
    if (savedPrd === undefined) delete process.env.PRD_FILE;
    else process.env.PRD_FILE = savedPrd;
  });

  /** A PRD shaped like the successful run's: project.outputDirs[].path holds the codeline. */
  function prdWith(dir: string, paths: string[]) {
    const f = join(dir, 'prd.json');
    writeFileSync(f, JSON.stringify({
      project: { outputDirs: paths.map((p) => ({ path: p })) }, stories: [],
    }));
    return f;
  }

  it('keys the cache by the codeline the PRD resolved, with NO env var set', async () => {
    const p = project();
    try {
      delete process.env.EPAM_CODELINE_ID;
      process.env.PRD_FILE = prdWith(p.dir, ['/home/x/projects/tests/codelines/next.gotransit.com']);
      const first = await runUnder(p, undefined);
      expect(first.generations).toBeGreaterThan(0);
      expect(entriesUnder(join(cacheRoot(p), 'next.gotransit.com')).length,
        'the run detected next.gotransit.com and the cache ignored it — nothing will ever hit')
        .toBeGreaterThan(0);
      const second = await runUnder(p, undefined);
      expect(second.generations, 'the detected codeline did not produce a cache hit').toBe(0);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });

  it('writes the completion marker under the DETECTED codeline, so the gates can find it', async () => {
    // The marker and the entries it vouches for must name the same codeline. If the marker says
    // one thing and the cache another, the mint gate skips against a set of prompts that is not
    // the set it checked.
    const p = project();
    try {
      delete process.env.EPAM_CODELINE_ID;
      process.env.PRD_FILE = prdWith(p.dir, ['/home/x/codelines/next.gotransit.com']);
      await runUnder(p, undefined);
      expect(existsSync(join(cacheRoot(p), '.complete-next.gotransit.com')),
        'no marker for the detected codeline — every gate reading it will re-mint and re-provision')
        .toBe(true);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });

  it('TWO codelines in scope attribute to NEITHER — prompts cover both', async () => {
    // Specialised for two codelines, a prompt belongs to neither alone. Claiming one would hand
    // the other's run a set built for a repository it is not working in.
    const p = project();
    try {
      delete process.env.EPAM_CODELINE_ID;
      process.env.PRD_FILE = prdWith(p.dir, ['/c/next.gotransit.com', '/c/next.upexpress.com']);
      await runUnder(p, undefined);
      expect(existsSync(join(cacheRoot(p), 'next.gotransit.com')),
        'a two-codeline run claimed one of them').toBe(false);
      expect(existsSync(join(cacheRoot(p), 'next.upexpress.com'))).toBe(false);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });

  it('an explicit EPAM_CODELINE_ID still wins — the operator override survives', async () => {
    const p = project();
    try {
      process.env.PRD_FILE = prdWith(p.dir, ['/c/next.gotransit.com']);
      await runUnder(p, 'next.upexpress.com');
      expect(entriesUnder(join(cacheRoot(p), 'next.upexpress.com')).length,
        'the operator\'s explicit codeline was ignored in favour of the PRD').toBeGreaterThan(0);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });

  it('an unreadable or scopeless PRD attributes nothing, and never throws', async () => {
    const p = project();
    try {
      delete process.env.EPAM_CODELINE_ID;
      for (const bad of ['{ not json', JSON.stringify({ project: {} }), JSON.stringify({})]) {
        const f = join(p.dir, 'bad-prd.json');
        writeFileSync(f, bad);
        process.env.PRD_FILE = f;
        await expect(runUnder(p, undefined)).resolves.toBeTruthy();
      }
      process.env.PRD_FILE = join(p.dir, 'does-not-exist.json');
      await expect(runUnder(p, undefined)).resolves.toBeTruthy();
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });
});
