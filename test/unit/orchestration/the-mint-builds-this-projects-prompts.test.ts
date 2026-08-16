/**
 * THE MINT BUILDS THIS PROJECT'S PROMPTS.
 *
 * Operator design, 2026-08-15: "the same agent who mints should also build prompts".
 *
 * Before this, nothing generated project prompts at all. prompt-library.js renders ONLY the
 * project-authority copy and refuses to fall back to a template, so a project without them
 * cannot run — yet the only way to get them was to author them by hand. That is why the
 * repo had exactly seven, all for one project, and a new project had none.
 *
 * The mint is the right owner because it is the stage that already knows what this project
 * is and which roles will work on it — the two things a specialised prompt needs.
 *
 * WHAT MUST NOT HAPPEN. A generated prompt that drops, renames or invents one placeholder
 * does not degrade: prompt-library throws at whichever seam needed it, mid-run, after the
 * roster is minted and the run is spending. So a prompt that fails its contract is NEVER
 * installed, and the builder fails loudly rather than leaving the project half-provisioned
 * or quietly falling back to the generic template — running the template is forbidden, and a
 * silent degrade is how an engine default runs a whole campaign unnoticed.
 *
 * The model is injected, so these tests exercise the real installation logic without cost.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const BUILDER = join(ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js');

/** A miniature template zone — the real one is the engine's, not this test's business. */
function makeZone() {
  const dir = mkdtempSync(join(tmpdir(), 'ppb-'));
  const templates = join(dir, 'templates');
  const projectDir = join(dir, 'proj');
  mkdirSync(templates, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const tpl = (id: string, body: string) =>
    writeFileSync(join(templates, `${id}.json`), JSON.stringify({
      id, body, description: `${id} desc`,
      placeholders: [...new Set(body.match(/__[A-Z][A-Z0-9_]*__/g) || [])].sort(),
      version: 1,
    }, null, 2));

  tpl('boot-one', 'Bootstrap body with __ALPHA__.');
  // The generator is bootstrap-copied and then USED to build the rest — that is the design,
  // so the fixture must model it rather than a convenient simplification.
  tpl('project-prompt-generation',
    'Specialise __TEMPLATE_ID__ (__TEMPLATE_DESCRIPTION__), placeholders __TEMPLATE_PLACEHOLDERS__:\n'
    + '__TEMPLATE_BODY__\nProject: __PROJECT_CONTEXT__\nCodelines: __CODELINE_CONTEXT__\nRoles: __MINTED_ROLES__');
  tpl('gen-one', 'Generic one: do __ALPHA__ then __BETA__.');
  tpl('gen-two', 'Generic two: consider __GAMMA__.');

  writeFileSync(join(dir, 'bootstrap.json'), JSON.stringify({
    copyVerbatim: ['boot-one', 'project-prompt-generation'],
    why: { 'boot-one': 'cannot generate itself', 'project-prompt-generation': 'cannot be its own output' },
    generated: ['gen-one', 'gen-two'],
  }, null, 2));

  return { dir, templates, projectDir, bootstrapFile: join(dir, 'bootstrap.json') };
}

const CONTEXT = {
  projectContext: 'A demo project.',
  codelineContext: '- one (deps: x)',
  mintedRoles: '- alpha-engineer: owns things',
};

function build(zone: ReturnType<typeof makeZone>, runText: any, opts: any = {}) {
  delete require.cache[require.resolve(BUILDER)];
  const { buildProjectPrompts } = require(BUILDER);
  return buildProjectPrompts({
    templatesDir: zone.templates,
    bootstrapFile: zone.bootstrapFile,
    projectConfigDir: zone.projectDir,
    runText,
    ...CONTEXT,
    ...opts,
  });
}

/**
 * A well-behaved generator: it specialises the prose and reproduces exactly the placeholders
 * the template declared. The prompt states them, so the stub reads them from the prompt
 * rather than a table here — a hardcoded per-template map would drift from the fixture.
 */
const okStub = async (prompt: string) => {
  const m = /placeholders ([^:]*):/.exec(prompt);
  const ph = (m ? m[1] : '').split(',').map((x) => x.trim()).filter(Boolean).join(' ');
  return `Specialised for this project: ${ph}`;
};

const promptsOf = (zone: ReturnType<typeof makeZone>) => {
  const d = join(zone.projectDir, 'prompts');
  return existsSync(d) ? readdirSync(d).sort() : [];
};
const readPrompt = (zone: ReturnType<typeof makeZone>, id: string) =>
  JSON.parse(readFileSync(join(zone.projectDir, 'prompts', `${id}.json`), 'utf8'));

describe('the builder provisions every declared prompt', () => {
  it('installs the bootstrap prompt VERBATIM — the TEXT, with its origin recorded', async () => {
    // Copied, not generated: it is the prompt the generating agent itself needs.
    //
    // The prompt TEXT is byte-identical; the FILE is not, and asserting byte-identity made this
    // test contradict the-mint-step-provisions-prompts.test.ts, which asserts the opposite. Two
    // tests answering one question differently is how a rule gets decided by whichever ran last.
    // A project copy records which template it came from, because without that a later template
    // edit is invisible: the project keeps running the older prompt while the template claims
    // otherwise. Identity is also carried forward — id and seams — so the chain from template to
    // project prompt to seam survives provisioning.
    const zone = makeZone();
    try {
      await build(zone, okStub);
      const tpl = JSON.parse(readFileSync(join(zone.templates, 'boot-one.json'), 'utf8'));
      const installed = JSON.parse(readFileSync(join(zone.projectDir, 'prompts', 'boot-one.json'), 'utf8'));
      expect(installed.body ?? installed.bodies, 'the prompt text was altered by copying')
        .toEqual(tpl.body ?? tpl.bodies);
      expect(installed.id, 'the copy lost the id that maps it back to its template').toBe(tpl.id);
      expect(installed.seams, 'the copy lost the seams it serves').toEqual(tpl.seams);
      expect(installed.derivedFromSha256, 'the copy records no origin').toBeTruthy();
      expect(installed.authority, 'the copy is not marked project authority').toBe('project');
    } finally { rmSync(zone.dir, { recursive: true, force: true }); }
  });

  it('generates the rest and installs them as project authority', async () => {
    const zone = makeZone();
    try {
      const seen: string[] = [];
      await build(zone, async (prompt: string) => { seen.push(prompt); return okStub(prompt); });
      expect(promptsOf(zone)).toEqual(['boot-one.json', 'gen-one.json', 'gen-two.json', 'project-prompt-generation.json']);
      const one = readPrompt(zone, 'gen-one');
      expect(one.authority).toBe('project');
      expect(one.body).toContain('Specialised for this project');
      expect(one.placeholders).toEqual(['__ALPHA__', '__BETA__']);
      expect(one.derivedFromSha256, 'no provenance recorded').toBeTruthy();
      expect(seen.length, 'the model was not asked for each generated prompt').toBe(2);
    } finally { rmSync(zone.dir, { recursive: true, force: true }); }
  });

  it('hands the generator the template body and the project context', async () => {
    // A generator given no context cannot specialise anything, and would return the generic
    // text back — provisioning that is indistinguishable from having done the work.
    const zone = makeZone();
    try {
      let first = '';
      await build(zone, async (p: string) => { if (!first) first = p; return okStub(p); });
      expect(first).toContain('Generic one: do __ALPHA__ then __BETA__.');
      expect(first).toContain(CONTEXT.projectContext);
      expect(first).toContain(CONTEXT.mintedRoles);
      expect(first).toContain(CONTEXT.codelineContext);
    } finally { rmSync(zone.dir, { recursive: true, force: true }); }
  });
});

describe('a prompt that breaks its contract is never installed', () => {
  it('FAILS LOUDLY when the model drops a placeholder, naming it', async () => {
    const zone = makeZone();
    try {
      await expect(build(zone, async () => 'Specialised but lost one: do __ALPHA__.', { attempts: 1 }))
        .rejects.toThrow(/__BETA__/);
    } finally { rmSync(zone.dir, { recursive: true, force: true }); }
  });

  it('does not leave the broken prompt on disk', async () => {
    // Half-provisioned is worse than unprovisioned: the run starts and dies at the seam.
    const zone = makeZone();
    try {
      await build(zone, async () => 'Lost one: do __ALPHA__.', { attempts: 1 }).catch(() => {});
      expect(promptsOf(zone)).not.toContain('gen-one.json');
    } finally { rmSync(zone.dir, { recursive: true, force: true }); }
  });

  it('NEVER falls back to the generic template', async () => {
    // Running the template is forbidden outright; a fallback would look like success.
    const zone = makeZone();
    try {
      try { build(zone, async () => 'Lost one: do __ALPHA__.', { attempts: 1 }); } catch { /* expected */ }
      const p = join(zone.projectDir, 'prompts', 'gen-one.json');
      if (existsSync(p)) {
        expect(JSON.parse(readFileSync(p, 'utf8')).body).not.toBe('Generic one: do __ALPHA__ then __BETA__.');
      }
    } finally { rmSync(zone.dir, { recursive: true, force: true }); }
  });

  it('retries a failed generation before giving up, and succeeds if a later attempt is valid', async () => {
    const zone = makeZone();
    try {
      let n = 0;
      await build(zone, async (p: string) => {
        n += 1;
        return n === 1 ? 'Broken: do __ALPHA__.' : `Fixed. ${await okStub(p)}`;
      }, { attempts: 3 });
      expect(n).toBeGreaterThan(1);
      expect(readPrompt(zone, 'gen-one').body).toContain('Fixed');
    } finally { rmSync(zone.dir, { recursive: true, force: true }); }
  });

  it('tells the retry WHY the last attempt was refused', async () => {
    // A retry that repeats the same instruction gets the same answer; the refusal reason is
    // the only new information available to it.
    const zone = makeZone();
    try {
      const prompts: string[] = [];
      await build(zone, async (p: string) => {
        prompts.push(p);
        return prompts.length === 1 ? 'Broken: do __ALPHA__.' : `Fixed. ${await okStub(p)}`;
      }, { attempts: 3 });
      expect(prompts[1], 'the retry was not told what was wrong').toMatch(/__BETA__/);
    } finally { rmSync(zone.dir, { recursive: true, force: true }); }
  });
});

describe('the builder writes only where it should', () => {
  it('creates nothing outside the project prompts directory', async () => {
    const zone = makeZone();
    try {
      const before = readdirSync(zone.templates).sort();
      await build(zone, okStub);
      expect(readdirSync(zone.templates).sort(), 'the builder mutated the template zone').toEqual(before);
      expect(readdirSync(zone.projectDir).sort()).toEqual(['prompts']);
    } finally { rmSync(zone.dir, { recursive: true, force: true }); }
  });

  it('refuses a bootstrap entry with no template rather than provisioning a partial set', async () => {
    const zone = makeZone();
    try {
      writeFileSync(zone.bootstrapFile, JSON.stringify({
        copyVerbatim: ['boot-one', 'does-not-exist'], why: {}, generated: [],
      }));
      await expect(build(zone, async () => 'x')).rejects.toThrow(/does-not-exist/);
    } finally { rmSync(zone.dir, { recursive: true, force: true }); }
  });
});
