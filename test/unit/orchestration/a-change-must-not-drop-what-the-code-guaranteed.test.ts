/**
 * THE WRITER WAS TOLD NOT TO WANDER. IT WAS NEVER TOLD NOT TO DEGRADE.
 *
 * Live 2026-08-11, AMSD-2041/gotransit. The writer had to change ContentstackProvider — that was
 * the attachment point, it had a mandate. Converting useMemo to useState was correct; it needed
 * mutable state. What it also did:
 *
 *     - const context = useMemo(() => ({ content: defaultContent }), [defaultContent]);
 *     + const value = { content };
 *
 * A fresh object every render, so all 18+ useContentstackContext consumers re-render whenever
 * the provider does. The memoisation was AVOIDABLE to lose — useMemo(() => ({ content }),
 * [content]) keeps both. And it escapes the feature flag: someone running with live preview OFF
 * pays for it, on a change that is supposed to be inert when disabled.
 *
 * WHY THE CONTRACT DID NOT CATCH IT. brownfieldNovel.rules[1] says "Do not restructure, refactor,
 * or rewrite SURROUNDING code that already works." That is a SCOPE rule — do not wander off. The
 * provider was not surrounding code; it was the target. Nothing in the contract said that the
 * properties of the code you are LEGITIMATELY changing must survive.
 *
 * Scope and preservation are different requirements, and only one of them was stated.
 *
 * ASSERTED ON THE RENDERED PROMPT, NOT THE JSON. A grep of agent-contract.json proves the string
 * exists in a file; it does not prove the writer is ever told. Four times today a toContain
 * assertion passed on a comment or a log line that merely NAMED the thing it was checking for.
 * This renders the real section through lib/render-prompt-section.js — the same call claude.sh
 * makes at 8661 — and asserts on the artifact.
 *
 * Written BEFORE the rule.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const CONTRACT = join(ROOT, 'orchestrations/config/agent-contract.json');
const RENDERER = join(ROOT, 'orchestrations/scripts/lib/render-prompt-section.js');
const CLAUDE = join(ROOT, 'orchestrations/scripts/claude.sh');

/** Exactly what claude.sh:8661 runs, for the arm a story of this kind selects. */
function renderedRules(storyKind: 'novel' | 'defect'): string {
  const section = storyKind === 'novel' ? 'brownfieldNovel' : 'brownfieldExisting';
  return execFileSync(process.execPath, [RENDERER, CONTRACT, section, '_startIndex=6'], {
    encoding: 'utf8',
  });
}

describe('the renderer produces a real prompt section — otherwise every assertion is vacuous', () => {
  for (const kind of ['novel', 'defect'] as const) {
    it(`the ${kind} arm renders non-empty numbered rules`, () => {
      const out = renderedRules(kind);
      expect(out.length, 'nothing rendered — a fall-through would make every check below pass').toBeGreaterThan(400);
      expect(out, 'rules must be numbered from the offset claude.sh passes').toMatch(/^6\. /m);
    });
  }
});

describe('THE RULE REACHES THE WRITER, for every story kind', () => {
  for (const kind of ['novel', 'defect'] as const) {
    it(`a ${kind} story is told to preserve what the code already guarantees`, () => {
      const out = renderedRules(kind).toUpperCase();
      expect(
        out,
        'a defect fix can drop a guard exactly as a novel capability dropped a memoisation — ' +
        'the rule applies to both arms',
      ).toContain('PRESERVE WHAT THE CODE ALREADY GUARANTEES');
    });

    it(`the ${kind} arm names the conversion case, not just the principle`, () => {
      // "preserve behaviour" alone is too abstract to act on. The live failure was a CONVERSION
      // — one construct swapped for another, a property dropped in passing.
      const out = renderedRules(kind).toLowerCase();
      expect(out).toMatch(/convert|conversion/);
    });

    it(`the ${kind} arm makes the writer CHECK ITS OWN DIFF before finishing`, () => {
      // A rule with no verification step is a wish. Mutation-verified 2026-08-11: deleting the
      // self-check sentence left every other assertion in this file green, because "convert" and
      // "state" both survive elsewhere in the rule. The instruction to re-read the diff and
      // answer explicitly is the part that turns a principle into a step, so it is asserted
      // on its own.
      const out = renderedRules(kind);
      expect(out, 'the writer must be told to re-read its own change').toMatch(/RE-READ YOUR OWN DIFF/i);
      expect(
        out,
        'and to answer a specific question about it — "preserve behaviour" alone is not checkable',
      ).toMatch(/which properties did the original have/i);
    });

    it(`the ${kind} arm requires an incompatible drop to be STATED, not silent`, () => {
      // Without this the rule is unfalsifiable: a writer can always claim preservation was
      // impossible. Requiring it in the output makes the claim reviewable.
      const out = renderedRules(kind).toLowerCase();
      expect(out).toMatch(/state|say/);
    });
  }
});

describe('IT IS A CAPABILITY RULE, NOT A STACK FACT', () => {
  it('names no language, framework, tool or API', () => {
    // SCOPED TO THE NEW RULE. The surrounding rules already carry stack vocabulary —
    // brownfieldNovel.rules[0] says "the existing file/function/provider/hook/route/component
    // this new capability must plug INTO", which is React/Next language in a generic contract.
    // That is a real pre-existing finding for the hardcoding sweep, and asserting it here would
    // make this test fail for something it is not about.
    const line = (renderedRules('novel') + '\n' + renderedRules('defect'))
      .split('\n')
      .filter((l) => l.toUpperCase().includes('PRESERVE WHAT THE CODE ALREADY GUARANTEES'))
      .join('\n')
      .toLowerCase();
    expect(line, 'the rule did not render — this check would pass vacuously').toBeTruthy();
    for (const banned of ['usememo', 'react', 'typescript', 'npm', 'hook', 'component', '.ts']) {
      expect(
        line,
        `'${banned}' would make this rule true of one stack and meaningless on the next`,
      ).not.toContain(banned);
    }
  });

  it('the rule is stated ONCE in the catalog, not copy-pasted into both arms', () => {
    // The two shared rules were previously duplicated byte-identically nine lines apart, and
    // each copy then needed maintaining. Whatever mechanism the catalog uses, the text must not
    // appear twice.
    const raw = readFileSync(CONTRACT, 'utf8');
    const occurrences = raw.split('PRESERVE WHAT THE CODE ALREADY GUARANTEES').length - 1;
    expect(occurrences, 'duplicated rule text drifts — that is how one rule became two').toBe(1);
  });
});

describe('the engine still renders the contract rather than composing it', () => {
  it('claude.sh selects the arm by story kind and renders through the catalog', () => {
    const src = readFileSync(CLAUDE, 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(src).toContain('render-prompt-section.js');
    expect(src).toContain('brownfieldNovel');
    expect(src).toContain('brownfieldExisting');
  });
});
