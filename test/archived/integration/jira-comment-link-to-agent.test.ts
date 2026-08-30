/**
 * THE WHOLE CHAIN: Jira comment → link → ingest → the document's words in an agent's prompt.
 *
 * Every piece of this had unit coverage and the chain had never once run end to end. The
 * pieces passed individually while the chain was broken in two places at the same time:
 *
 *   1. `envOverride` — the ticket-link agent's tool grant — was forwarded to runClaude on
 *      ONE of runAgentForJson's three paths. On the default path and on the minimax ladder
 *      it was replaced with `{}`, and ai-run.sh forces `--no-tools` unless
 *      AI_GATE_ALLOW_TOOLS=1 is present. So the agent that exists to QUOTE a document was
 *      run with no ability to open one, and its `quotes` field could never be populated.
 *      Nothing failed; the answer just came back thinner.
 *   2. The link's surrounding text was clipped to 300 characters twice — once in
 *      jira-client when the link is recorded, again in the prompt that renders it. The
 *      sentence explaining WHY someone posted a doc comes AFTER the link, so it is exactly
 *      the part a short cap removes.
 *
 * WHAT THIS TEST RUNS FOR REAL: getIssue, normalizeIssue, reviewTicketLinks,
 * runAgentForJson, runClaude (a real spawn), extractTaggedJson, schema validation,
 * referencedDocsBlock, the real FetchUrl tool, and the real ai-run.sh.
 *
 * WHAT IS STUBBED: the network. A local HTTP server plays both Jira and the vendor's
 * documentation site. The model is a stub runner process which fetches the URL it was given
 * IF AND ONLY IF it was granted a fetch tool — mirroring what the grant actually decides.
 *
 * WHAT THIS CANNOT PROVE: that a live model elects to call the tool. That is model
 * behaviour and no offline test establishes it. Everything the ENGINE controls — the URL
 * reaching the agent, the grant reaching the process, the runner honouring the grant, the
 * document being fetchable and readable, and the quote landing in the spec prompt — is
 * proven here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AddressInfo } from 'node:net';

const ROOT = join(__dirname, '../../');
const SPEC = join(ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const JIRA = join(ROOT, 'orchestrations/scripts/lib/jira-client.js');

/**
 * The one fact that cannot be guessed, inferred, or fabricated. It exists ONLY inside the
 * document body served by the stub docs site. If it reaches the spec-agent prompt, it got
 * there by being fetched — there is no other path to it.
 */
const DOC_FACT = 'onEntryChange accepts no argument in build 7Q4X-ZL91 and the app must re-fetch';

/** A comment whose explanation of the link sits well past 300 characters, after the URL. */
const LINK_URL_PATH = '/docs/live-preview-implementation';
const COMMENT_TAIL =
  'The reason I am posting this rather than the overview page is that the overview describes ' +
  'the older integration and would send us down the wrong path entirely; this one is the ' +
  'page that matches the SDK version we are pinned to, and the callback section in ' +
  'particular is the part that settles the argument we had in refinement about whether the ' +
  'handler receives the changed entry or has to go and re-read it itself.';

let server: Server;
let base = '';
let tmp = '';
const cleanup: string[] = [];

function docHtml(): string {
  // Shaped like real documentation: the sentence that matters sits behind heavy markup.
  const noise = `<script>${'j'.repeat(1024)}</script><style>${'c'.repeat(1024)}</style>`;
  return `<!DOCTYPE html><html><head><title>Live Preview</title>${noise.repeat(40)}</head>` +
    `<body><nav>${'<a href="#">nav</a>'.repeat(150)}</nav>` +
    `<main><h1>Live preview</h1><p>Overview paragraph.</p><p>${DOC_FACT}.</p></main>` +
    `</body></html>`;
}

function issueJson(): unknown {
  const commentBody = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Have a look at ' },
        {
          type: 'text', text: 'the implementation guide',
          marks: [{ type: 'link', attrs: { href: `${base}${LINK_URL_PATH}` } }],
        },
        { type: 'text', text: `. ${COMMENT_TAIL}` },
      ],
    }],
  };
  return {
    key: 'TEST-1',
    fields: {
      summary: 'Wire live preview into the content layer',
      description: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The handler should receive the changed entry.' }] }],
      },
      status: { name: 'To Do' },
      issuetype: { name: 'Story' },
      components: [{ name: 'Web' }],
      comment: {
        comments: [{
          author: { displayName: 'A Reviewer' },
          created: '2026-08-01T10:00:00.000+0000',
          body: commentBody,
        }],
      },
    },
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if ((req.url || '').startsWith('/rest/api/3/issue/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(issueJson()));
      return;
    }
    if ((req.url || '').startsWith(LINK_URL_PATH)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(docHtml());
      return;
    }
    res.writeHead(404); res.end('no');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  tmp = mkdtempSync(join(tmpdir(), 'linkchain-'));
  cleanup.push(tmp);
  mkdirSync(join(tmp, 'logs'), { recursive: true });
  mkdirSync(join(tmp, 'agents'), { recursive: true });
  // The real persona, not an invented one — the prompt the agent sees must be the shipped one.
  const real = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/profiles.canonical.json'), 'utf8'));
  writeFileSync(join(tmp, 'agents', 'profiles.json'), JSON.stringify(real));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

/**
 * Stands in for the model. It fetches the URL in its prompt ONLY when it was granted a
 * fetch tool and tools were switched on — which is precisely what the grant decides in
 * production, because ai-run.sh runs `--no-tools` without AI_GATE_ALLOW_TOOLS=1.
 */
function stubRunner(dir: string): { cmd: string; args: string[]; envFile: string; promptFile: string } {
  const envFile = join(dir, 'runner-env.json');
  const promptFile = join(dir, 'runner-prompt.txt');
  const script = join(dir, 'stub-runner.js');
  writeFileSync(script, `
const fs = require('fs'), http = require('http');
let prompt = '';
process.stdin.on('data', d => prompt += d);
process.stdin.on('end', async () => {
  fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));
  fs.writeFileSync(${JSON.stringify(promptFile)}, prompt);
  const url = (prompt.match(/https?:\\/\\/[^\\s)]+/) || [''])[0];
  const granted = String(process.env.EPAM_ALLOWED_TOOLS || '').includes('fetch_url')
               && String(process.env.AI_GATE_ALLOW_TOOLS || '') === '1';
  let quotes = [];
  if (granted && url) {
    const body = await new Promise(res => http.get(url, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => res(b));
    }).on('error', () => res('')));
    const text = body.replace(/<script[\\s\\S]*?<\\/script>/gi, '')
                     .replace(/<style[\\s\\S]*?<\\/style>/gi, '')
                     .replace(/<[^>]+>/g, ' ');
    const m = text.match(/onEntryChange accepts[^.]*/);
    if (m) quotes = [m[0].trim()];
  }
  const payload = { links: [{
    url, classification: 'vendor_documentation', relevant: true,
    reason: 'states the callback contract this story assumes',
    quotes,
    contradictsStory: quotes.length ? 'the story assumes the handler receives the entry' : '',
  }] };
  process.stdout.write('<TICKET_LINKS>' + JSON.stringify(payload) + '</TICKET_LINKS>');
});
`);
  // The runner must be the EXECUTABLE, with the script inside it. The SPEC_MODE_PROVIDER
  // fast-path rebuilds execSpec as {cmd, args:['--provider',…]} — it keeps the command and
  // REPLACES the arguments, exactly as it does for the real ai-run.sh, which takes those
  // flags. A stub of the form `node script.js` would lose its script there.
  const bin = join(dir, 'run.sh');
  writeFileSync(bin, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`);
  chmodSync(bin, 0o755);
  return { cmd: bin, args: [], envFile, promptFile };
}

/** Run the real reviewTicketLinks against a freshly-required module under given env. */
async function runChain(extraEnv: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'linkrun-'));
  cleanup.push(dir);
  const saved = { ...process.env };
  Object.assign(process.env, {
    JIRA_URL: base, JIRA_EMAIL: 't@t', JIRA_TOKEN: 'x',
    SPEC_MODE_PROVIDER: '', AI_PROVIDER: '', EPAM_ORCHESTRATION_PROVIDER: '',
    ...extraEnv,
  });
  for (const k of Object.keys(process.env)) if (process.env[k] === '') delete process.env[k];
  try {
    delete require.cache[require.resolve(JIRA)];
    delete require.cache[require.resolve(SPEC)];
    const jira = require(JIRA);
    const spec = require(SPEC);
    const issue = await jira.getIssue('TEST-1');
    const n = jira.normalizeIssue(issue);
    const story: any = {
      id: 'TEST-1', title: n.title, description: n.description,
      components: n.components, ticketLinks: n.commentLinks, ticketComments: n.comments,
      specification: {},
    };
    const runner = stubRunner(dir);
    const docs = await spec.reviewTicketLinks({
      promptExec: { cmd: runner.cmd, args: runner.args },
      story,
      logDir: join(tmp, 'logs'),
    });
    return { jira, spec, n, story, docs, runner };
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe('ingest: a link inside a Jira comment survives ADF, with its whole explanation', () => {
  it('the URL is recovered from a link mark, not from the visible text', async () => {
    const { n } = await runChain({});
    expect(n.commentLinks.map((l: any) => l.url)).toContain(`${base}${LINK_URL_PATH}`);
    // The anchor text never contains the URL — recovering it proves marks[].attrs.href was read.
    expect(n.comments[0].text).not.toContain('http');
  });

  it('provenance comes with it', async () => {
    const { n } = await runChain({});
    const link = n.commentLinks.find((l: any) => l.url.endsWith(LINK_URL_PATH));
    expect(link.author).toBe('A Reviewer');
    expect(link.created).toMatch(/^2026-08-01/);
  });

  it('THE CLIP: the explanation that follows the link is kept in full', async () => {
    const { n } = await runChain({});
    const link = n.commentLinks.find((l: any) => l.url.endsWith(LINK_URL_PATH));
    expect(link.context.length).toBeGreaterThan(300);
    expect(
      link.context,
      'the sentence saying WHY the doc was posted sits past 300 chars, so a 300-char cap removes exactly it',
    ).toContain('receives the changed entry');
  });
});

describe('the agent is handed the link, uncut, and is really given a way to open it', () => {
  it('the prompt carries the URL and the whole surrounding explanation', async () => {
    const { runner } = await runChain({});
    const prompt = readFileSync(runner.promptFile, 'utf8');
    expect(prompt).toContain(`${base}${LINK_URL_PATH}`);
    expect(prompt, 'the prompt re-clipped what jira-client kept').toContain('receives the changed entry');
  });

  it('THE DROPPED GRANT: the fetch tool reaches the runner on the DEFAULT path', async () => {
    const { runner } = await runChain({});
    const env = JSON.parse(readFileSync(runner.envFile, 'utf8'));
    expect(
      env.EPAM_ALLOWED_TOOLS,
      'envOverride was forwarded only on the SPEC_MODE_PROVIDER fast-path; every other path ' +
        'replaced it with {} and the agent ran with no fetch tool at all',
    ).toContain('fetch_url');
    expect(env.AI_GATE_ALLOW_TOOLS, 'a tool list without this switch runs --no-tools').toBe('1');
  });

  it('the grant also reaches the runner on the SPEC_MODE_PROVIDER fast-path', async () => {
    const { runner } = await runChain({ SPEC_MODE_PROVIDER: 'openrouter', SPEC_MODE_MODEL: 'stub' });
    const env = JSON.parse(readFileSync(runner.envFile, 'utf8'));
    expect(env.EPAM_ALLOWED_TOOLS).toContain('fetch_url');
    expect(env.AI_GATE_ALLOW_TOOLS).toBe('1');
  });
});

describe("the document's own words reach the specification prompt", () => {
  it('a verbatim quote from the fetched page comes back on the reviewed link', async () => {
    const { docs } = await runChain({});
    expect(docs).toHaveLength(1);
    expect(
      docs[0].quotes.join(' '),
      'the fact exists only in the served document body — there is no path to it but a fetch',
    ).toContain('accepts no argument in build 7Q4X-ZL91');
  });

  it('THE PAYOFF: it renders into the block the spec agent actually reads', async () => {
    const { spec, docs } = await runChain({});
    const block = spec.referencedDocsBlock(docs);
    expect(block.length, 'a vacuous pass — nothing was rendered, so every assertion below is free').toBeGreaterThan(0);
    expect(block).toContain('7Q4X-ZL91');
    expect(block).toContain(`${base}${LINK_URL_PATH}`);
  });

  it('a contradiction is stated before anything else, not buried', () => {
    const block = require(SPEC).referencedDocsBlock([{
      url: 'https://x.test/d', classification: 'vendor_documentation', relevant: true,
      quotes: ['q'], contradictsStory: 'the story assumes an argument that does not exist',
    }]);
    expect(block.indexOf('CONTRADICT')).toBeLessThan(block.indexOf('REFERENCED DOCUMENTATION'));
  });

  it('with NO grant the same chain yields no quote — proving the grant is what does the work', async () => {
    const { docs } = await runChain({ TICKET_LINK_ALLOWED_TOOLS: 'read_file,search' });
    expect(docs[0].quotes).toEqual([]);
    expect(
      require(SPEC).referencedDocsBlock(docs),
      'without a fetch tool the step still reports a relevant link but can say nothing about it',
    ).not.toContain('7Q4X-ZL91');
  });
});

describe('the real fetch tool can read that page (the tool the grant names)', () => {
  it('fetch_url returns the buried sentence as text, not markup', async () => {
    const { FetchUrlTool } = await import('../../src/tools/builtin/FetchUrl');
    const r = await new FetchUrlTool().execute({ url: `${base}${LINK_URL_PATH}` });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('7Q4X-ZL91');
    expect(r.content, 'markup ate the budget').not.toMatch(/<script|<nav/);
  });
});

describe('ai-run.sh — the receiver — honours the grant it is handed', () => {
  /** A stub `epam` that records the argv ai-run.sh really passes it. */
  function stubEpam(dir: string): string {
    const argv = join(dir, 'epam-argv.txt');
    const bin = join(dir, 'epam');
    writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argv)}\n` +
      `echo '{"result":"<TICKET_LINKS>{\\"links\\":[]}</TICKET_LINKS>","total_cost_usd":0}'\n`);
    chmodSync(bin, 0o755);
    return argv;
  }

  function runAiRun(env: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'airun-')); cleanup.push(dir);
    const argv = stubEpam(dir);
    const promptFile = join(dir, 'p.txt');
    writeFileSync(promptFile, 'hello');
    spawnSync('bash', [join(ROOT, 'orchestrations/scripts/ai-run.sh'), '--provider', 'openrouter'], {
      input: 'hello', encoding: 'utf8',
      env: { ...process.env, EPAM_CLI: join(dir, 'epam'), PROMPT_FILE: promptFile, ...env },
    });
    try { return readFileSync(argv, 'utf8'); } catch { return ''; }
  }

  it('without the switch it forces --no-tools (so a tool list alone is inert)', () => {
    const argv = runAiRun({ AI_GATE_ALLOW_TOOLS: '0', EPAM_ALLOWED_TOOLS: 'fetch_url' });
    expect(argv, 'ai-run.sh never ran — this test proves nothing').not.toBe('');
    expect(argv).toContain('--no-tools');
  });

  it('with the switch it does NOT pass --no-tools', () => {
    const argv = runAiRun({ AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'fetch_url' });
    expect(argv).not.toBe('');
    expect(
      argv,
      'the grant reached ai-run.sh and ai-run.sh disarmed it anyway — the agent still cannot fetch',
    ).not.toContain('--no-tools');
  });
});

/**
 * STRUCTURED OUTPUT IS ENFORCED AT THE PROVIDER, NOT ASKED FOR IN THE PROMPT.
 *
 * Three live runs on 2026-08-06, three different answer shapes, none of them the declared
 * one — tool-name-keyed JSON, prose-then-JSON, then pure markdown. Each time the agent had
 * fetched both vendor pages and found the contradiction; each time the answer was discarded.
 * The prompt said "Structured output only; do not answer in prose", which is a request.
 *
 * `EPAM_RESPONSE_SCHEMA` binds the model's output space at the provider (verified honoured
 * on the models this pipeline uses). It existed and was wired to exactly one caller. These
 * agents pass a JSON Schema to runAgentForJson already — the same schema must reach the
 * provider instead of being restated in English.
 */
describe('the link agent’s answer shape is enforced, not requested', () => {
  it('the tool’s own schema is handed to the provider', async () => {
    const { runner } = await runChain({});
    const env = JSON.parse(readFileSync(runner.envFile, 'utf8'));
    expect(
      env.EPAM_RESPONSE_SCHEMA,
      'the agent was asked for a shape in prose and was free to decline — it did, three runs running',
    ).toBeTruthy();
    const bound = JSON.parse(env.EPAM_RESPONSE_SCHEMA);
    expect(bound.name).toBeTruthy();
    expect(bound.schema, 'no schema was bound').toBeTruthy();
    // It must be the SAME contract the tool declares, not a second copy that can drift.
    const spec = require('../../orchestrations/scripts/spec-mode-runner.js');
    expect(bound.schema).toEqual(spec.TOOL_DEFINITIONS.TOOL_TICKET_LINKS.parameters);
  });

  it('the fetch grant survives alongside the binding', async () => {
    const { runner } = await runChain({});
    const env = JSON.parse(readFileSync(runner.envFile, 'utf8'));
    expect(env.EPAM_ALLOWED_TOOLS).toContain('fetch_url');
    expect(env.AI_GATE_ALLOW_TOOLS).toBe('1');
  });
});
