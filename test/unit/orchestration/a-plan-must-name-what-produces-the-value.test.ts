/**
 * A PLAN THAT WIRES A SIGNAL AND NEVER FETCHES ANYTHING IS NOT A PLAN.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * AMSD-2041, live. The prescription said, of the provider:
 *
 *     "triggering a re-render that relies on the SDK's internal state update rather than a
 *      callback parameter"
 *
 * The writer implemented exactly that: a counter that increments, a context that re-memoises,
 * a component tree that re-renders. All of it correct, none of it useful — the value being
 * rendered was still the one fetched on the server at page load. NOTHING IN THE PLAN CAUSED
 * NEW DATA TO EXIST. Across all fifteen fix sites: refetch 0, getEntry 0, setContent 0.
 *
 * It was not a writer failure and not a review failure. Both did what they were asked. The plan
 * described the delivery of a value it never obtained, and no gate could tell — the coverage
 * check scored it "complete", because that check asks whether the fix sites mention the same
 * WORDS as the criteria, and they did.
 *
 * The second gap, from the same prescription: it told the writer to call the SDK's
 * `onEntryChange` — a browser-only subscription — inside getStaticProps/getServerSideProps,
 * which run on the server. Unbuildable as written. The prompt had no notion of where code runs,
 * so nothing could notice.
 *
 * THE RULE, and it must be a FIELD, not prose: every site declares what it does to the value —
 * produces it, carries it, or only verifies — and where it runs. A prescription in which
 * nothing PRODUCES is underspecified, and says so in a field the pipeline reads. The prompt's
 * own words: "Saying it in the fix prose is not enough; nothing reads prose."
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/code-graph-detective.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require(join(ROOT, 'orchestrations/scripts/lib/prompt-library.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));

const PROMPT = () => lib.buildPrompt(
  'code-graph-detective',
  join(ROOT, 'orchestrations/projects/metrolinx'),
  {
    __DETECTIVE_PROFILE__: '', __REPO_PATH__: '/REPO', __TOOL_PATH__: '/TOOL',
    __STORY_TITLE__: 'T', __STORY_DESCRIPTION__: '', __STORY_ACS__: '- AC',
    __KIND_AND_CORRECTIVE_CONTEXT__: '', __PRESEED_BLOCK__: '', __PRESCRIPTION_RULES__: '',
  },
);

describe('THE PROMPT ASKS FOR IT', () => {
  it('demands each site declare what it does to the value', () => {
    expect(PROMPT(), 'nothing asks which change makes the new value exist')
      .toMatch(/deliveryRole/);
  });

  it('spells out that a signal is not a value', () => {
    // The exact confusion that produced the defect: reacting to a change is not obtaining one.
    expect(PROMPT()).toMatch(/produces|carries/i);
  });

  it('demands each site declare where it runs', () => {
    expect(PROMPT(), 'nothing asks whether a change runs on the server or in the browser')
      .toMatch(/runsIn/);
  });

  it('both are in the JSON contract, not only in the prose', () => {
    // A rule with no field behind it gets ignored; the prompt says so itself. The two rules
    // that actually hold today — changeRequired and requiredPackages — are the two with fields.
    const contract = PROMPT().slice(PROMPT().lastIndexOf('[{"file"'));
    expect(contract, 'deliveryRole is prose only').toMatch(/deliveryRole/);
    expect(contract, 'runsIn is prose only').toMatch(/runsIn/);
  });

  it('stays generic — no framework, no stack, no client', () => {
    // Under the target design this template guides a prompt-builder for EVERY project. "name
    // the fetch that reaches the provider" would be a React fact; the rule has to hold for a
    // queue consumer or a SQL read too.
    const t = readFileSync(TEMPLATE, 'utf8').toLowerCase();
    // 'provider'/'consumer' are plain English in the existing prose ("a consumer that reads
    // state from a provider you are fixing") — generic, not a framework fact. The list is the
    // things that would be WRONG for another project.
    // Word-boundary, not substring: the rules legitimately say "reacting to a change is not
    // obtaining one", and "react" inside "reacting" is English, not the framework.
    for (const leak of ['react', 'usestate', 'getstaticprops', 'contentstack', 'next\\.js',
      'metrolinx', 'gotransit', 'jest\\.config', 'tsx']) {
      expect(t, `'${leak}' is a stack fact in a generic template`)
        .not.toMatch(new RegExp(`\\b${leak}\\b`));
    }
  });
});

describe('THE PARSER CARRIES THEM — a field it drops is a field the model answered for nothing', () => {
  // This exact defect already happened here: "TWO FIELDS THE PROMPT CALLS REQUIRED AND THIS
  // PARSER THREW AWAY" — changeRequired and requiredPackages were asked for, answered, and
  // discarded forty lines later, which is why every site in the restored prescription has
  // changeRequired absent.
  const parse = (h: any) => {
    const out = spec.parseDetectiveFindings
      ? spec.parseDetectiveFindings(JSON.stringify([h]), '/nonexistent')
      : null;
    expect(out, 'spec-mode-runner exposes no way to parse a detective answer').not.toBeNull();
    return (out as any[])[0];
  };

  it('deliveryRole survives parsing', () => {
    expect(parse({ file: 'a.ts', reason: 'r', fix: 'f', deliveryRole: 'produces' }).deliveryRole)
      .toBe('produces');
  });

  it('runsIn survives parsing', () => {
    expect(parse({ file: 'a.ts', reason: 'r', fix: 'f', runsIn: 'browser' }).runsIn)
      .toBe('browser');
  });

  it('an absent value is absent, not invented', () => {
    // Absent must never be silently filled: "not stated" and "produces" are different claims,
    // and collapsing them is how a plan with no source of data looked complete.
    const p = parse({ file: 'a.ts', reason: 'r', fix: 'f' });
    expect(p.deliveryRole === undefined || p.deliveryRole === '').toBe(true);
  });
});

describe('A PRESCRIPTION WHERE NOTHING PRODUCES IS UNDERSPECIFIED', () => {
  const flag = (sites: any[]) => spec.prescriptionMissingSource
    ? spec.prescriptionMissingSource(sites)
    : null;

  it('the check exists', () => {
    expect(typeof spec.prescriptionMissingSource,
      'nothing asks whether the plan obtains the value it promises to deliver')
      .toBe('function');
  });

  it('THE LIVE SHAPE: every site carries or verifies, none produces', () => {
    expect(flag([
      { file: 'ctx.tsx', changeRequired: true, deliveryRole: 'carries' },
      { file: 'app.tsx', changeRequired: true, deliveryRole: 'carries' },
      { file: 'hook.ts', changeRequired: false, deliveryRole: 'verifies' },
    ]), 'a plan that never obtains the value was accepted').toBe(true);
  });

  it('a plan with a producer is fine', () => {
    expect(flag([
      { file: 'svc.ts', changeRequired: true, deliveryRole: 'produces' },
      { file: 'ctx.tsx', changeRequired: true, deliveryRole: 'carries' },
    ])).toBe(false);
  });

  it('UNSTATED IS NOT SATISFIED — the field being absent does not pass the check', () => {
    // Fail closed. "I could not tell" must never read as "fine", which is the shape of nearly
    // every defect this pipeline has produced.
    expect(flag([{ file: 'a.ts', changeRequired: true }]),
      'a prescription that declared nothing was treated as having a source').toBe(true);
  });
});
