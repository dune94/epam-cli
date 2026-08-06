/**
 * THE AGENT DID THE WORK AND THE PIPELINE THREW IT AWAY.
 *
 * Live 2026-08-06, metrolinx, all three lanes. The ticket-link agent fetched both vendor
 * documentation pages linked from Jira comments, quoted their code verbatim, judged that the
 * guide targets CSR + App Router (so following it literally would be wrong on a Pages Router
 * codeline), and found that the ticket's own comment — "no code changes are needed and its
 * more of configure and use" — is contradicted by the vendor's own implementation guide.
 *
 * All of it was discarded. `reviewTicketLinks` read `payload.links`, and the model had keyed
 * its answer under the TOOL'S OWN NAME with its own field vocabulary:
 *
 *     {"submit_ticket_links": {"links":[{ relevance: "relevant",
 *                                         document_scope: "...",
 *                                         key_findings: [{topic, quote, note}],
 *                                         contradictions_with_ticket: [{ticket_says, ...}] }]}}
 *
 * versus the declared  {links:[{url, classification, relevant, quotes, scopeCaveat,
 * contradictsStory}]}.
 *
 * Nothing was wrong with the reasoning. The pipeline lost a genuine finding — one it could
 * not have reached on its own — over field names. The schema stays the contract for what the
 * agent is ASKED to produce; the reader coming back in has to be tolerant, because a model
 * that answers well in its own words is not a failure.
 *
 * The first case below is the real answer, reproduced from
 * orchestrations/logs/lanes/nextmetrolinxcom/AMSD-2041-ticket-links.log.
 */
import { describe, it, expect, afterAll } from 'vitest';

const { normaliseTicketLinks } = require('../../../orchestrations/scripts/spec-mode-runner.js');

/** Verbatim shape and content from the live run. */
const LIVE_ANSWER = {
  submit_ticket_links: {
    story_key: '[GO, UP, MX] Live Preview of Content in CMS',
    links: [{
      url: 'https://www.contentstack.com/docs/headless-cms/live-preview-implementation-for-nextjs-csr-app-router',
      classification: 'vendor_documentation',
      relevance: 'relevant',
      fetch_status: 'fetched',
      document_scope: "This guide targets Next.js using Client-Side Rendering (CSR) with the App Router. If the codeline uses Pages Router or SSR/SSG, this guide's architecture does not match.",
      key_findings: [
        { topic: 'work_is_code_and_configuration', quote: 'npm install @contentstack/live-preview-utils@contentstack/utils', note: 'this is a code change, not pure configuration.' },
        { topic: 'onEntryChange_callback_takes_a_function_argument', quote: 'React.useEffect(() => {\n  onEntryChange(updateData);\n}, []);', note: 'onEntryChange() takes a callback function as its argument.' },
      ],
      contradictions_with_ticket: [{
        ticket_says: "NandaKumar KR: 'no code changes are needed and its more of configure and use.'",
        document_says: 'npm install @contentstack/live-preview-utils ... onEntryChange(updateData)',
        explanation: "The vendor's own guide shows code changes are definitively needed.",
      }],
    }],
  },
};

describe('the live answer that was thrown away', () => {
  const [link] = normaliseTicketLinks(LIVE_ANSWER);

  it('is recovered at all', () => {
    expect(link, 'the payload was keyed under the tool name, so payload.links was undefined').toBeTruthy();
    expect(link.url).toContain('live-preview-implementation-for-nextjs-csr-app-router');
  });

  it('keeps the verbatim quotes — the entire point of the step', () => {
    expect(link.quotes.length).toBe(2);
    expect(link.quotes.join('\n')).toContain('npm install @contentstack/live-preview-utils');
    expect(link.quotes.join('\n')).toContain('onEntryChange(updateData)');
  });

  it('keeps the scope caveat, which says following the doc literally could be wrong', () => {
    expect(link.scopeCaveat).toContain('Pages Router');
  });

  it('keeps the contradiction — the finding the pipeline could not reach alone', () => {
    expect(link.contradictsStory).toContain('no code changes are needed');
    expect(link.contradictsStory).toContain('code changes are definitively needed');
  });

  it('reads "relevance": "relevant" as relevant, not as a missing boolean', () => {
    expect(link.relevant).toBe(true);
  });
});

describe('the declared shape still works exactly as before', () => {
  it('the schema shape passes through untouched', () => {
    const [l] = normaliseTicketLinks({
      links: [{
        url: 'https://a.test/d', classification: 'vendor_documentation', relevant: true,
        reason: 'states the contract', quotes: ['q1'], scopeCaveat: 'sc', contradictsStory: 'cs',
        fetchStatus: 'fetched',
      }],
    });
    expect(l).toEqual({
      url: 'https://a.test/d', classification: 'vendor_documentation', relevant: true,
      reason: 'states the contract', quotes: ['q1'], scopeCaveat: 'sc', contradictsStory: 'cs',
      fetchStatus: 'fetched',
    });
  });
});

describe('tolerance does not become invention', () => {
  it('a link with no URL is dropped — there is nothing to reference', () => {
    expect(normaliseTicketLinks({ links: [{ classification: 'unknown', relevant: true }] })).toEqual([]);
  });

  it('an explicit "not relevant" is honoured', () => {
    const [l] = normaliseTicketLinks({ links: [{ url: 'https://x.test', relevance: 'not relevant' }] });
    expect(l.relevant).toBe(false);
  });

  it('a missing verdict is not read as a denial — it was returned at all', () => {
    const [l] = normaliseTicketLinks({ links: [{ url: 'https://x.test' }] });
    expect(l.relevant).toBe(true);
    expect(l.classification).toBe('unknown');
  });

  it('no quotes stays empty rather than being filled with a paraphrase', () => {
    const [l] = normaliseTicketLinks({ links: [{ url: 'https://x.test', note: 'seems relevant' }] });
    expect(l.quotes).toEqual([]);
  });

  it('junk yields nothing', () => {
    expect(normaliseTicketLinks(null)).toEqual([]);
    expect(normaliseTicketLinks('prose')).toEqual([]);
    expect(normaliseTicketLinks({})).toEqual([]);
    expect(normaliseTicketLinks({ links: 'not an array' })).toEqual([]);
  });
});

describe('other wrappers models have used', () => {
  it('a bare array of links', () => {
    const [l] = normaliseTicketLinks([{ url: 'https://b.test', quotes: ['q'] }]);
    expect(l.url).toBe('https://b.test');
  });

  it('"documents" instead of "links"', () => {
    const [l] = normaliseTicketLinks({ documents: [{ link: 'https://c.test' }] });
    expect(l.url).toBe('https://c.test');
  });

  it('a contradiction given as a plain sentence', () => {
    const [l] = normaliseTicketLinks({ links: [{ url: 'https://d.test', contradiction: 'the story assumes X' }] });
    expect(l.contradictsStory).toBe('the story assumes X');
  });
});

/**
 * AND THE CALL SITE MUST USE IT.
 *
 * The tests above exercise normaliseTicketLinks directly. That is not enough: mutation-testing
 * the call site (restoring `payload.links` in reviewTicketLinks) left every one of them green,
 * because none of them went through reviewTicketLinks at all. A tolerant reader nothing calls
 * is the same as no reader — and "tested the caller, not the receiver" is precisely the mistake
 * that let the AC gate destroy the ticket earlier today.
 *
 * So this drives the REAL reviewTicketLinks with a stub runner that answers in the shape the
 * live run actually produced.
 */
describe('reviewTicketLinks itself recovers the live shape', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');

  const tmp: string[] = [];
  afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

  it('the agent\'s own vocabulary survives the whole function', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'linkshape-')); tmp.push(dir);
    mkdirSync(join(dir, 'logs'), { recursive: true });
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'profiles.json'), JSON.stringify({ 'ticket-link-agent': 'persona' }));

    const runner = join(dir, 'run.sh');
    writeFileSync(runner, `#!/usr/bin/env bash\ncat <<'ANSWER'\n${JSON.stringify(LIVE_ANSWER)}\nANSWER\n`);
    chmodSync(runner, 0o755);

    const prev = process.env.SPEC_MODE_PROVIDER;
    delete process.env.SPEC_MODE_PROVIDER;
    try {
      const docs = await spec.reviewTicketLinks({
        promptExec: { cmd: runner, args: [] },
        story: {
          id: 'T-1', title: 't', description: 'd',
          ticketLinks: [{ url: 'https://www.contentstack.com/docs/x', context: 'c', author: 'a' }],
          ticketComments: [],
        },
        logDir: join(dir, 'logs'),
      });
      expect(docs.length, 'reviewTicketLinks still reads payload.links and drops the answer').toBe(1);
      expect(docs[0].quotes.join('\n')).toContain('onEntryChange(updateData)');
      expect(docs[0].contradictsStory).toContain('no code changes are needed');
    } finally {
      if (prev === undefined) delete process.env.SPEC_MODE_PROVIDER; else process.env.SPEC_MODE_PROVIDER = prev;
    }
  }, 60000);
});

/**
 * A BOUND SHAPE IS NOT BOUND CONTENT.
 *
 * Live 2026-08-06, fifth attempt, with EPAM_RESPONSE_SCHEMA bound at the provider for the
 * first time. The answer was finally the declared shape — and 371 bytes of nothing:
 *
 *   {"links":[{"classification":"vendor_documentation","relevant":true,"url":"…csr-app-router"},
 *             {"classification":"vendor_documentation","relevant":true,"url":"…custom-preview-urls"}]}
 *
 * No quote. No scope caveat. No contradiction. The four previous runs, unbound, returned
 * 8,000+ bytes carrying the SDK install line, the onEntryChange(updateData) signature, the
 * CSR/App-Router warning and the refutation of the ticket's own "no code changes are needed"
 * comment. Binding the shape made the content collapse.
 *
 * The schema was the cause. `required` listed url, classification and relevant — and nothing
 * else. quotes, scopeCaveat and contradictsStory were OPTIONAL, so a strict binding let the
 * model satisfy the contract completely while saying nothing. It answered the minimum,
 * legally. Two URLs we already had, restated.
 *
 * "A schema-bound reply with no document read is a confident empty answer, which is worse
 * than a parse failure because nothing looks wrong" — written when the binding was built,
 * and then demonstrated.
 *
 * So the EVIDENCE becomes required: a link must say whether it could be opened, and one it
 * opened must quote it. A link it could not open has to declare that, rather than returning
 * a bare classification that reads identically to a successful review.
 */
describe('the schema demands evidence, not just structure', () => {
  const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
  const item = spec.TOOL_DEFINITIONS.TOOL_TICKET_LINKS.parameters.properties.links.items;

  it('THE GAP: a link must state whether it was actually fetched', () => {
    expect(
      item.properties.fetchStatus,
      'nothing distinguishes "I read it and it says nothing relevant" from "I never opened it"',
    ).toBeTruthy();
    expect(item.properties.fetchStatus.enum).toContain('fetched');
    expect(item.required || []).toContain('fetchStatus');
  });

  it('THE GAP: quotes are required, so the minimum answer carries evidence', () => {
    expect(
      item.required || [],
      'quotes were optional, so a bound answer legally returned two URLs and nothing else',
    ).toContain('quotes');
    expect(item.properties.quotes.minItems, 'an empty array satisfies "required"').toBeGreaterThan(0);
  });

  it('the fields that were already required stay required', () => {
    for (const f of ['url', 'classification', 'relevant']) expect(item.required).toContain(f);
  });

  it('the binding handed to the provider carries the tightened contract', () => {
    const bound = JSON.parse(spec.schemaEnv(spec.TOOL_DEFINITIONS.TOOL_TICKET_LINKS));
    const boundItem = bound.schema.properties.links.items;
    expect(boundItem.required).toContain('quotes');
    expect(boundItem.required).toContain('fetchStatus');
  });

  it('the reader keeps a fetch status the agent reports', () => {
    const [l] = spec.normaliseTicketLinks({
      links: [{ url: 'https://x.test', fetchStatus: 'unreachable', quotes: [], classification: 'vendor_documentation', relevant: true }],
    });
    expect(l.fetchStatus, 'the honest "I could not open it" is dropped on the way in').toBe('unreachable');
  });

  it('an answer that quotes nothing is still readable — the reader never invents', () => {
    // The schema makes this hard to produce; the reader must not paper over it if it happens.
    const [l] = spec.normaliseTicketLinks({ links: [{ url: 'https://x.test', quotes: [] }] });
    expect(l.quotes).toEqual([]);
  });
});
