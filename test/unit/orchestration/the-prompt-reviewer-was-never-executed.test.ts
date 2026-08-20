// THE PROMPT REVIEWER WAS WIRED, SHIPPED, CALLED "FIXED" — AND NEVER EXECUTED BY A TEST.
//
// On 2026-08-18 the one line that turns a false claim into a rejection was disabled by hand:
//
//     if (false && bad.length) return { ok: false, reason: bad.join('; ') };
//
// and the entire guard suite passed — 43 files, 268 tests, green, with the reviewer incapable of
// rejecting anything. The tests asserted the SHAPE around it (the registry mark, the opt-in
// switch, the log line, the placeholder list) and one of them asserted that the string
// "reviewPrompt" appeared in a source file. Nothing rendered its prompt, invoked it, parsed a
// verdict, or checked that a false claim stopped a prompt being installed.
//
// That matters more here than almost anywhere else, because the reviewer FAILS OPEN by design: a
// reviewer that cannot run must not condemn the artefact. So every internal defect — a render
// mismatch, a bad tag, a changed verdict shape — is indistinguishable from approval. With the
// flag on you would see prompts provisioned, no rejections, and conclude review was working. That
// is the same vacuous signal as "raw=0 bytes -> environment crash" and "0 findings" from prose.
//
// It was untestable by construction: an anonymous closure inside a call site. It is now a module
// with injected dependencies, and every path below is executed with a stubbed runner.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { makePromptReviewer } = require(join(ROOT, 'orchestrations/scripts/lib/prompt-review.js'));

const ARTEFACT = { id: 'story-writer', template: { body: 'generic' }, generated: { body: 'specialised' } };

/** A reviewer whose runner returns exactly what the test says, with warnings captured. */
function reviewer(reply: string | Error, opts: { render?: unknown } = {}) {
  const warnings: string[] = [];
  const seen: { prompt?: string } = {};
  const r = makePromptReviewer({
    render: opts.render ?? ((_id: string, _dir: string, vals: Record<string, string>) => {
      if (!vals || !vals.__PROMPT_ID__) throw new Error('values missing __PROMPT_ID__');
      return `REVIEW ${vals.__PROMPT_ID__}`;
    }),
    invoke: async (prompt: string) => {
      seen.prompt = prompt;
      if (reply instanceof Error) throw reply;
      return reply;
    },
    values: ({ id }: { id: string }) => ({ __PROMPT_ID__: id, __GENERATED_BODY__: 'specialised' }),
    warn: (m: string) => warnings.push(m),
    projectConfigDir: '/proj',
  });
  return { review: r, warnings, seen };
}

const verdict = (v: unknown) => `<PROMPT_REVIEW>${JSON.stringify(v)}</PROMPT_REVIEW>`;

describe('the prompt reviewer was never executed', () => {
  it('REJECTS A PROMPT WHOSE CLAIMS ARE FALSE — the reason reaches the caller', async () => {
    const { review } = reviewer(verdict({ falseClaims: ['claims the repo uses a package it does not depend on'] }));
    const out = await review(ARTEFACT);
    expect(out.ok, 'a prompt with false claims about the project was approved').toBe(false);
    expect(out.reason, 'the rejection carries no reason for the regeneration to act on')
      .toMatch(/does not depend on/);
  });

  it('joins multiple false claims so none is lost', async () => {
    const { review } = reviewer(verdict({ falseClaims: ['claim one', 'claim two'] }));
    const out = await review(ARTEFACT);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('claim one');
    expect(out.reason).toContain('claim two');
  });

  it('accepts objects as well as strings, so a richer verdict is not silently dropped', async () => {
    const { review } = reviewer(verdict({ falseClaims: [{ claim: 'invented an API field' }] }));
    const out = await review(ARTEFACT);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('invented an API field');
  });

  it('APPROVES A CLEAN VERDICT — review must not block correct prompts', async () => {
    const { review, warnings } = reviewer(verdict({ falseClaims: [] }));
    expect((await review(ARTEFACT)).ok).toBe(true);
    expect(warnings.join('\n'), 'a clean review warned about something').toBe('');
  });

  it('ACTUALLY RENDERS AND SENDS THE REVIEW PROMPT — not an empty call', async () => {
    const { review, seen } = reviewer(verdict({ falseClaims: [] }));
    await review(ARTEFACT);
    expect(seen.prompt, 'the reviewer invoked the model with nothing').toBeTruthy();
    expect(seen.prompt, 'the prompt does not identify the artefact under review')
      .toContain('story-writer');
  });

  it('FAILS OPEN WHEN IT CANNOT RUN — but SAYS SO', async () => {
    const { review, warnings } = reviewer(new Error('gate unreachable'));
    expect((await review(ARTEFACT)).ok, 'a reviewer failure condemned a prompt it never read').toBe(true);
    expect(warnings.join('\n'), 'the prompt was installed unreviewed and nothing said so')
      .toMatch(/UNREVIEWED/);
  });

  it('FAILS OPEN ON A RENDER MISMATCH — the defect that blinded the failure analyst', async () => {
    const { review, warnings } = reviewer(verdict({ falseClaims: [] }), {
      render: () => { throw new Error("missing values for: __TICKET_BLOCK__"); },
    });
    expect((await review(ARTEFACT)).ok).toBe(true);
    expect(warnings.join('\n'), 'a values/placeholder mismatch passed silently as approval')
      .toMatch(/could not build the reviewer's prompt.*UNREVIEWED/s);
  });

  it('fails open on prose and on invalid JSON, announcing each', async () => {
    const prose = reviewer('I read it and it looks fine to me.');
    expect((await prose.review(ARTEFACT)).ok).toBe(true);
    expect(prose.warnings.join('\n')).toMatch(/no parseable verdict/);

    const broken = reviewer('<PROMPT_REVIEW>{ not json</PROMPT_REVIEW>');
    expect((await broken.review(ARTEFACT)).ok).toBe(true);
    expect(broken.warnings.join('\n')).toMatch(/not valid JSON/);
  });

  it('tolerates a fenced verdict, which models emit routinely', async () => {
    const { review } = reviewer('<PROMPT_REVIEW>```json\n{"falseClaims":["fenced claim"]}\n```</PROMPT_REVIEW>');
    const out = await review(ARTEFACT);
    expect(out.ok, 'a fenced verdict was treated as unparseable and silently approved').toBe(false);
    expect(out.reason).toContain('fenced claim');
  });
});

// THE SEAM: the tests above inject a fake `render`, so they agree with themselves about a
// signature the real library never had. The shipped adapter called `render(id, dir, vals)` against
// `render(doc, values)`. That returns undefined WITHOUT THROWING, so the rendered prompt was
// empty, every review took the fail-open path, and the feature was inert while looking wired.
// A live invocation caught it; 268 green tests did not. These execute the real adapter.
describe('the render adapter, against the real prompt library', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { makePromptRenderer } = require(join(ROOT, 'orchestrations/scripts/lib/prompt-review.js'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const promptsLib = require(join(ROOT, 'orchestrations/scripts/lib/prompt-library.js'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs');

  const REVIEW_ID = 'prompt-review';

  /** Any provisioned project carrying the reviewer's prompt. Discovered, never named. */
  function aProjectWithTheReviewersPrompt(): string | null {
    const projects = join(ROOT, 'orchestrations/projects');
    if (!fs.existsSync(projects)) return null;
    for (const name of fs.readdirSync(projects)) {
      const dir = join(projects, name);
      if (fs.existsSync(promptsLib.projectPromptPath(REVIEW_ID, dir))) return dir;
    }
    return null;
  }

  it('renders a NON-EMPTY prompt carrying both artefacts — the shipped adapter rendered nothing', () => {
    const dir = aProjectWithTheReviewersPrompt();
    expect(dir, 'no project has the reviewer prompt provisioned; this test would pass vacuously').not.toBeNull();

    const doc = promptsLib.loadProjectPrompt(REVIEW_ID, dir);
    // Values come from what the prompt DECLARES, so a template change cannot silently skip one.
    const declared: string[] = doc.placeholders ?? [];
    expect(declared.length, 'the reviewer prompt declares no placeholders').toBeGreaterThan(0);

    const TEMPLATE_MARK = 'ZZ-generic-body-mark';
    const GENERATED_MARK = 'ZZ-specialised-body-mark';
    const values: Record<string, string> = {};
    // Filler must not echo the placeholder name back, or the rendered output looks unrendered.
    for (const p of declared) values[p] = `filler-${p.replace(/_/g, '')}`;
    // The two that must actually reach the model: what was written vs what shipped.
    if ('__TEMPLATE_BODY__' in values) values.__TEMPLATE_BODY__ = TEMPLATE_MARK;
    if ('__GENERATED_BODY__' in values) values.__GENERATED_BODY__ = GENERATED_MARK;

    const render = makePromptRenderer(promptsLib);
    const out = render(REVIEW_ID, dir, values);

    expect(typeof out, 'the adapter returned a non-string — this is the shipped defect').toBe('string');
    expect(out.trim().length, 'the adapter rendered an empty prompt; every review would fail open').toBeGreaterThan(0);
    expect(out, 'the artefact under review never reached the prompt').toContain(GENERATED_MARK);
    expect(out, 'the template it is compared against never reached the prompt').toContain(TEMPLATE_MARK);
    expect(out, 'a placeholder survived unrendered').not.toMatch(/__[A-Z_]+__/);
  });

  it('spends NO model call when the prompt renders empty', async () => {
    let invoked = 0;
    const warnings: string[] = [];
    const review = makePromptReviewer({
      render: () => undefined,          // exactly what the shipped adapter returned
      invoke: async () => { invoked += 1; return '<PROMPT_REVIEW>{"falseClaims":[]}</PROMPT_REVIEW>'; },
      values: () => ({}),
      warn: (m: string) => warnings.push(m),
      projectConfigDir: '/nonexistent',
    });
    const out = await review(ARTEFACT);
    expect(invoked, 'an empty prompt was sent to the model, buying a verdict about nothing').toBe(0);
    expect(out.ok).toBe(true);
    expect(warnings.join('\n'), 'the inert reviewer said nothing').toMatch(/empty prompt.*UNREVIEWED/s);
  });
});

// THE CONTRACT: the parser matches <PROMPT_REVIEW>…</PROMPT_REVIEW> and reads `falseClaims`.
// The template never asked for either. A live invocation on 2026-08-18 confirmed the consequence:
// the model did real falsification work, then delivered it as a write_file payload in its own
// invented shape. No tag, no parse, fail open — every time, for every prompt, however well the
// review went. The prompt is the contract; a validator the prompt never states cannot be met.
describe('the reviewer prompt states the contract its parser enforces', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const promptsLib = require(join(ROOT, 'orchestrations/scripts/lib/prompt-library.js'));

  // Read the tag and the verdict key out of the PARSER, so the test cannot hold a stale copy.
  const parserSrc: string = fs.readFileSync(join(ROOT, 'orchestrations/scripts/lib/prompt-review.js'), 'utf8');
  const TAG = parserSrc.match(/<(\w+)>\(\[\\s\\S\]\*\?\)<\\\/\1>/)?.[1];
  const KEY = parserSrc.match(/verdict\.(\w+)/)?.[1];

  it('derives the tag and key from the parser itself', () => {
    expect(TAG, 'could not read the verdict tag out of the parser; this suite would pass vacuously').toBeTruthy();
    expect(KEY, 'could not read the verdict key out of the parser; this suite would pass vacuously').toBeTruthy();
  });

  it('the TEMPLATE asks for exactly what the parser reads', () => {
    const body: string = JSON.parse(
      fs.readFileSync(join(ROOT, `orchestrations/prompts/templates/prompt-review.json`), 'utf8'),
    ).body ?? '';
    expect(body.length, 'the template is empty').toBeGreaterThan(0);
    expect(body, `the template never asks for <${TAG}> — the parser can never match`).toContain(`<${TAG}>`);
    expect(body, `the template never closes </${TAG}>`).toContain(`</${TAG}>`);
    expect(body, `the template never names '${KEY}', the field the verdict is read from`).toContain(KEY!);
  });

});
