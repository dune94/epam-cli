/**
 * THE SPEC AGENT WAS ASKED TO VERIFY A CHANGE IT COULD BARELY SEE.
 *
 * The real openspec prompt from run 20260806T213050Z, measured:
 *
 *   EXISTING CODE (CodeGraph/Semble dump)   26,121 chars   92%
 *   everything else combined                 ~2,200 chars
 *   referenced-documentation quotes                4 lines
 *   DECLARED FILES block                         ABSENT
 *
 * Three separate faults, all of which starve the criteria it produces:
 *
 * 1. DECLARED FILES NEVER RENDERS ON A FIRST PASS. manifestFileExcerpts reads
 *    story.technicalNotes.files — which is populated from the spec agent's OWN answer
 *    (spec-mode-runner.js:5276, mergeLocationHintFiles(payload.locationHint)). So the
 *    mechanism for showing an agent the code it must reason about only works after that
 *    agent has already reasoned about it. On a first pass the block is empty, silently:
 *    manifestFileExcerpts `continue`s past anything it cannot resolve and returns ''.
 *    The DETECTIVE runs BEFORE the spec agent and has already located the files — that is
 *    the source the excerpts should come from.
 *
 * 2. THE DOCUMENTS ARE NOT ON DISK. The ticket-link agent fetched two vendor guides, and the
 *    only thing that survives is the handful of quotes it chose (rendered at most 6 per
 *    document). Nothing under runs/<id>/ holds the document text, so no later agent can read
 *    more of it. The rule this project enforces everywhere else — anything generated is
 *    persisted — was not applied to the one artefact fetched from outside.
 *
 * 3. THE PROMPT DISOWNS THE TOOLS THE AGENT HAS. specAgentEnv grants
 *    read_file,list_files,search with AI_GATE_ALLOW_TOOLS=1, and the brownfield block opens
 *    with "output JSON only, no tools, no search". An agent told it cannot look will not
 *    look, whatever its grant says.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function repoWithFile(rel: string, body: string) {
  const root = mkdtempSync(join(tmpdir(), 'specinputs-')); dirs.push(root);
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
  return root;
}

describe('1. the files the DETECTIVE located reach the prompt, without waiting for the agent to name them', () => {
  const CODE = 'export const options = { api_key: KEY };  // the live_preview block belongs here';
  const root = repoWithFile('src/services/contentstack.ts', CODE);
  const prd = { project: { outputDir: root } };

  it('THE GAP: a story whose files are not yet declared still gets its located code', () => {
    const story = {
      id: 'T-1',
      technicalNotes: {},                                   // empty on a first pass — the real case
      fixSiteAnalysis: [{ file: 'src/services/contentstack.ts', function: 'options', reason: 'the SDK config' }],
    };
    const block = spec.manifestFileExcerpts(story, prd);
    expect(
      block,
      'the detective located the file before the agent ran, and the agent was shown none of it',
    ).toContain('live_preview block belongs here');
  });

  it('declared files still win when they exist', () => {
    const story = { id: 'T-1', technicalNotes: { files: ['src/services/contentstack.ts'] }, fixSiteAnalysis: [] };
    expect(spec.manifestFileExcerpts(story, prd)).toContain('live_preview block belongs here');
  });

  it('a file that cannot be resolved is REPORTED, not silently skipped', () => {
    const story = { id: 'T-1', technicalNotes: { files: ['src/does/not/exist.ts'] }, fixSiteAnalysis: [] };
    const block = spec.manifestFileExcerpts(story, prd);
    expect(
      block,
      'silent skipping is why an empty DECLARED FILES block went unnoticed for the life of this feature',
    ).toMatch(/could not be read|not found|unreadable/i);
  });

  it('nothing to show yields nothing — no empty heading', () => {
    expect(spec.manifestFileExcerpts({ id: 'T-1', technicalNotes: {}, fixSiteAnalysis: [] }, prd)).toBe('');
  });
});

describe('2. fetched documents are persisted so later agents can read them', () => {
  it('THE GAP: the document body is written to the run, not just its quotes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docstore-')); dirs.push(dir);
    const written = spec.persistReferencedDocs([
      { url: 'https://vendor.test/docs/live-preview', fetchStatus: 'fetched', quotes: ['q1'],
        body: 'FULL DOCUMENT TEXT: onEntryChange takes a callback.' },
    ], dir);
    expect(written.length, 'nothing was persisted, so no later agent can read past the quotes').toBe(1);
    expect(existsSync(written[0])).toBe(true);
    expect(readFileSync(written[0], 'utf8')).toContain('onEntryChange takes a callback');
  });

  it('the file name is derived from the URL, so an agent can find it from the citation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docstore2-')); dirs.push(dir);
    const [p] = spec.persistReferencedDocs([
      { url: 'https://vendor.test/docs/live-preview-implementation', fetchStatus: 'fetched', quotes: ['q'], body: 'x' },
    ], dir);
    expect(p).toMatch(/live-preview-implementation/);
  });

  it('a document that was never fetched writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docstore3-')); dirs.push(dir);
    expect(spec.persistReferencedDocs([
      { url: 'https://vendor.test/x', fetchStatus: 'unreachable', quotes: ['could not open'] },
    ], dir)).toEqual([]);
  });

  it('persisting never throws — evidence writing must not break a spec pass', () => {
    expect(() => spec.persistReferencedDocs(null, '/nonexistent/place')).not.toThrow();
    expect(spec.persistReferencedDocs(null, '/nonexistent/place')).toEqual([]);
  });
});

describe('3. the prompt does not disown the tools the agent was granted', () => {
  const brownfield = { EPAM_BROWNFIELD: '1' };
  const block = () => spec.buildBrownfieldArchaeologyBlock(brownfield,
    { hasAcceptanceCriteria: false, hasReferencedDocs: true }).archaeologyBlock;

  it('THE CONTRADICTION: it no longer says "no tools, no search"', () => {
    expect(
      block(),
      'specAgentEnv grants read_file/list_files/search with AI_GATE_ALLOW_TOOLS=1, and the prompt tells it not to look',
    ).not.toMatch(/no tools, no search/i);
  });

  it('it tells the agent it may read the files it is pointed at', () => {
    expect(block()).toMatch(/read_file|read the file/i);
  });

  it('the anti-fabrication rule survives — looking is allowed, inventing is not', () => {
    expect(block()).toMatch(/do NOT invent|fabrication/i);
  });
});

/**
 * 2b. THE ENGINE FETCHES THE DOCUMENTS — not the model.
 *
 * persistReferencedDocs needs a body, and nothing produced one: the ticket-link agent fetches
 * inside its own process and only the quotes it chose come back through TOOL_TICKET_LINKS.
 * The page died with that process. Putting the body in the schema would push a 16KB document
 * back through the model as output tokens — the wrong shape, and billed.
 *
 * So the ENGINE fetches each URL on the ticket, deterministically, before any agent runs:
 *
 *   - no model call, no tool budget, no chance of a model declining to look
 *   - every agent sees the SAME document, not one agent's selection from it
 *   - it uses the shipped FetchUrlTool (dist/sdk.js), so the text extraction and cap are the
 *     same code the agents' fetch_url uses — one implementation, no second copy to drift
 *
 * A URL that cannot be fetched is recorded as such, never as an empty document: "the page
 * said nothing" and "we could not open the page" must not look alike.
 */
describe('2b. the engine fetches ticket documents itself', () => {
  const { createServer } = require('node:http');

  it('THE GAP: fetching a ticket link writes its readable text under the run', async () => {
    const FACT = 'onEntryChange accepts a callback in build 9KX2-QQ71';
    const srv = createServer((_req: any, res: any) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head><script>junk()</script></head><body><main><p>${FACT}</p></main></body></html>`);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const dir = mkdtempSync(join(tmpdir(), 'enginefetch-')); dirs.push(dir);
    try {
      const docs = await spec.fetchTicketDocuments([{ url: `${base}/docs/guide` }], dir);
      expect(docs.length, 'the engine fetched nothing').toBe(1);
      expect(docs[0].fetchStatus).toBe('fetched');
      const onDisk = readFileSync(docs[0].path, 'utf8');
      expect(onDisk, 'the document body is not on disk, so no agent can read past the quotes').toContain(FACT);
      expect(onDisk, 'markup reached the file instead of text').not.toMatch(/<script|<main/);
      expect(onDisk).toContain(`${base}/docs/guide`);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 60000);

  it('an unreachable URL is recorded as unreachable, not as an empty document', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'enginefetch2-')); dirs.push(dir);
    const docs = await spec.fetchTicketDocuments([{ url: 'http://127.0.0.1:9/nothing' }], dir);
    expect(docs.length).toBe(1);
    expect(docs[0].fetchStatus).toBe('unreachable');
    expect(docs[0].path, 'an empty file would read as a document that says nothing').toBeFalsy();
  });

  it('no links means no work and no directory clutter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'enginefetch3-')); dirs.push(dir);
    expect(await spec.fetchTicketDocuments([], dir)).toEqual([]);
    expect(await spec.fetchTicketDocuments(null, dir)).toEqual([]);
  });

  it('it never throws — a fetch failure must not fail the spec pass', async () => {
    await expect(spec.fetchTicketDocuments([{ url: 'not-a-url' }], '/nonexistent/x')).resolves.toBeInstanceOf(Array);
  });
});

/**
 * 1b. AND THE CALL SITE MUST PASS THE RIGHT THING.
 *
 * The first version of fix 1 read story.fixSiteAnalysis. That field is assigned ~160 lines
 * AFTER the prompt is built, so at prompt time it is empty — the block still never rendered
 * on the live run of 20260806T190839, while the unit tests above stayed green because their
 * fixture hands the function a story that already has it.
 *
 * A fixture more convenient than reality is how a dead feature tests green. So: assert the
 * function honours an explicit list, AND that the call site supplies the detective's findings
 * rather than the field that is not yet set.
 */
describe('1b. the located files come from the detective, at the moment the prompt is built', () => {
  const CODE = 'export const options = {};  // SDK config lives here';
  const root2 = repoWithFile('src/services/contentstack.ts', CODE);

  it('an explicit located list is honoured even when the story field is empty', () => {
    const story = { id: 'T-1', technicalNotes: {}, fixSiteAnalysis: [] };
    const block = spec.manifestFileExcerpts(story, { project: { outputDir: root2 } },
      { located: [{ file: 'src/services/contentstack.ts', reason: 'r' }] });
    expect(block, 'the caller passed the findings and they were ignored').toContain('SDK config lives here');
  });

  it('plain strings work too, not only finding objects', () => {
    const block = spec.manifestFileExcerpts({ id: 'T-1', technicalNotes: {} },
      { project: { outputDir: root2 } }, { located: ['src/services/contentstack.ts'] });
    expect(block).toContain('SDK config lives here');
  });

  it('THE WIRING: the call site passes the detective findings, not the later-set field', () => {
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    expect(
      src,
      'the prompt is built from a field that is empty at prompt time — the block renders nothing',
    ).toMatch(/manifestFileExcerpts\(story, prd, \{\s*located:\s*detectiveFindings\s*\}\)/);
  });

  it('the detective findings are available BEFORE the block is built', () => {
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8').split('\n');
    const assigned = src.findIndex((l) => /detectiveFindings = \(await runDetective/.test(l));
    const used = src.findIndex((l) => /manifestFileExcerpts\(story, prd, \{ located: detectiveFindings \}\)/.test(l));
    expect(assigned, 'the detective call moved').toBeGreaterThan(-1);
    expect(used, 'the call site moved').toBeGreaterThan(-1);
    expect(used, 'the block is built before the detective has run').toBeGreaterThan(assigned);
  });
});
