/**
 * A CONSUMER RECEIVES WHAT IT DECLARED, AND NEVER NAMES ANOTHER AGENT'S FIELDS.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * The writer's prompt builder decided, in thirty conditionals, which of eleven other agents'
 * outputs to include and how to word each one. That is the coupling: a consumer holding an opinion
 * about a producer's data. It has already cost this pipeline a field that reached one renderer and
 * not the other, within an hour of being added.
 *
 * What replaces it is a declaration. The archetype already says what it consumes:
 *
 *     "story-writer": { consumes: [ { kind: "fix-plan", required: true, framing: "fix-plan" }, … ] }
 *
 * and the consumer renders exactly that, in that order. Three consequences the tests below hold to:
 *
 *   NO CONDITIONALS. A kind nobody published contributes nothing — no heading, no empty section.
 *   The prompt needs no `if` because absent is absent.
 *
 *   THE FRAMING IS THE CONSUMER'S, AND IT IS A DOCUMENT. "This is the plan of record, apply it"
 *   and "this is what the implementer was working from, judge the diff against it" are the same
 *   facts under different authority. That authority belongs to the reader — but it is prompt text,
 *   so it lives in the consumer's prompt document, never in a shell script and never in a registry.
 *
 *   A REQUIRED INPUT THAT NEVER ARRIVED IS A HARD FAILURE. This is the whole safety of the
 *   migration. Silently prompting without the root-cause analysis is how a writer spends 143k
 *   tokens re-deriving what an agent already worked out — and it looks exactly like success.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inputs = require(join(ROOT, 'orchestrations/scripts/lib/agent-inputs.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const io = require(join(ROOT, 'orchestrations/scripts/lib/agent-io.js'));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A registry with one consumer archetype, and a prompt document holding its framings. */
function fixture(consumes: any[], bodies: Record<string, string> = {}, migrated = true) {
  const dir = mkdtempSync(join(tmpdir(), 'declared-inputs-')); dirs.push(dir);

  const registry = join(dir, 'invocation-profiles.json');
  writeFileSync(registry, JSON.stringify({
    profiles: {
      // template names the prompt DOCUMENT this archetype's framings live in — the same field
      // every shipped archetype carries.
      'base-writer': {
        _what: 'implements the story', produces: 'implementation', template: 'story-writer', consumes,
      },
      // The producer of fix-plan. publishesVia marks it as migrated onto the framework, which is
      // what makes required-input enforcement apply to its kind.
      'base-investigator': {
        _what: 'investigates', produces: 'fix-plan', consumes: [],
        ...(migrated ? { publishesVia: 'agent-io' } : {}),
      },
    },
    seamPatterns: [{ match: '-engineer$', seam: 'base-writer' }],
    defaultSeam: 'base-writer',
  }, null, 2));

  const projectConfig = join(dir, 'project-config');
  mkdirSync(join(projectConfig, 'prompts'), { recursive: true });
  writeFileSync(join(projectConfig, 'prompts', 'story-writer.json'), JSON.stringify({
    id: 'story-writer', version: 1, description: 'writer', placeholders: [], bodies,
  }, null, 2));

  return { dir, registry, projectConfig, env: { AGENT_IO_DIR: join(dir, 'io') } };
}

const opts = (f: ReturnType<typeof fixture>) =>
  ({ registryPath: f.registry, projectConfigDir: f.projectConfig, env: f.env });

describe('THE DECLARATION DECIDES, NOT THE CONSUMER', () => {
  it('a declared kind that was published arrives', () => {
    const f = fixture([{ kind: 'fix-plan' }]);
    io.publish('code-graph-detective', 'fix-plan', 'S-1', 'PLAN-BODY', f.env);
    const out = inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f));
    expect(out).toContain('PLAN-BODY');
  });

  it('a published kind the consumer did NOT declare is not delivered', () => {
    // The reviewer's feedback is not the test-writer's business. Declaration is the whole
    // access control; without it every agent would receive every other agent's output.
    const f = fixture([{ kind: 'fix-plan' }]);
    io.publish('code-graph-detective', 'fix-plan', 'S-1', 'PLAN-BODY', f.env);
    io.publish('reviewer', 'review-feedback', 'S-1', 'FEEDBACK-BODY', f.env);
    const out = inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f));
    expect(out).toContain('PLAN-BODY');
    expect(out, 'an undeclared input was delivered anyway').not.toContain('FEEDBACK-BODY');
  });

  it('inputs arrive in the order the consumer DECLARED, not the order they were published', () => {
    // "What the plan says" must precede "what the reviewer objected to". Publication order is an
    // accident of scheduling.
    const f = fixture([{ kind: 'fix-plan' }, { kind: 'review-feedback' }]);
    io.publish('reviewer', 'review-feedback', 'S-1', 'SECOND', f.env);
    io.publish('code-graph-detective', 'fix-plan', 'S-1', 'FIRST', f.env);
    const out = inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f));
    expect(out.indexOf('FIRST')).toBeLessThan(out.indexOf('SECOND'));
  });

  it('provenance travels with every input', () => {
    const f = fixture([{ kind: 'fix-plan' }]);
    io.publish('code-graph-detective', 'fix-plan', 'S-1', 'PLAN-BODY', f.env);
    expect(inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f)))
      .toMatch(/code-graph-detective/);
  });

  it('an agent name never seen before resolves by rule, like any other', () => {
    const f = fixture([{ kind: 'fix-plan' }]);
    io.publish('code-graph-detective', 'fix-plan', 'S-1', 'PLAN-BODY', f.env);
    expect(inputs.renderDeclaredInputs('payments-integration-engineer', 'S-1', opts(f)))
      .toContain('PLAN-BODY');
  });
});

describe('ABSENT IS ABSENT — THE PROMPT NEEDS NO CONDITIONAL', () => {
  it('an optional kind nobody published contributes nothing at all', () => {
    const f = fixture([{ kind: 'fix-plan' }, { kind: 'review-feedback' }]);
    io.publish('code-graph-detective', 'fix-plan', 'S-1', 'PLAN-BODY', f.env);
    const out = inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f));
    expect(out, 'an absent input rendered a heading with nothing under it')
      .not.toMatch(/review-feedback/);
  });

  it('nothing published at all renders an empty string, not a skeleton', () => {
    const f = fixture([{ kind: 'fix-plan' }, { kind: 'review-feedback' }]);
    expect(inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f)).trim()).toBe('');
  });

  it('a producer that fell silent stops speaking through its old answer', () => {
    const f = fixture([{ kind: 'review-feedback' }]);
    io.publish('reviewer', 'review-feedback', 'S-1', 'OLD-FEEDBACK', f.env);
    io.publish('reviewer', 'review-feedback', 'S-1', '', f.env);
    expect(inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f)).trim()).toBe('');
  });
});

describe('A REQUIRED INPUT THAT NEVER ARRIVED STOPS THE PROMPT', () => {
  it('a required kind with nothing published THROWS, naming the kind and the agent', () => {
    // Prompting without it looks exactly like success and costs a whole retry. The pipeline
    // already refuses to build a writer prompt without its test-ownership policy; same rule.
    const f = fixture([{ kind: 'fix-plan', required: true }]);
    let msg = '';
    try {
      inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f));
    } catch (e: any) { msg = e.message; }
    expect(msg, 'a prompt was built without a required input').not.toBe('');
    expect(msg).toContain('fix-plan');
    expect(msg).toContain('x-engineer');
  });

  it('the same required kind, once published, renders normally', () => {
    const f = fixture([{ kind: 'fix-plan', required: true }]);
    io.publish('code-graph-detective', 'fix-plan', 'S-1', 'PLAN-BODY', f.env);
    expect(inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f))).toContain('PLAN-BODY');
  });

  it('a required kind whose producer is NOT yet on the framework does not throw', () => {
    // Enforcement follows migration. A kind still rendered the old way has nothing in the store,
    // and refusing every prompt over that would stop the pipeline rather than migrate it. This is
    // the ONLY thing that scoping may excuse — an absent input from a MIGRATED producer still
    // fails, which the test above holds.
    const f = fixture([{ kind: 'fix-plan', required: true }], {}, false);
    expect(() => inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f))).not.toThrow();
  });

  it('an OPTIONAL kind with nothing published does not throw', () => {
    const f = fixture([{ kind: 'review-feedback' }]);
    expect(() => inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f))).not.toThrow();
  });
});

describe('THE FRAMING IS THE CONSUMER OWN, AND IT COMES FROM A DOCUMENT', () => {
  it('the framing declared for a kind is rendered above that input', () => {
    const f = fixture(
      [{ kind: 'fix-plan', framing: 'fix-plan' }],
      { 'fix-plan': 'THIS IS THE PLAN OF RECORD. APPLY IT.' },
    );
    io.publish('code-graph-detective', 'fix-plan', 'S-1', 'PLAN-BODY', f.env);
    const out = inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f));
    expect(out).toContain('THIS IS THE PLAN OF RECORD. APPLY IT.');
    expect(out.indexOf('THIS IS THE PLAN OF RECORD'),
      'the framing arrived after the input it frames').toBeLessThan(out.indexOf('PLAN-BODY'));
  });

  it('no framing is rendered for an input that did not arrive', () => {
    // Otherwise the writer is told how to treat a plan of record it was never given.
    const f = fixture(
      [{ kind: 'fix-plan', framing: 'fix-plan' }],
      { 'fix-plan': 'THIS IS THE PLAN OF RECORD. APPLY IT.' },
    );
    expect(inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f)))
      .not.toContain('THIS IS THE PLAN OF RECORD');
  });

  it('a framing that names a body the document does not have FAILS LOUDLY', () => {
    // Silently rendering the input unframed would drop "apply this, do not re-derive it" and
    // nobody would notice until a writer re-traced a bug that was already solved.
    const f = fixture([{ kind: 'fix-plan', framing: 'fix-plan' }], {});
    io.publish('code-graph-detective', 'fix-plan', 'S-1', 'PLAN-BODY', f.env);
    expect(() => inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f)))
      .toThrow(/fix-plan/);
  });

  it('a kind with NO declared framing still renders its input', () => {
    // Framing is optional; the input is the point.
    const f = fixture([{ kind: 'fix-plan' }]);
    io.publish('code-graph-detective', 'fix-plan', 'S-1', 'PLAN-BODY', f.env);
    expect(inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f))).toContain('PLAN-BODY');
  });
});

describe('THE CONSUMER NAMES NO PRODUCER FIELD', () => {
  it('the module knows no agent-specific field name', () => {
    // The moment it knows what a fix site is, it is another place that has to change.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('node:fs')
      .readFileSync(join(ROOT, 'orchestrations/scripts/lib/agent-inputs.js'), 'utf8');
    for (const field of ['fixSiteAnalysis', 'deliveryRole', 'changeRequired', 'verificationCriteria']) {
      expect(src, `agent-inputs.js knows about '${field}'`).not.toContain(field);
    }
  });
});

describe('A FRAMED INPUT IS ANNOUNCED ONCE', () => {
  it('the framing titles the section and provenance attributes it, without a second heading', () => {
    // "## Root Cause Analysis & Prescribed Fix (AUTHORITATIVE …)" immediately followed by
    // "## fix-plan (from: code-graph-detective)" reads as two sections announcing the same thing
    // under different names, and a reader ranks two headings as two demands.
    const f = fixture(
      [{ kind: 'fix-plan', framing: 'fix-plan' }],
      { 'fix-plan': '## Root Cause Analysis (AUTHORITATIVE)\nApply it.' },
    );
    io.publish('code-graph-detective', 'fix-plan', 'S-1', 'PLAN-BODY', f.env);
    const out = inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f));

    const headings = out.split('\n').filter((l) => l.startsWith('## '));
    expect(headings, `the framed input carries more than one heading:\n${out}`).toHaveLength(1);
    expect(out, 'provenance was dropped along with the second heading').toContain('code-graph-detective');
    expect(out).toContain('PLAN-BODY');
  });

  it('an UNFRAMED input still gets the framework heading, so it is never unlabelled', () => {
    const f = fixture([{ kind: 'fix-plan' }]);
    io.publish('code-graph-detective', 'fix-plan', 'S-1', 'PLAN-BODY', f.env);
    const out = inputs.renderDeclaredInputs('x-engineer', 'S-1', opts(f));
    expect(out).toMatch(/^## fix-plan \(from: code-graph-detective\)/m);
  });
});
