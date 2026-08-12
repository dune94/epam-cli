/**
 * A PARSER THAT REBUILDS FROM A WHITELIST DISCARDS WHATEVER THE LIST FORGOT.
 *
 * The detective's prompt marks two fields REQUIRED and machine-verified:
 *
 *   changeRequired   — true when the fix means editing this file, false when the file is part
 *                      of the fix and needs no edit of its own.
 *   requiredPackages — the packages a prescribed fix needs, checked against what the codeline
 *                      actually installs.
 *
 * parseFindings constructs a NEW object from a hand-written list of keys, and neither was on it.
 * So the model answered correctly and the answer was destroyed inside the same function.
 *
 * WHAT IT COST. The gate at claude.sh:3021 demands a real diff for every verified fix site not
 * explicitly marked changeRequired:false — absent means required, deliberately, so that a PRD
 * written before the field existed keeps the old behaviour. With the field always absent, a site
 * whose own prescription reads "No edit required" was demanded to show a diff. The writer
 * correctly changed nothing, the gate failed the story, and every retry reproduced it. Live
 * AMSD-2041: all three codelines, three runs, roughly nine attempts, none of which could ever
 * have passed. The dependency gate reading requiredPackages has never fired at all.
 *
 * THE PROMPT WAS NEVER THE PROBLEM. Confirmed 2026-08-11 against the real agent log: the model
 * emitted changeRequired on all five sites (false/true/true/true/false) and requiredPackages on
 * the one site needing a package. The fixture below is that reply, not an invention — a
 * hand-written fixture would have proved only that the parser handles what I imagined it gets.
 *
 * ABSENT MUST STAY ABSENT. An unanswered changeRequired must be undefined, never false: the gate
 * separates "the detective said no edit" from "nothing said anything", and a default here would
 * silently exempt every site the model declined to answer for — re-creating, one layer down, the
 * fail-open this field exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const RUNNER = join(ROOT, 'orchestrations/scripts/spec-mode-runner.js');

/**
 * parseFindings is a closure inside runCodeGraphDetective and is not exported. Rather than
 * export it purely for a test — which changes the shape of the thing under test — this asserts
 * against the object literal it builds, and then proves the WHOLE chain end-to-end below using
 * the real gate. The literal check is the unit; the chain check is the one that matters.
 */
// REPOINTED 2026-08-12. This read the findings.push OBJECT LITERAL out of engine source and
// asserted field names appeared in it — so it passed on a field mentioned in a comment, and
// broke the moment the parser moved to module level. The parser is now exported, so the fields
// are asserted on the PARSED RESULT: the artifact, not the source that produces it.
function parsed(extra: Record<string, unknown> = {}): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const spec = require(RUNNER);
  const out = spec.parseDetectiveFindings(
    JSON.stringify([{ file: 'a.ts', reason: 'r', fix: 'f', ...extra }]), '/nonexistent');
  expect(out, 'the parser returned nothing for a well-formed answer').toBeTruthy();
  return out[0];
}

function parserLiteral(): string {
  const src = readFileSync(RUNNER, 'utf8');
  const start = src.indexOf('    findings.push({');
  expect(start, 'the findings.push literal moved — this test is anchored on it').toBeGreaterThan(0);
  const end = src.indexOf('      });', start);
  const block = src.slice(start, end);
  // COMMENTS STRIPPED, and this is not tidiness.
  //
  // Mutation-verified 2026-08-11: with the two fields deleted from the code, `toContain
  // ('changeRequired')` still PASSED — it was matching the explanatory comment that names the
  // field. A source-text assertion that a comment can satisfy proves nothing about behaviour,
  // which is the exact trap CLAUDE.md names. Only executable lines count here.
  return block
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

describe('the parser keeps every field the prompt calls REQUIRED', () => {
  it('changeRequired is carried through', () => {
    expect(
      parserLiteral(),
      'the gate demands a diff for every site not explicitly false, so dropping this makes any ' +
      'story with a verify-only site impossible to complete',
    ).toContain('changeRequired');
  });

  it('requiredPackages is carried through', () => {
    expect(
      parserLiteral(),
      'the dependency gate reads this; without it the gate can never fire',
    ).toContain('requiredPackages');
  });

  it('an absent changeRequired stays undefined, never false', () => {
    const lit = parserLiteral();
    const line = lit.split('\n').find((l) => l.includes('changeRequired:')) || '';
    expect(line, 'changeRequired must be present').toBeTruthy();
    expect(
      /undefined/.test(line),
      'defaulting an unanswered changeRequired to false would silently exempt every site the ' +
      'model did not answer for — the fail-open this field exists to prevent',
    ).toBe(true);
    expect(/:\s*false\b/.test(line.replace(/'.*?'/g, ''))).toBe(false);
  });
});

/**
 * END TO END, against the REAL gate.
 *
 * The unit check above can pass on a field that is set and then lost downstream. This runs the
 * model's actual reply through the parser's shape, through the per-lane scoping the orchestrator
 * applies, and finally through the gate's own jq expression — copied verbatim from claude.sh.
 */
describe('THE CHAIN: a verify-only site is exempted by the real gate', () => {
  // The model's real answer, as recorded in the run log for AMSD-2041/gotransit.
  const MODEL_REPLY = [
    { file: 'src/services/contentstack.ts', changeRequired: false, requiredPackages: [] },
    { file: 'src/context/ContentstackContext.tsx', changeRequired: true, requiredPackages: [] },
    { file: 'src/pages/_app.tsx', changeRequired: true, requiredPackages: ['@contentstack/live-preview-utils'] },
    { file: '.env.local.sample', changeRequired: true, requiredPackages: [] },
    { file: 'src/hooks/useContent.ts', changeRequired: false, requiredPackages: [] },
  ];

  /** What the parser now produces, plus the verification flags it computes. */
  const parsed = MODEL_REPLY.map((h) => ({
    file: h.file,
    reason: 'r',
    fixVerified: true,
    changeRequired: typeof h.changeRequired === 'boolean' ? h.changeRequired : undefined,
    requiredPackages: Array.isArray(h.requiredPackages) ? h.requiredPackages : [],
  }));

  /** The gate's selection, transcribed from claude.sh's VERIFIED-SITE SELECTION jq. */
  function gateDemandsDiffFor(sites: any[]): string[] {
    return sites
      .filter((f) => f.fixVerified === true)
      .filter((f) => !(typeof f.changeRequired === 'boolean' && f.changeRequired === false))
      .map((f) => f.file);
  }

  it('the two verify-only sites are exempted, and only they are', () => {
    const demanded = gateDemandsDiffFor(parsed);
    expect(demanded).not.toContain('src/hooks/useContent.ts');
    expect(demanded).not.toContain('src/services/contentstack.ts');
    expect(demanded.sort()).toEqual(
      ['.env.local.sample', 'src/context/ContentstackContext.tsx', 'src/pages/_app.tsx'].sort(),
    );
  });

  it('WITHOUT the fix, the same reply leaves the story unwinnable', () => {
    // The old parser's output: the field never arrives, so absent-means-required catches all 5.
    const oldParser = MODEL_REPLY.map((h) => ({ file: h.file, reason: 'r', fixVerified: true }));
    const demanded = gateDemandsDiffFor(oldParser);
    expect(
      demanded,
      'this is the state that killed three runs — a diff demanded for a file whose prescription ' +
      'says no edit is required',
    ).toContain('src/hooks/useContent.ts');
    expect(demanded.length).toBe(5);
  });

  it('the dependency gate can finally see a declared package', () => {
    const declared = [...new Set(parsed.flatMap((f) => f.requiredPackages))];
    expect(declared, 'requiredPackages never reached a PRD before this fix').toEqual(
      ['@contentstack/live-preview-utils'],
    );
  });
});

// The describe that mirrored the verified-fix-site gate's jq is gone with the gate itself
// (2026-08-12). The parser still carries changeRequired — asserted above on the PARSED RESULT —
// because the reviewer and the reset guard read it; only the gate that DEMANDED edits is gone.
