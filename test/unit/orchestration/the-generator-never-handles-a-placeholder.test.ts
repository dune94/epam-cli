/**
 * THE GENERATOR NEVER HANDLES A PLACEHOLDER.
 *
 * prompt-builder asked the model to rewrite a whole template into a project-specific version while
 * transcribing every __SLOT__ token character-for-character. That is a writing task and a copying
 * task at once, and models lose literals while rewriting prose around them. Live 2026-09-08,
 * pipeline-tests-44: 25 refusals, every one of them the same reason —
 *
 *   "the generated prompt dropped placeholder(s) the template requires: __CONFIG_SURFACE__,
 *    __PROJECT_ROOT__, __REVIEW_PROFILE__, __STORY_DIFF__, __STORY_ID__, __STORY_TITLE__.
 *    The evidence they carry would silently never reach the agent."
 *
 * runtime-boundary-review lost all six, five attempts running, and the run aborted at 37 of 39
 * prompts having already spent $22.29. Each refusal is a paid call, and the ladder's remedy is to
 * escalate the MODEL — which cannot fix copy fidelity; a stronger model rewrites more fluently.
 *
 * THE SLOTS ARE DELIMITERS, SO USE THEM AS DELIMITERS. Split the template body on its placeholders
 * and the model only ever sees, and only ever returns, the prose BETWEEN them. Reassembly puts the
 * original slots back in their original positions and order. The model cannot drop a placeholder
 * it was never given, nor invent one it cannot type — so all four contract invariants
 * (nothing dropped, nothing invented, declared == used, body non-empty) hold BY CONSTRUCTION
 * rather than by inspection-and-retry.
 *
 * It also shrinks output: the model stops re-emitting the slots and the structure around them on
 * all 39 prompts, and output is the token class that costs 5x input and returns as input on every
 * later turn of an agent loop.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = join(__dirname, '../../../');
const CONTRACT = join(ROOT, 'orchestrations/scripts/lib/project-prompt-contract.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const c = require(CONTRACT);
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');

describe('placeholders are delimiters, never payload', () => {
  it('EXPOSES a split that separates prose from slots', () => {
    expect(typeof c.splitByPlaceholders,
      'no way to separate a template into prose segments and slots, so the model must keep being '
      + 'asked to transcribe the slots').toBe('function');
    const { segments, slots } = c.splitByPlaceholders('Hello __A__ world __B__ end');
    expect(slots).toEqual(['__A__', '__B__']);
    expect(segments).toEqual(['Hello ', ' world ', ' end']);
  });

  it('ROUND-TRIPS EXACTLY — assembling the untouched segments rebuilds the original', () => {
    const body = 'Do __X__ then __Y__ and __X__ again.';
    const { segments, slots } = c.splitByPlaceholders(body);
    expect(c.assembleFromSegments(segments, slots),
      'split then assemble is not lossless, so assembly cannot be trusted to rebuild a prompt')
      .toBe(body);
  });

  it('A REPEATED SLOT KEEPS EVERY OCCURRENCE — order and count preserved', () => {
    const { segments, slots } = c.splitByPlaceholders('__P__ a __P__ b __P__');
    expect(slots).toEqual(['__P__', '__P__', '__P__']);
    expect(c.assembleFromSegments(segments, slots)).toBe('__P__ a __P__ b __P__');
  });

  it('SPECIALISED SEGMENTS CANNOT LOSE A SLOT — the whole point', () => {
    const body = 'Review __STORY_ID__ in __PROJECT_ROOT__ carefully.';
    const { segments, slots } = c.splitByPlaceholders(body);
    // The model rewrites prose only. Even a model that mangles its segments cannot touch a slot.
    const specialised = segments.map(() => ' TOTALLY REWRITTEN PROSE ');
    const rebuilt = c.assembleFromSegments(specialised, slots);
    for (const s of slots) {
      expect(rebuilt, `${s} was lost despite the model never being given it`).toContain(s);
    }
  });

  it('THE REBUILT BODY PASSES THE EXISTING CONTRACT — for every real template', () => {
    const files = readdirSync(TEMPLATES).filter((f) => f.endsWith('.json'));
    expect(files.length, 'no templates found').toBeGreaterThan(10);
    let checked = 0;
    for (const f of files) {
      const t = JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8'));
      const body = t.body || Object.values(t.bodies || {}).join('\n');
      if (!body || !Array.isArray(t.placeholders) || !t.placeholders.length) continue;
      const { segments, slots } = c.splitByPlaceholders(body);
      // A model that returns segments of the right count, however it words them.
      const rebuilt = c.assembleFromSegments(segments.map((s: string) => s), slots);
      const verdict = c.checkGeneratedPrompt(t, { body: rebuilt, placeholders: c.placeholdersIn(rebuilt) });
      expect(verdict.ok, `${t.id}: assembled body fails the contract — ${verdict.reason}`).toBe(true);
      checked += 1;
    }
    expect(checked, 'no template exercised the round-trip').toBeGreaterThan(10);
  });

  it('A WRONG SEGMENT COUNT IS REFUSED, not silently padded', () => {
    const { slots } = c.splitByPlaceholders('a __X__ b');
    expect(() => c.assembleFromSegments(['only-one'], slots),
      'a model returning the wrong number of segments would be assembled into a malformed prompt')
      .toThrow();
  });
});

/**
 * THE SEAM, DRIVEN FOR REAL. The functions above are the mechanism; this is buildProjectPrompts
 * actually using it, because a mechanism nothing calls fixes nothing.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProjectPrompts } = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js'));
const dirs2: string[] = [];
afterEach(() => { for (const d of dirs2.splice(0)) rmSync(d, { recursive: true, force: true }); });

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'seg-')); dirs2.push(dir);
  const templates = join(dir, 'templates');
  const proj = join(dir, 'project');
  mkdirSync(templates, { recursive: true });
  mkdirSync(join(proj, 'prompts'), { recursive: true });
  writeFileSync(join(templates, 'probe.json'), JSON.stringify({
    id: 'probe', version: 1, description: 'a probe', layer: 'project',
    placeholders: ['__STORY_ID__', '__PROJECT_ROOT__'],
    body: 'Review __STORY_ID__ inside __PROJECT_ROOT__ thoroughly.',
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

describe('the builder assembles, the model does not', () => {
  it('A MODEL THAT NEVER EMITS A SLOT STILL PRODUCES A VALID PROMPT', async () => {
    const p = project();
    let sawSlotInPrompt = false;
    await buildProjectPrompts({
      templatesDir: p.templates,
      bootstrapFile: join(p.dir, 'bootstrap.json'),
      registryFile: join(p.dir, 'registry.json'),
      projectConfigDir: p.proj,
      projectContext: 'ctx', codelineContext: 'cl', mintedRoles: '',
      runText: async (prompt: string) => {
        // The generator is asked for prose only; it must not be handed raw slots to transcribe.
        if (/__STORY_ID__|__PROJECT_ROOT__/.test(String(prompt))) sawSlotInPrompt = true;
        return ['Inspect ', ' within ', ' with care for THIS project.']
          .map((x, i) => `--- SEGMENT ${i + 1} ---\n${x}`).join('\n') + '\n--- END SEGMENTS ---';
      },
      log: () => {},
    });
    const out = join(p.proj, 'prompts', 'probe.json');
    expect(existsSync(out), 'no prompt was installed').toBe(true);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    expect(doc.body, 'the assembled prompt lost a placeholder').toContain('__STORY_ID__');
    expect(doc.body).toContain('__PROJECT_ROOT__');
    expect(doc.body, 'the specialised prose did not survive assembly').toContain('with care for THIS project');
    expect(sawSlotInPrompt,
      'the generator was still shown raw placeholders to transcribe — the defect is unchanged')
      .toBe(false);
  });

  it('THE 25-REFUSAL CASE CANNOT RECUR — prose that omits every slot still installs', async () => {
    const p = project();
    await buildProjectPrompts({
      templatesDir: p.templates,
      bootstrapFile: join(p.dir, 'bootstrap.json'),
      registryFile: join(p.dir, 'registry.json'),
      projectConfigDir: p.proj,
      projectContext: 'ctx', codelineContext: 'cl', mintedRoles: '',
      // Exactly the behaviour that produced 25 refusals: prose, no slots anywhere.
      runText: async () => ['A ', ' B ', ' C']
        .map((x, i) => `--- SEGMENT ${i + 1} ---\n${x}`).join('\n') + '\n--- END SEGMENTS ---',
      log: () => {},
    });
    const doc = JSON.parse(readFileSync(join(p.proj, 'prompts', 'probe.json'), 'utf8'));
    for (const s of ['__STORY_ID__', '__PROJECT_ROOT__']) {
      expect(doc.body, `${s} missing — the failure this change exists to remove`).toContain(s);
    }
  });
});
