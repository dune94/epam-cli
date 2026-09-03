/**
 * THE PROMPT GENERATOR IS GIVEN FACTS, OR IT IS TOLD IT HAS NONE.
 *
 * project-prompt-generation.json instructs the generator: "Do not name a file, symbol, package or
 * command that does not appear in the context you were given." The context it was given
 * (mint-agents-step.js:1243) was a config path, ticket titles, and a codeline name with its
 * dependency list. No files. No symbols. No structure.
 *
 * A task that demands project specifics while supplying none has exactly one compliant answer —
 * name nothing — and the model resolves the contradiction the other way: it invents. Live
 * 2026-09-01, metrolinx AMSD-1919, the generated team-lead-review prompt asserted "Form components
 * are typically in the `src/components/Checkout/` directory". No such directory. prompt-review
 * grepped, rejected it, and rejected the next two attempts, and the mint died.
 *
 * WHY IT LOOKED LIKE A REGRESSION: at v1.5 prompt-review was OPT-IN ("set
 * EPAM_PROMPT_REVIEW_ENABLED=1 to turn it on"). The fabrications were there; nothing looked. Making
 * the review on-by-default did not break generation — it revealed that the generator had never been
 * given what its own template requires.
 *
 * The facts exist and are already delivered elsewhere: codeline-facts.json carries verified
 * statements with their sources, claude.sh injects it into the WRITER at invocation, and the estate
 * survey reports the surfaces it actually found. The generator is the one consumer that receives
 * none of it.
 *
 * TWO GUARANTEES, and the second matters as much as the first:
 *
 *   1. real, verified structure reaches the generator
 *   2. when there is none, the context SAYS SO — a generator told "no structure is known" can
 *      comply by naming nothing; one told nothing at all has to guess.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
const LIB = join(REPO, 'orchestrations/scripts/lib/codeline-context.js');
const MINT = join(REPO, 'orchestrations/scripts/mint-agents-step.js');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = existsSync(LIB) ? require(LIB) : ({} as any);
const { buildCodelineContext } = mod;

/** A codeline on disk with real structure, plus the facts file the pipeline writes beside it. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codeline-ctx-'));
  mkdirSync(join(root, 'src/components/pages/CheckoutPage'), { recursive: true });
  writeFileSync(join(root, 'src/components/pages/CheckoutPage/CheckoutForm.tsx'), 'export {};\n');
  const factsFile = join(root, 'codeline-facts.json');
  writeFileSync(factsFile, JSON.stringify({
    gotransit: {
      path: root,
      facts: [
        { text: 'Tests run via `jest` (npm run test).', source: 'package.json' },
        { text: 'A pre-commit hook runs lint-staged.', source: '.husky/pre-commit' },
      ],
    },
  }));
  return { root, factsFile };
}

describe('the prompt generator is given verified facts', () => {
  it('the builder exists and is exported', () => {
    expect(existsSync(LIB), 'lib/codeline-context.js has not been written').toBe(true);
    expect(typeof buildCodelineContext, 'buildCodelineContext is not exported').toBe('function');
  });

  it('keeps what it already had — name, path and declared dependencies', () => {
    const { root, factsFile } = fixture();
    const out = buildCodelineContext({
      codelines: [{ name: 'gotransit', path: root, dependencies: ['react', 'next'] }],
      factsFile,
    });
    expect(out).toContain('gotransit');
    expect(out).toContain(root);
    expect(out, 'the dependency list was dropped').toMatch(/react/);
  });

  it('THE FIX: verified facts reach the generator, with their sources', () => {
    const { root, factsFile } = fixture();
    const out = buildCodelineContext({ codelines: [{ name: 'gotransit', path: root }], factsFile });
    expect(out, 'the codeline facts never reach the generator').toMatch(/jest/);
    expect(out, 'a fact arrives without the source that establishes it').toMatch(/package\.json/);
  });

  it('AND the surfaces the survey actually found', () => {
    // The survey verified these by looking. They are the only paths the generator can safely name.
    const { root, factsFile } = fixture();
    const out = buildCodelineContext({
      codelines: [{ name: 'gotransit', path: root }],
      factsFile,
      surveyed: [{ codeline: 'gotransit', surfaces: ['src/components/pages/CheckoutPage'] }],
    });
    expect(out).toContain('src/components/pages/CheckoutPage');
  });

  it('NAMES NO PATH THAT DOES NOT EXIST', () => {
    // The whole point. If this context can carry an unverified path, the generator inherits the
    // fabrication instead of committing it, which is worse — it looks authoritative.
    const { root, factsFile } = fixture();
    const out = buildCodelineContext({
      codelines: [{ name: 'gotransit', path: root }],
      factsFile,
      surveyed: [{ codeline: 'gotransit', surfaces: ['src/components/pages/CheckoutPage', 'src/components/Checkout'] }],
    });
    expect(out, 'a surface that does not exist on disk was passed through')
      .not.toMatch(/src\/components\/Checkout\b(?!\/pages)/);
    expect(out, 'the real surface was dropped along with the false one')
      .toContain('src/components/pages/CheckoutPage');
  });

  it('WHEN THERE IS NOTHING, IT SAYS SO — silence is what forces a guess', () => {
    const root = mkdtempSync(join(tmpdir(), 'bare-'));
    const out = buildCodelineContext({ codelines: [{ name: 'bare', path: root }], factsFile: null });
    expect(out, 'a generator given no facts and no statement of that has to invent')
      .toMatch(/no verified|none known|nothing is known|no facts/i);
  });

  it('THE MINT USES IT — a builder nothing calls changes no prompt', () => {
    const { readFileSync } = require('node:fs');
    const src = readFileSync(MINT, 'utf8');
    expect(src, 'mint-agents-step.js does not use the fact-carrying builder')
      .toMatch(/buildCodelineContext/);
  });
});
