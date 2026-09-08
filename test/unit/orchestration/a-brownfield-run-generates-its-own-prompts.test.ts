/**
 * A BROWNFIELD RUN GENERATES ITS OWN PROMPTS — and a greenfield run never notices.
 *
 * WHY THIS EXISTS. Resolving a `.brownfield` template variant (engine-prompt's variantIdFor) is
 * inert on its own, for two reasons this test pins down:
 *
 *   1. THE BUILDER READS ITS OWN ZONE. buildProjectPrompts takes templatesDir as a PARAMETER and
 *      joins `${id}.json` itself in seven places. It never calls engine-prompt's resolver, so a
 *      variant sitting in the template zone was read by nobody at generation time — the project
 *      layer was specialised from the greenfield text no matter what the flag said.
 *
 *   2. THE COMPLETION MARKER SHORT-CIRCUITS EVERYTHING. `.prompt-cache/.complete-<codeline>` is
 *      checked in four places (run-agent-orchestration.sh twice, pre-run-reset.sh,
 *      mint-agents-step.js) and makes the mint skip ENTIRELY. A greenfield run leaves that marker;
 *      the next brownfield run on the same codeline would skip generation and serve the greenfield
 *      prompts it finds on disk. On a cached codeline — the normal case, "cache in place" — the
 *      brownfield variant would therefore never once be executed.
 *
 * The variant is a dimension of the CACHE KEY, not just of the id. Greenfield's marker name stays
 * byte-identical to today's, so nothing already on disk is invalidated by this change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(__dirname, '../../../');
const BUILDER = join(REPO_ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const builder = require(BUILDER);

/** Emulates the model under the SEGMENTS contract: echo back the segments it was shown. */
const echoSegments = (p: string) => {
  const segs = [...String(p).matchAll(/--- SEGMENT \d+ ---\n([\s\S]*?)(?=\n--- SEGMENT \d+ ---|\n--- END SEGMENTS ---)/g)]
    .map((m) => m[1]);
  const out = (segs.length ? segs : ['']);
  return out.map((x, i) => `--- SEGMENT ${i + 1} ---\n${x}`).join('\n') + '\n--- END SEGMENTS ---';
};

const { buildProjectPrompts, writeCompletionMarker } = builder;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A project with one generated template, and optionally a brownfield variant of it. */
function project({ withVariant }: { withVariant: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'brownfield-gen-'));
  dirs.push(dir);
  const templates = join(dir, 'templates');
  const proj = join(dir, 'project');
  mkdirSync(templates, { recursive: true });
  mkdirSync(join(proj, 'prompts'), { recursive: true });
  writeFileSync(join(templates, 'probe.json'), JSON.stringify({
    id: 'probe', version: 1, description: 'a probe', layer: 'project', placeholders: ['__X__'],
    body: 'GREENFIELD BODY for __X__.',
  }));
  if (withVariant) {
    writeFileSync(join(templates, 'probe.brownfield.json'), JSON.stringify({
      id: 'probe.brownfield', version: 1, description: 'a probe', layer: 'project',
      placeholders: ['__X__'], body: 'BROWNFIELD BODY for __X__.',
    }));
  }
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

/** Runs the real builder, capturing the generator prompt it actually sent. */
async function run(p: any, brownfield: boolean) {
  const prompts: string[] = [];
  let generations = 0;
  const prev = process.env.EPAM_BROWNFIELD;
  brownfield ? (process.env.EPAM_BROWNFIELD = '1') : delete process.env.EPAM_BROWNFIELD;
  try {
    await buildProjectPrompts({
      templatesDir: p.templates,
      bootstrapFile: join(p.dir, 'bootstrap.json'),
      registryFile: join(p.dir, 'registry.json'),
      projectConfigDir: p.proj,
      projectContext: 'ctx', codelineContext: 'cl', mintedRoles: '',
      runText: async (prompt: string) => {
        prompts.push(String(prompt)); generations += 1;
        return echoSegments(prompt);
      },
      log: () => {},
    });
  } finally {
    prev === undefined ? delete process.env.EPAM_BROWNFIELD : (process.env.EPAM_BROWNFIELD = prev);
  }
  return { prompts, generations };
}

let savedCl: string | undefined;
let savedBf: string | undefined;
beforeEach(() => { savedCl = process.env.EPAM_CODELINE_ID; savedBf = process.env.EPAM_BROWNFIELD; process.env.EPAM_CODELINE_ID = 'cl-a'; });
afterEach(() => {
  savedCl === undefined ? delete process.env.EPAM_CODELINE_ID : (process.env.EPAM_CODELINE_ID = savedCl);
  savedBf === undefined ? delete process.env.EPAM_BROWNFIELD : (process.env.EPAM_BROWNFIELD = savedBf);
});

describe('generation reads the variant', () => {
  it('GUARD: greenfield specialises the greenfield body', async () => {
    const p = project({ withVariant: true });
    const { prompts, generations } = await run(p, false);
    expect(generations, 'the builder generated nothing, so every assertion below is vacuous')
      .toBe(1);
    expect(prompts[0]).toContain('GREENFIELD BODY');
    expect(prompts[0], 'a greenfield run was specialised from the brownfield variant')
      .not.toContain('BROWNFIELD BODY');
  });

  it('BROWNFIELD specialises the brownfield body', async () => {
    const p = project({ withVariant: true });
    const { prompts, generations } = await run(p, true);
    expect(generations).toBe(1);
    expect(prompts[0], 'the builder read the greenfield template on a brownfield run, so the '
      + 'variant is never executed no matter what the engine resolver says')
      .toContain('BROWNFIELD BODY');
  });

  it('FALLS BACK when no variant exists, and still installs the prompt', async () => {
    const p = project({ withVariant: false });
    const { prompts, generations } = await run(p, true);
    expect(generations).toBe(1);
    expect(prompts[0]).toContain('GREENFIELD BODY');
    expect(existsSync(join(p.proj, 'prompts', 'probe.json')),
      'a brownfield run failed to install a prompt that has no variant').toBe(true);
  });

  it('THE INSTALLED PROMPT KEEPS THE BASE ID — serving is not asked to learn a new name', async () => {
    const p = project({ withVariant: true });
    await run(p, true);
    expect(existsSync(join(p.proj, 'prompts', 'probe.json')),
      'the variant installed under a different id, so prompt-library would not find it').toBe(true);
    expect(existsSync(join(p.proj, 'prompts', 'probe.brownfield.json')),
      'the variant leaked into the project layer under its variant id').toBe(false);
  });

  it('THE CACHE DOES NOT CROSS VARIANTS — brownfield after greenfield regenerates', async () => {
    const p = project({ withVariant: true });
    expect((await run(p, false)).generations).toBe(1);
    expect((await run(p, false)).generations,
      'GUARD: the cache is not working, so the next assertion proves nothing').toBe(0);
    expect((await run(p, true)).generations,
      'a brownfield run reused a prompt generated from the GREENFIELD template').toBe(1);
    expect((await run(p, false)).generations,
      'the brownfield run evicted greenfield\'s cached prompt').toBe(0);
  });
});

describe('the completion marker carries the variant', () => {
  const markerNames = (proj: string) =>
    require('node:fs').readdirSync(join(proj, '.prompt-cache'))
      .filter((n: string) => n.startsWith('.complete-'));


  function markerFor(codeline: string, brownfield: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'marker-')); dirs.push(dir);
    const proj = join(dir, 'project');
    mkdirSync(join(proj, 'prompts'), { recursive: true });
    const prev = process.env.EPAM_BROWNFIELD;
    brownfield ? (process.env.EPAM_BROWNFIELD = '1') : delete process.env.EPAM_BROWNFIELD;
    try { writeCompletionMarker({ outDir: join(proj, 'prompts'), codeline, provisioned: 1 }); }
    finally { prev === undefined ? delete process.env.EPAM_BROWNFIELD : (process.env.EPAM_BROWNFIELD = prev); }
    return markerNames(proj);
  }

  it('GREENFIELD IS BYTE-IDENTICAL TO TODAY — nothing already on disk is invalidated', () => {
    expect(markerFor('cl-a', false)).toEqual(['.complete-cl-a']);
  });

  it('BROWNFIELD WRITES A DIFFERENT MARKER, so a greenfield-complete codeline cannot skip it', () => {
    const brown = markerFor('cl-a', true);
    expect(brown, 'a brownfield run claimed the greenfield marker; the next greenfield run on '
      + 'this codeline would skip the mint and serve brownfield prompts').not.toEqual(['.complete-cl-a']);
    expect(brown).toEqual(['.complete-cl-a.brownfield']);
  });

  it('SHELL AND JS AGREE ON THE NAME — four call sites, one rule', () => {
    const lib = join(REPO_ROOT, 'orchestrations/scripts/lib/prompt-variant.sh');
    expect(existsSync(lib), 'the shell has no shared derivation, so its three call sites each '
      + 'carry their own copy of the rule').toBe(true);
    const ask = (bf: string) => spawnSync('bash', ['-c',
      `. "${lib}"; EPAM_BROWNFIELD=${bf} prompt_marker_key cl-a`], { encoding: 'utf8' });
    const green = ask(''); const brown = ask('1');
    expect(green.status, green.stderr).toBe(0);
    expect(green.stdout.trim()).toBe('.complete-cl-a');
    expect(brown.stdout.trim()).toBe('.complete-cl-a.brownfield');
    // The receiver's answer, not a guess about it: what JS writes is what shell looks for.
    expect(brown.stdout.trim()).toBe(markerFor('cl-a', true)[0]);
    expect(green.stdout.trim()).toBe(markerFor('cl-a', false)[0]);
  });
});

/**
 * THE REAL SEAM, NOT A PROBE — spec-agent-openspec, provisioned from the actual template zone.
 *
 * Everything above drives a synthetic one-template project, which proves the MECHANISM. It does
 * not prove that the mechanism reaches the one prompt this was built for. spec-agent-openspec is
 * not in a bootstrap list at all — it is provisioned because the seam registry's `spec-agent`
 * profile declares it as its template — so a variant rule that worked on a probe could still miss
 * it, and the miss would be silent: the run would simply keep paying for acceptance criteria.
 *
 * The generator is stubbed by ECHOING THE TEMPLATE BODY BACK, which is the least a generator can
 * return and still satisfy the placeholder contract. That matters: a stub returning anything else
 * dies on the first prompt (prompt-review is provisioned first) and never reaches this one, and
 * every assertion here would pass vacuously on a file that was never written.
 */
describe('the real spec seam gets its variant', () => {
  const REAL_TEMPLATES = join(REPO_ROOT, 'orchestrations/prompts/templates');
  const BOOTSTRAP = join(REPO_ROOT, 'orchestrations/prompts/bootstrap.json');
  const REGISTRY = join(REPO_ROOT, 'orchestrations/agents/invocation-profiles.json');

  async function provisionReal(brownfield: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'real-seam-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    const prev = process.env.EPAM_BROWNFIELD;
    brownfield ? (process.env.EPAM_BROWNFIELD = '1') : delete process.env.EPAM_BROWNFIELD;
    process.env.EPAM_CODELINE_ID = 'real-seam-cl';
    try {
      await buildProjectPrompts({
        templatesDir: REAL_TEMPLATES, bootstrapFile: BOOTSTRAP, registryFile: REGISTRY,
        projectConfigDir: dir,
        projectContext: 'ctx', codelineContext: 'cl', mintedRoles: '',
        runText: async (p: string) => {
          return echoSegments(p);
        },
        log: () => {},
      }).catch(() => { /* a later prompt may refuse the echo stub; this one is what matters */ });
    } finally {
      prev === undefined ? delete process.env.EPAM_BROWNFIELD : (process.env.EPAM_BROWNFIELD = prev);
    }
    const f = join(dir, 'prompts', 'spec-agent-openspec.json');
    if (!existsSync(f)) return null;
    const doc = JSON.parse(readFileSync(f, 'utf8'));
    return { doc, body: doc.body || Object.values(doc.bodies || {}).join('\n') };
  }

  it('GREENFIELD still asks for acceptance criteria', async () => {
    const r = await provisionReal(false);
    expect(r, 'spec-agent-openspec was not provisioned at all — every assertion here is vacuous')
      .not.toBeNull();
    expect(r!.body).toContain('"acceptanceCriteria"');
    expect(r!.body).not.toContain('Do NOT produce acceptance criteria');
    expect(r!.doc.id).toBe('spec-agent-openspec');
  });

  it('BROWNFIELD stops asking, under the SAME filename serving looks for', async () => {
    const r = await provisionReal(true);
    expect(r, 'the brownfield run installed no spec-agent-openspec.json, so prompt-library would '
      + 'serve nothing for the spec seam').not.toBeNull();
    expect(r!.body, 'the project-layer spec prompt still asks for ACs on a brownfield run — the '
      + 'variant never reached the seam it was written for').not.toContain('"acceptanceCriteria"');
    expect(r!.body).toContain('Do NOT produce acceptance criteria');
  });

  it('THE PROVENANCE NAMES THE VARIANT, so which prompt ran is auditable', async () => {
    const r = await provisionReal(true);
    expect(r).not.toBeNull();
    // Nothing routes on doc.id (prompt-library uses it only in error text), so recording the
    // variant here is honest provenance rather than a second name for the same seam.
    expect(r!.doc.id).toBe('spec-agent-openspec.brownfield');
  });
});
