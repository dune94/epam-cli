/**
 * THE ROSTER SEAMS ARE GIVEN CONTENT, NOT INSTALL PATHS.
 *
 * Operator, 2026-10-01: "hard coded local paths are not generated into prompts or SI text. This is
 * not permitted. Relative paths only." The brownfield rehearsal found, before pause 1:
 *  - roster-specialiser told to list and read the canonical personas in a folder under the
 *    install's logs (__CANONICAL_DIR__, __CANONICAL_COPY_PATH__) — a folder a CodeMie web plugin,
 *    rooted at the codelines, cannot even reach — and "Project config: <install path>";
 *  - project-roster-review shown the roster and canonical paths, though its entries are inline.
 * The personas are now IN the prompt; the project is named, not located.
 *
 * EXECUTED: the real roster seams (lib/roster-seams.js) on the real canonical roster, with a
 * stand-in runner that records the prompt it is handed.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mintProjectPrompts } from '../../helpers/project-prompts';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const AGENTS = join(ROOT, 'orchestrations/agents');
const CANONICAL = join(AGENTS, 'profiles.canonical.json');
/** An absolute local path: a slash-rooted token with at least two segments, not part of a URL. */
const ABSOLUTE = /(?<![\w.:/~$-])\/[\w.-]+\/[\w./-]*/g;

const work = mkdtempSync(join(tmpdir(), 'roster-content-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

async function specialiserPrompt(): Promise<string> {
  const prev = process.env.EPAM_PROJECT_CONFIG_DIR; const prevRoot = process.env.JIRA_CODELINE_ROOT;
  const projectConfigDir = mintProjectPrompts();
  process.env.EPAM_PROJECT_CONFIG_DIR = projectConfigDir;
  // The codelines folder, as a run declares it: a codeline's location is told relative to it.
  process.env.JIRA_CODELINE_ROOT = join(work, 'codelines');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const roster = require(join(LIB, 'project-roster.js'));
    const logDir = join(work, 'logs'); mkdirSync(logDir, { recursive: true });
    const canonicalCopyPath = roster.copyCanonicalForRun(CANONICAL, logDir);
    const seen: string[] = [];
    const spec = { runClaude: async (_x: unknown, prompt: string) => { seen.push(prompt); return '{"agents":{}}'; }, surveyLeadsBlock: () => '' };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { rosterSeams } = require(join(LIB, 'roster-seams.js'));
    const codeline = join(work, 'codelines', 'site-a'); mkdirSync(codeline, { recursive: true });
    const { produce } = rosterSeams({
      spec, promptExec: {}, projectConfigDir, LOG_DIR: logDir, AGENTS_DIR: AGENTS, REPO_PATH: codeline,
      codelines: [{ name: 'site-a', path: codeline }], stories: [{ id: 'X-1', title: 't' }], prd: {}, mintedDetail: [], survey: null,
    });
    await produce({ canonicalCopyPath, outPath: join(work, 'delta.json'), attempt: 1 });
    expect(seen.length, 'the specialiser was never asked — this proves nothing').toBe(1);
    return seen[0];
  } finally {
    if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev;
    if (prevRoot === undefined) delete process.env.JIRA_CODELINE_ROOT; else process.env.JIRA_CODELINE_ROOT = prevRoot;
  }
}

describe('the roster seams are given content, not install paths', () => {
  it('the specialiser is given every canonical persona in its prompt', async () => {
    const prompt = await specialiserPrompt();
    const canonical = JSON.parse(readFileSync(CANONICAL, 'utf8'));
    const names = Object.keys(canonical).filter((k) => typeof canonical[k] === 'string' && canonical[k].trim());
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(prompt, `persona ${n} is not in the prompt`).toContain(canonical[n].trim());
  });

  it('the specialiser\'s prompt names no install path — the project is named, not located', async () => {
    const prompt = await specialiserPrompt();
    expect(prompt).not.toContain(work);
    expect(prompt).not.toMatch(/roster-canonical-copy/);
    expect(prompt).not.toMatch(/Project config:/);
  });

  it('the roster review names no path for the rosters it is shown inline', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { renderEngineTemplate } = require(join(LIB, 'engine-prompt.js'));
    const prev = process.env.EPAM_PROJECT_CONFIG_DIR;
    process.env.EPAM_PROJECT_CONFIG_DIR = mintProjectPrompts();
    try {
      const doc = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/project-roster-review.json'), 'utf8'));
      const vals: Record<string, string> = {};
      for (const p of doc.placeholders) vals[p] = `value-of-${p.replace(/_/g, '').toLowerCase()}`;
      const out: string = renderEngineTemplate('project-roster-review', vals);
      expect(out.length).toBeGreaterThan(200);
      expect(doc.placeholders.filter((p: string) => /PATH/.test(p)), 'the review still takes a path').toEqual([]);
      expect(out.match(ABSOLUTE) || []).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev;
    }
  });
});

