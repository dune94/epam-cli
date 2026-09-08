/**
 * A BROWNFIELD RUN CAN HAVE ITS OWN PROMPT — WITHOUT GREENFIELD NOTICING.
 *
 * WHY THIS EXISTS. On a brownfield ticket the spec pass consumes verificationCriteria,
 * fixSiteAnalysis and technicalNotes; acceptance criteria are out of scope. But the engine asks
 * for ACs anyway and discards them afterwards — live 2026-09-08, AMSD-1919:
 *
 *   spec-mode: brownfield — ignoring 8 AC(s) speckit produced; ACs are out of scope
 *   spec-mode: ACs are immutable (VC model); openspec AC edits redacted
 *
 * so a whole agent invocation produced a deliverable that policy guarantees will be thrown away,
 * paying output tokens (the dearest kind) to do it.
 *
 * THE RULE THIS ENCODES, and the reason the test leads with greenfield: a brownfield prompt must
 * be ADDITIVE. Greenfield must resolve to exactly the file it resolves to today — same id, same
 * bytes — because the greenfield path is working and is not what we are fixing. A variant is a
 * dimension of the id, resolved in ONE place, falling back when no variant exists, so turning the
 * flag on cannot break a prompt nobody has written a variant for.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LIB = join(process.cwd(), 'orchestrations/scripts/lib/engine-prompt.js');
const TEMPLATES = join(process.cwd(), 'orchestrations/prompts/templates');

/**
 * NOTHING IS WRITTEN INTO THE REAL TEMPLATE ZONE. An earlier version of this test dropped probe
 * templates into orchestrations/prompts/templates to make a variant exist, and sibling suites
 * that enumerate that directory saw them — a test that breaks its neighbours proves less than it
 * costs. templatesDir() takes no env override on purpose ("never from an env guess"), so the
 * variant DECISION is what gets exercised here, through the same function production calls, with
 * existence answered by the caller.
 */
function withBrownfield<T>(on: boolean, fn: () => T): T {
  const prev = process.env.EPAM_BROWNFIELD;
  on ? (process.env.EPAM_BROWNFIELD = '1') : delete process.env.EPAM_BROWNFIELD;
  try {
    delete require.cache[require.resolve(LIB)];
    return fn();
  } finally {
    prev === undefined ? delete process.env.EPAM_BROWNFIELD : (process.env.EPAM_BROWNFIELD = prev);
  }
}

const lib = () => require(LIB);

describe('template variant resolution', () => {
  it('GREENFIELD IS UNCHANGED — the same id lands on the same file it does today', () => {
    const p = withBrownfield(false, () => lib().templatePathFor('spec-agent-openspec'));
    expect(p, 'the resolver does not expose which file an id resolves to, so no run can be '
      + 'audited for which prompt it actually executed').toBeTruthy();
    expect(p).toBe(join(TEMPLATES, 'spec-agent-openspec.json'));
  });

  it('BROWNFIELD PREFERS ITS VARIANT when the zone has one', () => {
    const asked: string[] = [];
    const id = withBrownfield(true, () => lib().variantIdFor('any-prompt', (v: string) => {
      asked.push(v); return true;
    }));
    expect(asked, 'the resolver never asked whether a variant exists').toEqual(['any-prompt.brownfield']);
    expect(id).toBe('any-prompt.brownfield');
  });

  it('GREENFIELD NEVER EVEN ASKS — the variant cannot leak into a working path', () => {
    const asked: string[] = [];
    const id = withBrownfield(false, () => lib().variantIdFor('any-prompt', (v: string) => {
      asked.push(v); return true;
    }));
    expect(id, 'a greenfield run resolved to the brownfield variant').toBe('any-prompt');
    expect(asked, 'greenfield consulted the variant zone at all').toEqual([]);
  });

  it('FALLS BACK when no variant exists — turning the flag on cannot break a prompt', () => {
    const id = withBrownfield(true, () => lib().variantIdFor('any-prompt', () => false));
    expect(id, 'a brownfield run failed on a prompt that has no variant, so enabling the flag '
      + 'would break every prompt not yet written').toBe('any-prompt');
  });

  it('A BROKEN ZONE FALLS BACK rather than throwing mid-run', () => {
    const id = withBrownfield(true, () => lib().variantIdFor('any-prompt', () => {
      throw new Error('unreadable');
    }));
    expect(id).toBe('any-prompt');
  });

  it('every existing template still resolves under brownfield', () => {
    // The blast radius of turning the flag on: nothing may become unresolvable.
    const ids = readdirSync(TEMPLATES)
      .filter((f: string) => f.endsWith('.json') && !f.includes('.brownfield.'))
      .map((f: string) => f.replace(/\.json$/, ''));
    expect(ids.length, 'no templates found').toBeGreaterThan(10);
    const broken = withBrownfield(true, () =>
      ids.filter((id: string) => !existsSync(lib().templatePathFor(id))));
    expect(broken, `these ids stop resolving under brownfield: ${broken.slice(0, 5).join(', ')}`)
      .toEqual([]);
  });
});
