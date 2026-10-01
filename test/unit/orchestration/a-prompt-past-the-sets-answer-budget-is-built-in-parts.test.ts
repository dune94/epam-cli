/**
 * A PROMPT PAST THE SET'S ANSWER BUDGET IS BUILT IN PARTS.
 *
 * Measured 2026-09-30: a CodeMie web assistant's turn is cut at a fixed output budget and the cut
 * answer is reported as a success. The prompt builder asks for a template's segments in ONE turn,
 * so a template longer than the budget comes back short — failure-analyst "expected 13 segment(s),
 * got 12", five attempts, the mint refused (brownfield £0 under the measured limits, 2026-10-01).
 *
 * A set declares its per-turn answer budget (its runner's `limits`); the builder asks for the
 * segments in groups that fit and assembles them. A set that declares none is built exactly as
 * before — one call per template.
 *
 * EXECUTED: the real buildProjectPrompts on the real templates that exceed the declared budget,
 * with a stand-in model that answers from what it is shown (each segment back, under its marker)
 * and is cut where the platform cuts.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';

const REPO = join(__dirname, '../../../');
const CONFIG = join(REPO, 'orchestrations/config');
const TEMPLATES = join(REPO, 'orchestrations/prompts/templates');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const contract = require(join(REPO, 'orchestrations/scripts/lib/project-prompt-contract.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const builder = require(join(REPO, 'orchestrations/scripts/lib/project-prompt-builder.js'));
const sets = JSON.parse(readFileSync(join(CONFIG, 'provider-sets.json'), 'utf8')).sets as Record<string, { settingsFile: string }>;
const limitsOf = (set: string) => Object.values<any>(JSON.parse(readFileSync(join(CONFIG, sets[set].settingsFile), 'utf8')).runners || {})
  .map((r) => r.limits).find(Boolean);
const BUDGETED = Object.keys(sets).find((s) => limitsOf(s)) as string;
const UNBUDGETED = Object.keys(sets).find((s) => !limitsOf(s)) as string;
const L = BUDGETED ? limitsOf(BUDGETED) : null;
const budgetChars = L ? Math.floor(L.visibleTokensObservedMin * L.charsPerTokenObserved) : 0;

/** Real single-body, seam-run templates whose segments together exceed the budget. */
const over = readdirSync(TEMPLATES).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8')))
  .filter((t) => typeof t.body === 'string' && Array.isArray(t.seams) && t.seams.length)
  .filter((t) => budgetChars && contract.splitByPlaceholders(builder.templateBodyText(t)).segments.join('').length > budgetChars);

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A model that answers from its input — every segment it is shown, back under its marker — and is cut where the platform cuts. */
const platformModel = (cut: number, calls: { len: number }[]) => async (prompt: string) => {
  const shown: string[] = [];
  const re = /^--- SEGMENT (\d+) ---\n([\s\S]*?)(?=^--- (?:SEGMENT \d+|END SEGMENTS) ---$)/gm;
  let m; while ((m = re.exec(prompt))) shown.push(m[2].replace(/\n$/, ''));
  const reply = contract.formatSegments(shown);
  calls.push({ len: reply.length });
  return cut ? reply.slice(0, cut) : reply;
};

async function provision(set: string, ids: string[], cut: number) {
  const dir = mkdtempSync(join(tmpdir(), 'budget-parts-')); dirs.push(dir);
  const cfg = join(dir, 'project'); mkdirSync(cfg, { recursive: true });
  const templates = join(dir, 'templates'); mkdirSync(templates, { recursive: true });
  for (const t of over.filter((x) => ids.includes(x.id))) writeFileSync(join(templates, `${t.id}.json`), JSON.stringify({ ...t, layer: 'project' }, null, 2));
  // The generator prompt itself is installed verbatim, as the real bootstrap declares it.
  const gen = builder.PROJECT_PROMPT_GENERATOR_ID;
  writeFileSync(join(templates, `${gen}.json`), readFileSync(join(TEMPLATES, `${gen}.json`), 'utf8'));
  const bootstrapFile = join(dir, 'bootstrap.json');
  writeFileSync(bootstrapFile, JSON.stringify({ copyVerbatim: [gen], generated: ids }));
  const calls: { len: number }[] = []; const generated: string[] = [];
  const prev = process.env.EPAM_PROVIDER_SET; process.env.EPAM_PROVIDER_SET = set;
  try {
    await builder.buildProjectPrompts({
      templatesDir: templates, projectConfigDir: cfg, bootstrapFile, mode: 'generate',
      projectContext: 'a project', codelineContext: 'a codeline', mintedRoles: 'roles', attempts: 2,
      log: (msg: string) => { const g = /generated ([a-z0-9-]+) \(attempt/i.exec(String(msg)); if (g) generated.push(g[1]); },
      runText: platformModel(cut, calls),
    }).catch(() => { /* a refusal is asserted below, by what was installed */ });
  } finally { if (prev === undefined) delete process.env.EPAM_PROVIDER_SET; else process.env.EPAM_PROVIDER_SET = prev; }
  const installed = (id: string) => { try { return JSON.parse(readFileSync(join(cfg, 'prompts', `${id}.json`), 'utf8')); } catch { return null; } };
  return { calls, generated, installed };
}

describe('a prompt past the set\'s answer budget is built in parts', () => {
  it('the shape is real: a set declares a budget, and real templates exceed it', () => {
    expect(BUDGETED, 'no provider set declares an answer budget').toBeTruthy();
    expect(over.length, 'no template exceeds the declared budget — this proves nothing').toBeGreaterThan(0);
  });

  it('on the budgeted set, every over-budget template is built — whole, every segment in place', async () => {
    const ids = over.map((t) => t.id);
    const r = await provision(BUDGETED, ids, budgetChars);
    for (const t of over) {
      const doc = r.installed(t.id);
      expect(doc, `${t.id} was not built: its answer was cut at the budget`).toBeTruthy();
      expect(builder.templateBodyText(doc), `${t.id} was not assembled from all its parts`).toBe(builder.templateBodyText(t));
    }
    expect(r.calls.every((c) => c.len <= budgetChars), 'a call asked for more than one turn can answer').toBe(true);
  });

  it('a set with no declared budget builds a template in one call, as before', async () => {
    expect(UNBUDGETED, 'every set declares a budget — nothing to compare').toBeTruthy();
    const one = over[0];
    const r = await provision(UNBUDGETED, [one.id], 0);
    expect(r.installed(one.id)).toBeTruthy();
    expect(r.calls.length, 'an unbudgeted set was split into parts').toBe(1);
  });
});
