/**
 * A deterministic guard may hold NO content of its own.
 *
 * WHAT WAS WRONG
 * --------------
 * Every guard encoded its checks as a literal list in engine code, each reverse-engineered
 * from one past incident:
 *
 *   VC_MECHANISM_PATTERNS      6 regexes from 5 sentences in a fare-discount bug, carrying
 *                              client-domain nouns (segment, leg, line-item)
 *   VC_OBSERVABILITY_RULES     the same 5 sentences again, as prose examples
 *   vc-guard-and-loop.test.ts  the same 5 sentences again, as the test FIXTURE — which is
 *                              why the guard could never fail and nobody noticed
 *   PRESCRIPTIVE_AC_PATTERNS   11 regexes naming specific JS test libraries
 *
 * Live consequence: two verification criteria that plainly prescribe mechanism —
 * "the SDK is initialized and its onEntryChange callback is registered" and "the
 * initialization call includes the correct stack details" — passed a guard whose entire
 * vocabulary was about splitting and halving. The run log reported the guard clean.
 *
 * THE PROPERTY THESE TESTS LOCK
 * -----------------------------
 * The applier is pure: give it a vocabulary and it flags accordingly; give it a DIFFERENT
 * vocabulary and its behaviour changes completely. It cannot flag anything on its own,
 * because it knows nothing on its own.
 *
 * Crucially these tests use vocabularies from domains the code was never built for. A test
 * that feeds a guard the terms its own patterns were derived from proves only that the
 * incident is remembered — that is exactly the test that hid this for months.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gv = require('../../../orchestrations/scripts/lib/guard-vocabulary.js');

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/lib/guard-vocabulary.js'), 'utf8');

/** A vocabulary from a domain nothing in this repo was built around. */
const AUTH_VOCAB = {
  blacklist: [
    { term: 'bcrypt', reason: 'names the hashing implementation', kind: 'implementation_noun' },
    { term: 'is hashed', reason: 'describes how the value is produced', kind: 'construction_verb' },
    { term: 'session table', reason: 'an internal structure feeding the surface', kind: 'internal_structure' },
  ],
  whitelist: [{ term: 'sign-in page' }, { term: 'error message' }],
};

describe('the applier holds no content of its own', () => {
  it('flags nothing when handed an empty vocabulary — it cannot invent a rule', () => {
    expect(gv.applyVocabulary(
      ['The password is hashed with bcrypt before the session table is written'],
      { blacklist: [], whitelist: [] },
    )).toEqual([]);
  });

  it('flags a violation from a domain this code was never built for', () => {
    const flagged = gv.applyVocabulary(
      ['The password is hashed with bcrypt before the row is written'],
      AUTH_VOCAB,
    );
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged[0].reason).toMatch(/hashing implementation|how the value is produced/);
  });

  it('the SAME statement is clean under a vocabulary that does not name it', () => {
    // Proof the behaviour comes from the vocabulary, not from the module.
    expect(gv.applyVocabulary(
      ['The password is hashed with bcrypt'],
      { blacklist: [{ term: 'invoice total', reason: 'x' }], whitelist: [] },
    )).toEqual([]);
  });

  it('THE LIVE MISS: the real VCs that slipped through are caught by a derived vocabulary', () => {
    const realVcs = [
      'When the application is loaded with Live Preview enabled, the SDK is initialized and its onEntryChange callback is registered before any content is rendered.',
      'Given the client is mocked, the initialization call includes the correct stack details (stack API key, environment, and host configuration).',
      'When the application is loaded without Live Preview enabled, pages load and display exactly as they do today.',
    ];
    const derived = {
      blacklist: [
        { term: 'onentrychange', reason: 'names the SDK entry point', kind: 'implementation_noun' },
        { term: 'is initialized', reason: 'describes how the behaviour is set up', kind: 'construction_verb' },
        { term: 'the initialization call includes', reason: 'asserts on an internal call', kind: 'internal_structure' },
      ],
      whitelist: [{ term: 'pages load and display' }],
    };
    const flagged = gv.applyVocabulary(realVcs, derived);
    expect(flagged.length, 'the two prescriptive VCs were not caught').toBe(2);
    expect(flagged.map((f: any) => f.item).join(' ')).not.toMatch(/exactly as they do today/);
  });
});

describe('whitelist wins — the observable surface is never flagged', () => {
  it('a statement naming the observable surface survives a blacklisted word', () => {
    expect(gv.applyVocabulary(
      ['The sign-in page shows an error message when bcrypt rejects the password'],
      AUTH_VOCAB,
    ), 'the observable surface was flagged as mechanism').toEqual([]);
  });
});

describe('matching is whole-term — a guard nobody trusts is a guard nobody reads', () => {
  it('does not fire on a substring of an unrelated word', () => {
    expect(gv.applyVocabulary(
      ['The user selects a subscription plan'],
      { blacklist: [{ term: 'script', reason: 'x' }], whitelist: [] },
    ), '"script" matched inside "subscription"').toEqual([]);
  });

  it('matches across punctuation boundaries', () => {
    expect(gv.applyVocabulary(
      ['Calls onEntryChange(), then re-renders.'],
      { blacklist: [{ term: 'onentrychange', reason: 'x' }], whitelist: [] },
    ).length).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(gv.applyVocabulary(
      ['The SDK is INITIALIZED at boot'],
      { blacklist: [{ term: 'is initialized', reason: 'x' }], whitelist: [] },
    ).length).toBe(1);
  });
});

describe('a failed derivation must never look like a clean result', () => {
  it('isVocabularyUsable is false for an empty or malformed vocabulary', () => {
    expect(gv.isVocabularyUsable(null)).toBe(false);
    expect(gv.isVocabularyUsable({})).toBe(false);
    expect(gv.isVocabularyUsable({ blacklist: [] })).toBe(false);
  });

  it('isVocabularyUsable is true once terms exist', () => {
    expect(gv.isVocabularyUsable(AUTH_VOCAB)).toBe(true);
  });
});

describe('normaliseVocabulary — a malformed payload cannot corrupt the guard', () => {
  it('drops entries with no term, and lowercases/trims the rest', () => {
    const v = gv.normaliseVocabulary({
      blacklist: [{ term: '  Bcrypt  ', reason: 'r' }, { reason: 'no term' }, { term: '' }],
      whitelist: [{ term: 'Sign-In Page' }],
    });
    expect(v.blacklist).toEqual([{ term: 'bcrypt', reason: 'r' }]);
    expect(v.whitelist).toEqual([{ term: 'sign-in page', reason: '' }]);
  });

  it('dedupes repeated terms', () => {
    const v = gv.normaliseVocabulary({
      blacklist: [{ term: 'a', reason: '1' }, { term: 'A', reason: '2' }], whitelist: [],
    });
    expect(v.blacklist.length).toBe(1);
  });

  it('a non-object payload yields empty lists rather than throwing', () => {
    expect(gv.normaliseVocabulary('nonsense')).toEqual({ blacklist: [], whitelist: [] });
    expect(gv.normaliseVocabulary(undefined)).toEqual({ blacklist: [], whitelist: [] });
  });
});

describe('the module itself contains no hardcoded vocabulary', () => {
  it('names no client, product, vendor or industry noun', () => {
    expect(SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'))
      .not.toMatch(/metrolinx|gotransit|upexpress|contentstack|mozio|segment|line[- ]?item/i);
  });

  it('declares no term list, pattern list or stopword set', () => {
    const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code, 'a literal list of terms is the defect this module exists to remove')
      .not.toMatch(/(PATTERNS|STOPWORDS|KEYWORDS|VOCAB\w*)\s*=\s*(\[|new Set)/);
  });

  it('the schema forbids prose — the agent must fill a structured shape', () => {
    expect(gv.TOOL_GUARD_VOCABULARY.parameters.required).toEqual(['blacklist', 'whitelist']);
    const bl = gv.TOOL_GUARD_VOCABULARY.parameters.properties.blacklist;
    expect(bl.items.required).toEqual(expect.arrayContaining(['term', 'reason']));
  });
});

/**
 * THE GUARD AGENT'S ANSWER IS SHAPE-BOUND AT THE PROVIDER.
 *
 * Live 2026-08-06: this agent answered `submit_guard_vocabulary\n{...}` and `<tool_call>…`.
 * Neither parsed, so `isVocabularyUsable` said no, and the guards — correctly refusing to run
 * unarmed — aborted the specification pass on every lane:
 *
 *   openspec run failed: VC guard could not be armed … Refusing to proceed.
 *   speckit review failed: AC guard could not be armed … Refusing to proceed.
 *   [ERROR] Step 1: Specification pass FAILED for 'core'
 *
 * A whole run was lost to answer formatting. The prompt asked for the shape in English; now
 * the provider binds it, from the SAME tool definition the agent is asked for — one object,
 * so the request and the enforcement cannot drift apart.
 */
describe('the vocabulary agent is bound to its own tool schema', () => {
  const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');

  it('the binding is the tool definition itself, not a second copy', () => {
    const bound = JSON.parse(spec.schemaEnv(spec.TOOL_DEFINITIONS.TOOL_GUARD_VOCABULARY));
    expect(bound.name).toBe(spec.TOOL_DEFINITIONS.TOOL_GUARD_VOCABULARY.name);
    expect(bound.schema).toEqual(spec.TOOL_DEFINITIONS.TOOL_GUARD_VOCABULARY.parameters);
  });

  it('the bound schema still requires both lists — an empty guard is the original defect', () => {
    const bound = JSON.parse(spec.schemaEnv(spec.TOOL_DEFINITIONS.TOOL_GUARD_VOCABULARY));
    expect(bound.schema.required).toContain('blacklist');
    expect(bound.schema.required).toContain('whitelist');
  });

  it('deriveGuardVocabulary hands that schema to the runner', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } = require('node:fs');
    const { join } = require('node:path');
    const { tmpdir } = require('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'vocabbind-'));
    try {
      const envFile = join(dir, 'env.json');
      const capture = join(dir, 'capture.js');
      writeFileSync(capture,
        `require('fs').writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));\n` +
        `process.stdout.write('<GUARD_VOCABULARY>{"blacklist":[{"term":"x","reason":"r"}],"whitelist":[]}</GUARD_VOCABULARY>');\n`);
      const runner = join(dir, 'run.sh');
      writeFileSync(runner, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(capture)}\n`);
      chmodSync(runner, 0o755);
      const prev = process.env.SPEC_MODE_PROVIDER;
      delete process.env.SPEC_MODE_PROVIDER;
      try {
        await spec.deriveGuardVocabulary({
          promptExec: { cmd: runner, args: [] },
          rule: 'a rule', statements: ['a statement'],
          story: { id: 'T-1', title: 't', description: 'd' },
          findings: [], manifestFiles: [], logDir: dir, seam: 'test',
        });
      } finally {
        if (prev === undefined) delete process.env.SPEC_MODE_PROVIDER; else process.env.SPEC_MODE_PROVIDER = prev;
      }
      const env = JSON.parse(readFileSync(envFile, 'utf8'));
      expect(
        env.EPAM_RESPONSE_SCHEMA,
        'the agent was asked for a shape in prose — it answered with a bare tool name and lost a run',
      ).toBeTruthy();
      expect(JSON.parse(env.EPAM_RESPONSE_SCHEMA).name).toBe('submit_guard_vocabulary');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

/**
 * A CONTRACT THE VENDOR PUBLISHES IS NOT AN IMPLEMENTATION DETAIL.
 *
 * The VC guard strips criteria that name a MECHANISM — the right rule when the mechanism is
 * an implementation choice the team is free to make differently.
 *
 * But on 2026-08-07, run 20260807T000054Z, it deleted the three best criteria on the story,
 * and all three came straight from the vendor documentation the pipeline had just fetched:
 *
 *   "Given the Live Preview SDK is mocked to invoke the registered onEntryChange callback,
 *    when onEntryChange fires, the ContentstackContext.Provider ..."
 *   "The onEntryChange callback is registered exactly once during the provider's lifecycle
 *    (not on every render), and it triggers a data refresh"
 *   "... onEntryChange fires for a page that requires authentication, the application does
 *    not throw"
 *
 * Those are the sharpest and most testable checks the run produced, and they are observable:
 * `onEntryChange` is the vendor's published callback, quoted verbatim in their guide. It is
 * not something this team chose and could change.
 *
 * So the better the documentation grounding gets, the more the guard deletes — because
 * documentation content IS mechanism. A term the ticket's own documentation states is
 * whitelisted: the applier already lets the whitelist win, and the terms are DERIVED from the
 * fetched documents rather than written down anywhere.
 */
describe('terms the ticket’s documentation states are not treated as implementation detail', () => {
  const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
  const { applyVocabulary } = require('../../../orchestrations/scripts/lib/guard-vocabulary.js');

  const DOCS = [{
    url: 'https://vendor.test/docs/live-preview',
    fetchStatus: 'fetched',
    quotes: [
      'React.useEffect(() => { onEntryChange(updateData); }, []);',
      "live_preview: { preview_token: preview_token, enable: true, host: 'rest-preview.contentstack.com' }",
    ],
  }];

  const VC = 'When onEntryChange fires, the previewed page displays the updated draft entry.';
  const BLACKLIST = { blacklist: [{ term: 'onEntryChange', reason: 'names a mechanism' }], whitelist: [] };

  it('the fixture is real — without the documents the term IS flagged', () => {
    const flagged = applyVocabulary([VC], BLACKLIST);
    expect(flagged.length, 'the guard no longer flags mechanism at all — this test proves nothing').toBe(1);
  });

  it('THE FIX: a term quoted in the ticket’s documentation is whitelisted', () => {
    const grounded = spec.documentGroundedVocabulary(BLACKLIST, DOCS);
    expect(
      applyVocabulary([VC], grounded),
      'the sharpest criteria on the story were deleted because the vendor’s own callback was called a mechanism',
    ).toEqual([]);
  });

  it('the whitelist entry says WHY, and names the source', () => {
    const grounded = spec.documentGroundedVocabulary(BLACKLIST, DOCS);
    const entry = grounded.whitelist.find((w: any) => w.term === 'onEntryChange');
    expect(entry, 'onEntryChange was not whitelisted').toBeTruthy();
    expect(entry.reason).toMatch(/document|vendor|quoted/i);
    expect(entry.reason).toContain('vendor.test');
  });

  it('a mechanism the documents do NOT mention is still flagged', () => {
    const grounded = spec.documentGroundedVocabulary(
      { blacklist: [{ term: 'useReducer', reason: 'names a mechanism' }], whitelist: [] }, DOCS);
    expect(
      applyVocabulary(['The page uses useReducer to hold draft state.'], grounded),
      'grounding must not become a blanket amnesty',
    ).toHaveLength(1);
  });

  it('prose words in a quote do not become whitelist entries', () => {
    const grounded = spec.documentGroundedVocabulary(
      { blacklist: [{ term: 'displays', reason: 'x' }], whitelist: [] },
      [{ url: 'u', fetchStatus: 'fetched', quotes: ['the page displays the entry'] }]);
    expect(
      grounded.whitelist.map((w: any) => w.term),
      'whitelisting ordinary prose would disarm the guard entirely',
    ).not.toContain('displays');
  });

  it('no documents means the vocabulary is unchanged', () => {
    expect(spec.documentGroundedVocabulary(BLACKLIST, [])).toEqual(BLACKLIST);
    expect(spec.documentGroundedVocabulary(BLACKLIST, null)).toEqual(BLACKLIST);
  });

  it('an unfetched document grounds nothing — it has no verified text', () => {
    const grounded = spec.documentGroundedVocabulary(BLACKLIST,
      [{ url: 'u', fetchStatus: 'unreachable', quotes: ['onEntryChange'] }]);
    expect(grounded.whitelist.map((w: any) => w.term)).not.toContain('onEntryChange');
  });
});
