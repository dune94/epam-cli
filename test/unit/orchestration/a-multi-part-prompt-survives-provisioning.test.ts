/**
 * A PROMPT MADE OF NAMED PARTS MUST STILL HAVE THEM AFTER PROVISIONING.
 *
 * Live 2026-09-04, pipeline-tests-19:
 *
 *   spec-mode: ticket-link review skipped for AMSD-1919 (prompt 'spec-story-block' is missing
 *   values for: __COMMENT_BLOCK__, __COMPONENTS__, __DECLARED_FILES__, __DESCRIPTION__,
 *   __LINK_BLOCK__, __PERSONA__, __RETRIEVED_DOCS__, __TITLE__)
 *
 * The ticket-link review had already fetched 4 of 4 linked documents. It was then skipped, and the
 * documentation never reached the run.
 *
 * WHY, exactly. spec-story-block declares TWO bodies — `block` and `retrieved_docs` — and its two
 * consumers each render one by name. The provisioning path flattens them:
 *
 *     templateBodyText():  Object.values(bodies).join('\n')      <- both parts, one string
 *     buildGeneratedDoc(): { body }                              <- no `bodies` key at all
 *
 * so the installed project copy is ONE body carrying the union of all nine placeholders. The
 * inner call renders `retrieved_docs` and supplies its single value, __DOC_PATHS__; the merged
 * document declares eight more; render refuses; the caller skips the review.
 *
 * THIS IS A CLASS, NOT A CASE. 18 seam-declared templates carry multiple bodies — story-writer,
 * spec-agent, the failure analyst, the repro-test writer, the QA gates. For every one of them a
 * consumer asking for a named part receives the CONCATENATION of every part. Where the values
 * happen to cover the union, that is not an error at all: it is an agent silently executing three
 * prompts glued together. spec-story-block is simply the one whose values did not cover it, so it
 * left a log line.
 *
 * THE CONTRACT: whatever provisioning does to a multi-part template, the installed copy must still
 * answer for each part separately, with that part's own placeholders. Nothing here says HOW —
 * copied verbatim or generated per part both satisfy it.
 *
 * DERIVED, NEVER LISTED: the templates are discovered from the template directory and the seam
 * registry, so one added tomorrow is covered tomorrow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const TEMPLATES = join(REPO, 'orchestrations/prompts/templates');
const CONTRACT = join(REPO, 'orchestrations/scripts/lib/project-prompt-contract.js');
const LIBRARY = join(REPO, 'orchestrations/scripts/lib/prompt-library.js');

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/** Templates carrying more than one named body. */
function multiPartTemplates(): Array<{ id: string; parts: string[]; doc: any }> {
  return readdirSync(TEMPLATES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(TEMPLATES, f)))
    .filter((d) => d && d.bodies && typeof d.bodies === 'object')
    .map((d) => ({
      id: d.id,
      parts: Object.entries(d.bodies).filter(([, v]) => typeof v === 'string').map(([k]) => k),
      doc: d,
    }))
    .filter((t) => t.parts.length > 1);
}

const MULTI = multiPartTemplates();
/** The ones a seam runs, i.e. the ones that get a generated project copy. */
const MULTI_SEAM = MULTI.filter((t) => Array.isArray(t.doc.seams) && t.doc.seams.length);

describe('the shape of the defect is real', () => {
  it('there are multi-part templates, and seams run them', () => {
    expect(MULTI.length, 'no multi-body templates found — this test has drifted').toBeGreaterThan(5);
    expect(MULTI_SEAM.length,
      'no multi-body template is seam-declared, so none would be generated — the defect described '
      + 'here would not exist').toBeGreaterThan(5);
  });
});

/**
 * PROVISION FOR REAL, ONCE, and let every case below read the files that were actually written.
 *
 * buildProjectPrompts is the function the mint calls. It is driven with a `generate` bootstrap
 * asking for every multi-part template, and a runText that RECORDS being called — because a
 * multi-part template must not be sent to a model at all: its parts cannot survive the round trip.
 */
const provisioned = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'provision-multipart-'));
  const cfg = join(dir, 'project');
  mkdirSync(cfg, { recursive: true });

  // AN ISOLATED TEMPLATE DIRECTORY holding only the templates under test, each marked
  // project-layer so it is provisioned without dragging in the whole seam registry. The BODIES
  // are copied unchanged — they are the thing being asserted about.
  const templates = join(dir, 'templates');
  mkdirSync(templates, { recursive: true });
  for (const t of MULTI_SEAM) {
    writeFileSync(join(templates, `${t.id}.json`), JSON.stringify({ ...t.doc, layer: 'project' }, null, 2));
  }

  const bootstrapFile = join(dir, 'bootstrap.json');
  writeFileSync(bootstrapFile, JSON.stringify({
    copyVerbatim: [], generated: MULTI_SEAM.map((t) => t.id),
  }));

  const generatedIds: string[] = [];
  const { buildProjectPrompts } = require(join(REPO, 'orchestrations/scripts/lib/project-prompt-builder.js'));

  const result = buildProjectPrompts({
    templatesDir: templates,
    projectConfigDir: cfg,
    bootstrapFile,
    mode: 'generate',
    projectContext: 'a project', codelineContext: 'a codeline', mintedRoles: 'roles',
    log: (m: string) => {
      const g = /generated ([a-z0-9-]+) \(attempt/i.exec(String(m));
      if (g) generatedIds.push(g[1]);
    },
    // Reaching a model at all is the failure: a multi-part template's parts cannot survive the
    // round trip, so none of these may be generated.
    runText: async () => '(a model wrote this)',
  });
  return { dir, cfg, generatedIds, result };
})();

describe('provisioning preserves the parts', () => {
  it('no multi-part template is sent to a model — its parts cannot survive the round trip', async () => {
    await provisioned.result;
    const multiIds = new Set(MULTI_SEAM.map((x) => x.id));
    expect(provisioned.generatedIds.filter((g) => multiIds.has(g)), [
      'these multi-part templates were generated. templateBodyText joins their named bodies into',
      'one string and buildGeneratedDoc writes a single `body`, so the installed copy has no parts',
      'and declares the union of every part\'s placeholders.',
    ].join('\n')).toEqual([]);
  });

  it.each(MULTI_SEAM.map((t) => ({ id: t.id, parts: t.parts })))(
    '$id keeps its parts on disk', async ({ id, parts }) => {
      await provisioned.result;
      const file = join(provisioned.cfg, 'prompts', `${id}.json`);
      expect(existsSync(file), `'${id}' was not provisioned at all`).toBe(true);
      const installed = readJson(file);

      expect(installed.bodies, [
        `The installed copy of '${id}' has no \`bodies\`, so its ${parts.length} parts`,
        `(${parts.join(', ')}) were flattened into one string. Every consumer that asks for a part`,
        'by name now receives the concatenation of all of them — an agent executing several',
        'prompts glued together — or, where the supplied values do not cover the union, the render',
        'failure that skipped the ticket-link review on 2026-09-04.',
      ].join('\n')).toBeTruthy();

      expect(Object.keys(installed.bodies ?? {}).sort(),
        `'${id}' lost or renamed parts during provisioning`).toEqual([...parts].sort());
    });
});

describe('and each part is renderable ON ITS OWN, with only its own values', () => {
  const lib = require(LIBRARY);
  const { buildGeneratedDoc } = require(CONTRACT);
  const { placeholdersIn } = require(CONTRACT);

  // One case per PART, because the defect is per-part: the whole document renders fine.
  const cases = MULTI_SEAM.flatMap((t) =>
    t.parts.map((part) => ({ id: t.id, part, doc: t.doc })));

  it('there are parts to render', () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  it.each(cases)('$id :: $part', async ({ id, part, doc }) => {
    await provisioned.result;
    {
      // The document the mint actually installed — not one this test built.
      const dir = provisioned.cfg;

      // Exactly what this part declares — nothing from its siblings. That is what a consumer
      // supplies, and supplying a sibling's value is itself an error the renderer reports.
      const needed = placeholdersIn(String(doc.bodies[part]));
      const values: Record<string, string> = {};
      for (const p of needed) values[p] = `value-for-${p}`;

      const out = lib.buildPrompt(id, dir, values, { part });

      expect(out, `rendering '${id}' part '${part}' produced nothing`).toBeTruthy();

      // GUARD AGAINST A VACUOUS PASS. A flattened document stringifies to "[object Object]" —
      // fifteen characters, no placeholders, and every `not.toContain` below passes while proving
      // nothing. So require the output to actually carry THIS part's own prose: the longest
      // placeholder-free line of the part body must appear in what was rendered.
      // Literal text of THIS part that rendering leaves byte-identical: the longest fragment
      // between placeholders. (Stripping placeholders out of a line does not work — rendering
      // SUBSTITUTES them, so the stripped text never appears contiguously in the output.)
      const literals = String(doc.bodies[part])
        .split(/__[A-Z0-9_]+__/)
        .map((s: string) => s.replace(/\s+/g, ' ').trim())
        .filter((s: string) => s.length >= 12)
        .sort((a: string, b: string) => b.length - a.length);

      const normalised = out.replace(/\s+/g, ' ');
      if (literals.length) {
        expect(normalised, [
          `what was rendered does not contain this part's own text, so nothing proves the part`,
          'was rendered at all. A flattened document stringifies to "[object Object]" and would',
          'pass every negative assertion below.',
          `expected to find: ${literals[0].slice(0, 80)}`,
        ].join('\n')).toContain(literals[0].slice(0, 40));
      } else {
        // A part that is almost entirely placeholder has no literal to anchor on. Its own
        // substituted value proves it rendered just as well.
        expect(needed.length,
          `part '${part}' of '${id}' has neither literal text nor placeholders — nothing to assert`)
          .toBeGreaterThan(0);
        expect(normalised, `part '${part}' of '${id}' rendered without its own value`)
          .toContain(`value-for-${needed[0]}`);
      }

      // THE NEGATIVE ASSERTION, which is the one that catches over-inclusion. A flattened
      // document renders every part at once, and a presence check alone would pass on it.
      for (const sibling of Object.keys(doc.bodies).filter((k) => k !== part)) {
        const siblingOnly = placeholdersIn(String(doc.bodies[sibling]))
          .filter((p: string) => !needed.includes(p));
        for (const p of siblingOnly) {
          expect(out, [
            `rendering part '${part}' of '${id}' emitted '${p}', which belongs to part`,
            `'${sibling}'. The parts were merged, so the agent is handed several prompts at once.`,
          ].join('\n')).not.toContain(p);
        }
      }
    }
  });
});
