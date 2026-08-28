/**
 * THE TICKET MUST REACH THE PRD WHOLE — proven through the REAL ingest chain.
 *
 * WHY THIS EXISTS. Every stage of this chain had passing tests and the chain destroyed the
 * ticket anyway. Live 2026-08-06, story AMSD-2041 reached the spec pass as:
 *
 *     desc 43 chars | comments 0 | links 0 | components []
 *
 * 43 characters was its own TITLE. The real ticket carried a 395-character description,
 * twelve comments, two vendor documentation links and four components — I confirmed that by
 * making the exact call ingest makes. Everything after ingest then reasoned about a ticket
 * that had been emptied, and the ticket-link agent had nothing to review.
 *
 * TWO DEFECTS, BOTH SILENT:
 *
 *  1. `ac-gate.js` built its output by NAMING the fields to keep. That made it a whitelist:
 *     `description`, `comments`, `commentLinks` and `components` were not named, so they
 *     were dropped with no error and no log line. The same shape had already cost
 *     `issueType` on 2026-07-23, and the fix then was to add one more name — leaving the
 *     defect in place for the next field.
 *  2. `synthesize-prd-from-jira.js` read `description: tmpl.description || c.title` — the
 *     ticket's own description was never consulted at all.
 *
 * WHY MY EARLIER TESTS MISSED IT. They exercised `normalizeIssue` and the synthesiser
 * directly, building the story object by hand. The gate sits BETWEEN them, and nothing ran
 * through it. Testing the caller instead of the receiver is exactly how a whitelist survives.
 *
 * SO THIS TEST RUNS THE REAL STAGES: the real jira-client against a stubbed Jira HTTP
 * endpoint, the real ac-gate.js as a process, the real synthesize-prd-from-jira.js as a
 * process, and asserts on the PRD FILE they produce. No live Jira, no model call
 * (AC_GATE_DRY_RUN), no hand-built story object anywhere.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const NODE = process.execPath;

/** Facts that exist ONLY in the stubbed ticket. If one reaches the PRD, it was carried. */
const DESC_FACT = 'the preview handler must re-fetch entry ZQ71-KX44 because the callback carries nothing';
const COMMENT_FACT = 'confirmed with the vendor that no code change is needed for build 7Q4X-ZL91';
const DOC_URL = 'https://vendor.test/docs/live-preview-implementation#callback';
const COMPONENTS = ['GO', 'Intake & Planning', 'MX', 'UP'];

/** A Jira issue in ADF, with the link inside a comment's mark — where links really live. */
function issue() {
  return {
    id: '1', key: 'TEST-2041',
    fields: {
      summary: '[GO, UP, MX] Live Preview of Content in CMS',
      issuetype: { name: 'Story' },
      status: { name: 'To Do' },
      components: COMPONENTS.map((name) => ({ name })),
      description: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: DESC_FACT }] }],
      },
      comment: {
        comments: [{
          author: { displayName: 'A Reviewer' },
          created: '2026-08-01T10:00:00.000+0000',
          body: {
            type: 'doc',
            content: [{
              type: 'paragraph',
              content: [
                { type: 'text', text: `${COMMENT_FACT} — see ` },
                { type: 'text', text: 'the guide', marks: [{ type: 'link', attrs: { href: DOC_URL } }] },
              ],
            }],
          },
        }],
      },
    },
  };
}

/**
 * THE STUB JIRA RUNS IN ITS OWN PROCESS.
 *
 * It first ran inside the vitest process. Every stage of the chain is invoked with
 * spawnSync, which BLOCKS the calling process's event loop — so the stub server could never
 * answer a request made by its own child. The chain died on ESOCKETTIMEDOUT after
 * jira-client's full 30s socket timeout and two retries, and the whole file reported
 * "9 skipped" as though nothing had been written.
 */
let serverProc: ReturnType<typeof spawn>;
let base = '';
const dirs: string[] = [];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jira-stub-')); dirs.push(dir);
  const script = join(dir, 'server.js');
  const portFile = join(dir, 'port');
  writeFileSync(script, `
    const http = require('http'), fs = require('fs');
    const issue = ${JSON.stringify(null)} || null;
    const payload = ${JSON.stringify(null)};
    const ISSUE = ${'JSON.parse(process.argv[2])'};
    http.createServer((q, s) => {
      s.writeHead(200, {'content-type': 'application/json'});
      s.end(JSON.stringify(q.url.includes('/search') ? {issues: [ISSUE], total: 1, isLast: true} : ISSUE));
    }).listen(0, '127.0.0.1', function () {
      fs.writeFileSync(${JSON.stringify(portFile)}, String(this.address().port));
    });
  `);
  serverProc = spawn(NODE, [script, JSON.stringify(issue())], { stdio: 'ignore' });
  // Wait for it to report its port rather than guessing a delay.
  for (let i = 0; i < 100 && !existsSync(portFile); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!existsSync(portFile)) throw new Error('stub Jira never started — the chain cannot run');
  base = `http://127.0.0.1:${readFileSync(portFile, 'utf8').trim()}`;
  CHAIN = runChain();
}, 120000);

afterAll(() => {
  try { serverProc?.kill(); } catch { /* already gone */ }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const jiraEnv = () => ({
  ...process.env,
  JIRA_URL: base, JIRA_EMAIL: 't@t', JIRA_TOKEN: 'x',
  JIRA_JQL: 'issue = TEST-2041',
});

/** Stage 1 — the REAL jira-client, the exact call ingest-jira-tickets.sh makes. */
function pullIssues(dir: string): string {
  const out = join(dir, 'issues.json');
  const r = spawnSync(NODE, ['-e', `
    const jira = require(${JSON.stringify(join(SCRIPTS, 'lib/jira-client.js'))});
    jira.getProjectIssues('TEST', 'To Do').then(i => {
      require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(i, null, 2));
    });
  `], { env: jiraEnv(), encoding: 'utf8' });
  expect(r.status, `jira pull failed: ${r.stderr}`).toBe(0);
  return out;
}

/** Stage 2 — the REAL ac-gate.js, as a process, with no model call. */
function runGate(dir: string, issuesPath: string): string {
  const out = join(dir, 'ac-gate.json');
  const r = spawnSync(NODE, [join(SCRIPTS, 'lib/ac-gate.js'), '--issues', issuesPath, '--out', out, '--dry-run'], {
    env: { ...jiraEnv(), AC_GATE_DRY_RUN: '1', EPAM_BROWNFIELD: '1', JIRA_CODELINES: 'lane-one' },
    encoding: 'utf8',
  });
  expect([0, 2], `ac-gate exited ${r.status}: ${r.stderr?.slice(-500)}`).toContain(r.status);
  return out;
}

/** Stage 3 — the REAL synthesiser, as a process. */
function runSynthesise(dir: string, gatePath: string): any {
  const tmpl = join(dir, 'template.json');
  // A template with NO description, like a real project template — the ticket supplies it.
  writeFileSync(tmpl, JSON.stringify({ project: { name: 'test', outputDir: dir }, stories: [] }));
  const out = join(dir, 'prd.json');
  const r = spawnSync(NODE, [join(SCRIPTS, 'synthesize-prd-from-jira.js'),
    '--classifications', gatePath, '--template', tmpl, '--out', out, '--project-name', 'test'], {
    env: { ...jiraEnv(), EPAM_BROWNFIELD: '1', JIRA_CODELINES: 'lane-one' }, encoding: 'utf8',
  });
  expect(r.status, `synthesise failed: ${r.stderr?.slice(-500)}`).toBe(0);
  return JSON.parse(readFileSync(out, 'utf8'));
}

/**
 * The whole chain, ONCE — computed in beforeAll and shared.
 *
 * The first version of this file called ingest() inside every `it`, so the chain ran nine
 * times: nine Jira pulls, nine gate processes, nine synthesiser processes. The file blew a
 * 400s timeout and reported nothing at all. A test that cannot finish proves less than no
 * test, because it looks like infrastructure trouble rather than a defect.
 */
let CHAIN: ReturnType<typeof runChain>;

function runChain() {
  const dir = mkdtempSync(join(tmpdir(), 'ingest-chain-')); dirs.push(dir);
  const issues = pullIssues(dir);
  const gate = runGate(dir, issues);
  const prd = runSynthesise(dir, gate);
  return { dir, gateRecords: JSON.parse(readFileSync(gate, 'utf8')), prd, story: prd.stories[0] };
}

function ingest() { return CHAIN; }

describe('the ticket survives the whole ingest chain, into the PRD file', () => {
  it('the fixture is real — the chain produced a story at all', () => {
    const { story } = ingest();
    expect(story, 'no story reached the PRD; every assertion below would be vacuous').toBeTruthy();
    expect(story.jiraKey).toBe('TEST-2041');
  });

  it('THE DESCRIPTION: the ticket\'s own text, not its title', () => {
    const { story } = ingest();
    expect(
      story.description,
      'the story reached the PRD described by its own one-line summary — in brownfield the ' +
        'description is the only substantive content a ticket has',
    ).toContain('ZQ71-KX44');
    expect(story.description).not.toBe(story.title);
    expect(story.description.length).toBeGreaterThan(story.title.length);
  });

  it('THE COMMENTS: the thread reaches the PRD', () => {
    const { story } = ingest();
    expect(story.ticketComments?.length, 'the comment thread was dropped').toBeGreaterThan(0);
    expect(JSON.stringify(story.ticketComments)).toContain('7Q4X-ZL91');
  });

  it('THE LINKS: a URL inside a comment reaches the PRD, with provenance', () => {
    const { story } = ingest();
    expect(story.ticketLinks?.length, 'the documentation links were dropped').toBeGreaterThan(0);
    const link = story.ticketLinks.find((l: any) => l.url === DOC_URL);
    expect(link, `link not found; got ${JSON.stringify(story.ticketLinks)}`).toBeTruthy();
    expect(link.author).toBe('A Reviewer');
    expect(link.context, 'the surrounding explanation was clipped away').toContain('no code change is needed');
  });

  it('THE COMPONENTS: the one structured field saying which product areas are touched', () => {
    const { story } = ingest();
    expect(story.components).toEqual(COMPONENTS);
  });
});

describe('the AC gate classifies — it does not decide what a ticket consists of', () => {
  it('THE WHITELIST: the gate passes the ticket through, not a chosen subset', () => {
    const { gateRecords } = ingest();
    const rec = gateRecords[0];
    for (const field of ['description', 'comments', 'commentLinks', 'components']) {
      expect(
        rec[field],
        `ac-gate dropped "${field}". It built its output by naming fields one at a time, so ` +
          'anything unnamed was destroyed silently — the same shape that already cost ' +
          'issueType on 2026-07-23',
      ).toBeDefined();
    }
  });

  it('a field nobody thought to name still arrives — the point of passing through', () => {
    // Proves the fix is structural. A gate that merely gained four more names would fail here.
    const { gateRecords } = ingest();
    const rec = gateRecords[0];
    expect(rec.status, 'only explicitly-named fields survive; the whitelist is still there').toBeDefined();
  });

  it('the gate still does its own job — classification is not lost to the spread', () => {
    const { gateRecords } = ingest();
    const rec = gateRecords[0];
    expect(rec.verdict, 'the gate stopped classifying').toBeTruthy();
    expect(rec.codeline, 'codeline routing is load-bearing and must survive').toBeTruthy();
  });

  it('brownfield with no ACs spends no model call on AC processing', () => {
    const { gateRecords } = ingest();
    expect(gateRecords[0].verdict).toBeTruthy();
    // The ticket has no acceptanceCriteria; the gate must not have invented any.
    expect(gateRecords[0].enrichedAcs || []).toEqual([]);
  });
});
