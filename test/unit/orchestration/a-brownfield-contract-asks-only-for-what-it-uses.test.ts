/**
 * A BROWNFIELD CONTRACT ASKS ONLY FOR WHAT BROWNFIELD USES.
 *
 * THE DEFECT (live 2026-09-08, AMSD-1919). TOOL_SPEC_AGENT — the tool schema every spec agent
 * must answer with — declares:
 *
 *   required: ['storyId', 'agent', 'acceptanceCriteria']
 *   acceptanceCriteria: { type: 'array', minItems: 1 }
 *
 * and is never varied for brownfield. So on a brownfield ticket the agent CANNOT return a valid
 * result without inventing at least one acceptance criterion, and the runner then discards them:
 *
 *   spec-mode: brownfield — ignoring 8 AC(s) speckit produced; ACs are out of scope
 *
 * The waste is not only the discarded tokens. A required field steers the whole call's reasoning
 * toward a deliverable policy has already rejected, and output is the dearest token class.
 *
 * DERIVED, NOT DUPLICATED. Two hand-written schemas drift, and the drift is invisible — both
 * still produce structurally valid results. The brownfield contract is computed FROM the
 * greenfield one, so a field added to greenfield appears in brownfield automatically.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const RUNNER = join(process.cwd(), 'orchestrations/scripts/spec-mode-runner.js');

/** Ask the real runner for the contract it would use, under a given brownfield setting. */
function contract(brownfield: boolean): any {
  const out = execFileSync(process.execPath, ['-e', `
    process.env.EPAM_BROWNFIELD = ${brownfield ? "'1'" : "''"};
    const m = require(${JSON.stringify(RUNNER)});
    const c = m.specAgentContract ? m.specAgentContract() : null;
    process.stdout.write(JSON.stringify(c));
  `], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, SPEC_MODE_NO_MAIN: '1' } });
  return JSON.parse(out || 'null');
}

describe('the spec agent contract', () => {
  it('GREENFIELD IS UNCHANGED — acceptance criteria remain required', () => {
    const c = contract(false);
    expect(c, 'the runner does not expose specAgentContract(), so the contract cannot be varied '
      + 'without editing call sites').toBeTruthy();
    expect(c.parameters.required, 'greenfield lost its AC requirement — the ACs ARE the contract '
      + 'there').toContain('acceptanceCriteria');
    expect(c.parameters.properties.acceptanceCriteria.minItems).toBe(1);
  });

  it('BROWNFIELD DOES NOT DEMAND ACs — they are discarded by policy', () => {
    const c = contract(true);
    expect(c.parameters.required, 'brownfield still forces the agent to invent acceptance '
      + 'criteria that line 7650 then throws away').not.toContain('acceptanceCriteria');
  });

  it('brownfield drops the AC-only channels too', () => {
    const c = contract(true);
    for (const f of ['acAddedBySpeckit', 'acModifiedBySpeckit', 'acFlagged']) {
      expect(Object.keys(c.parameters.properties), `${f} is an AC-only output channel; offering `
        + 'it invites work that is discarded').not.toContain(f);
    }
  });

  it('brownfield KEEPS what it actually consumes', () => {
    const c = contract(true);
    // These are the deliverables: the VCs, the fix site, the notes the writer works from.
    // verificationCriteriaDetail is the field the VCs actually arrive in — checked against the
    // schema rather than assumed from the name used elsewhere in the pipeline.
    for (const f of ['verificationCriteriaDetail', 'storyId', 'agent']) {
      expect(Object.keys(c.parameters.properties).concat(c.parameters.required),
        `brownfield lost ${f}, which it does consume`).toContain(f);
    }
  });

  it('IS DERIVED — a new greenfield field appears in brownfield without being copied', () => {
    const g = contract(false);
    const b = contract(true);
    const dropped = new Set(['acceptanceCriteria', 'acAddedBySpeckit', 'acModifiedBySpeckit', 'acFlagged']);
    const missing = Object.keys(g.parameters.properties)
      .filter((k) => !dropped.has(k) && !(k in b.parameters.properties));
    expect(missing, `brownfield is missing non-AC fields ${missing.join(', ')} — it was written `
      + 'by hand instead of derived, and the two will drift').toEqual([]);
  });

  it('does not mutate the greenfield contract in place', () => {
    // Deriving by mutation would corrupt greenfield for the rest of the process.
    contract(true);
    const g = contract(false);
    expect(g.parameters.required).toContain('acceptanceCriteria');
  });
});

/**
 * THE PROMPT AND THE SCHEMA ARE ONE DECISION, MADE TWICE — so they are asserted together.
 *
 * specAgentContract() removes the AC fields from the TOOL under EPAM_BROWNFIELD=1; the
 * spec-agent-openspec.brownfield template removes them from the TEXT. Either one alone leaves the
 * defect in place: a tool that still requires acceptanceCriteria refuses every call the new prompt
 * produces, and a prompt that still asks for ACs keeps paying for them however tolerant the tool
 * has become. Drift between them is silent in both directions, which is why it is pinned here.
 */
describe('the brownfield spec prompt matches the brownfield contract', () => {
  const TEMPLATES = join(process.cwd(), 'orchestrations/prompts/templates');
  const read = (f: string) => JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8'));
  const base = () => read('spec-agent-openspec.json');
  const variant = () => read('spec-agent-openspec.brownfield.json');

  it('THE VARIANT EXISTS and is what a brownfield run resolves to', () => {
    const prev = process.env.EPAM_BROWNFIELD;
    process.env.EPAM_BROWNFIELD = '1';
    try {
      const lib = join(process.cwd(), 'orchestrations/scripts/lib/engine-prompt.js');
      delete require.cache[require.resolve(lib)];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      expect(require(lib).templatePathFor('spec-agent-openspec'))
        .toBe(join(TEMPLATES, 'spec-agent-openspec.brownfield.json'));
    } finally {
      prev === undefined ? delete process.env.EPAM_BROWNFIELD : (process.env.EPAM_BROWNFIELD = prev);
    }
  });

  it('IT STOPS ASKING FOR ACCEPTANCE CRITERIA — the whole point of the variant', () => {
    expect(base().body, 'GUARD: the greenfield template no longer asks for ACs, so this variant '
      + 'is measuring nothing').toContain('"acceptanceCriteria"');
    expect(variant().body, 'the brownfield prompt still asks for a deliverable the runner '
      + 'discards on arrival').not.toContain('"acceptanceCriteria"');
  });

  it('IT ASKS FOR NOTHING THE BROWNFIELD TOOL WOULD REFUSE', () => {
    const props = Object.keys(contract(true).parameters.properties);
    // Every quoted key in the response sketch must be a field the tool actually accepts.
    const sketch = variant().body.match(/^\s*"([A-Za-z][A-Za-z0-9]*)"\s*:/gm) || [];
    const asked = sketch.map((m: string) => m.replace(/[^A-Za-z0-9]/g, ''));
    expect(asked.length, 'no response sketch found in the variant, so this proves nothing')
      .toBeGreaterThan(3);
    const rejected = asked.filter((f: string) => !props.includes(f));
    expect(rejected, `the prompt asks for fields the brownfield tool removed: ${rejected.join(', ')}`)
      .toEqual([]);
  });

  it('RENDERING CANNOT FAIL ON A MISSING TOKEN — same placeholders as the base', () => {
    expect(new Set(variant().placeholders)).toEqual(new Set(base().placeholders));
    // A placeholder present in the body but undeclared is supplied by nobody.
    const inBody = new Set(variant().body.match(/__[A-Z][A-Z0-9_]*?__/g) || []);
    const undeclared = [...inBody].filter((t) => !variant().placeholders.includes(t));
    expect(undeclared, `undeclared placeholders: ${undeclared.join(', ')}`).toEqual([]);
  });
});
