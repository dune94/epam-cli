/**
 * The QA gate agents must not assume a language, test runner, or repository layout.
 *
 * WHY
 * ---
 * Steps 22a-f run six gate agents — sast-sentinel, spec-validator, review-ranger,
 * mutant-hunter, fuzz-weaver, perf-sentinel. Their entire instruction set was written
 * against one stack: TypeScript source under `src/`, vitest tests under `test/unit/`,
 * `tsc --noEmit`, `npm`/`package.json`, and shell commands with `--include="*.ts"` baked in.
 *
 * On any other codeline those instructions are not merely unhelpful — they are wrong in a
 * way that produces confident output. An agent told to "run grep -rn '^export' src/
 * --include='*.ts' to list all exported symbols" on a .NET or Python repository gets zero
 * matches and concludes there are no exported symbols, then reports a clean gate. A gate
 * that cannot see the code it is gating passes everything.
 *
 * These gates are currently skipped in the live project config (SKIP_TESTING_GATES) and
 * will be enabled once a codeline lands green, so this is caught before they ever run.
 *
 * THE RULE
 * --------
 * A gate agent states WHAT it must assess. It discovers HOW from the codeline in front of
 * it — the manifests present, the scripts the project declares, the facts injected for that
 * codeline. It never hardcodes the answer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROFILES = JSON.parse(readFileSync(
  join(__dirname, '../../../orchestrations/agents/profiles.canonical.json'), 'utf8'));

/** The six QA gate agents wired to steps 22a-f. */
const GATE_AGENTS = [
  'sast-sentinel', 'spec-validator', 'review-ranger',
  'mutant-hunter', 'fuzz-weaver', 'perf-sentinel',
];

/**
 * Stack facts, by class. Each names a concrete ecosystem choice that belongs to a
 * codeline, not to the engine. Deliberately NOT a list of "bad words" — every entry is a
 * proper noun of one ecosystem, which is exactly what a stack-agnostic instruction cannot
 * contain.
 */
const STACK_LITERALS: Array<[string, RegExp]> = [
  ['a test runner', /\b(vitest|jest|mocha|pytest|junit|rspec|xunit|nunit|go test)\b/i],
  ['a language/compiler', /\b(typescript|tsc --noEmit|javascript|python|golang)\b/i],
  ['a package manager/manifest', /\b(npm|pnpm|yarn|package\.json|requirements\.txt|go\.mod|Gemfile)\b/i],
  ['a source/test directory', /(^|[^a-z])(src\/|test\/unit|tests\/|__tests__)/],
  ['a file extension', /\*\.tsx?\b|--include="\*\.[a-z]+"|\.ts\b/],
  ['a specific library', /\b(fast-check|supertest|express|react|zod|esbuild|tsup|vite)\b/i],
];

describe('QA gate agents state WHAT to assess, never WHICH stack', () => {
  for (const agent of GATE_AGENTS) {
    describe(agent, () => {
      const prompt: string = PROFILES[agent] || '';

      it('has a profile at all', () => {
        expect(prompt.length, `${agent} has no profile`).toBeGreaterThan(50);
      });

      for (const [label, pattern] of STACK_LITERALS) {
        it(`names no ${label}`, () => {
          const hits = prompt.match(new RegExp(pattern.source, pattern.flags.includes('i') ? 'gi' : 'g')) || [];
          expect(
            [...new Set(hits)],
            `${agent} hardcodes ${label}. On a codeline using anything else these ` +
              `instructions produce confident, wrong output — an agent that greps for the ` +
              `wrong extension finds nothing and reports a clean gate.`,
          ).toEqual([]);
        });
      }

      it('tells the agent to DISCOVER the stack from the codeline', () => {
        expect(
          prompt,
          `${agent} must derive its commands/paths from the codeline in front of it — ` +
            `its manifests, its declared scripts, its injected codeline facts`,
        ).toMatch(/discover|determine .*(from|by inspecting)|codeline_facts|the codeline'?s own/i);
      });

      it('names no client, product or vendor', () => {
        expect(prompt).not.toMatch(/metrolinx|gotransit|upexpress|contentstack|mozio/i);
      });
    });
  }
});

describe('the grounding requirement survives the rewrite', () => {
  // These agents hallucinated findings before; each carries an explicit
  // cite-your-evidence clause. De-hardcoding must not quietly drop it.
  for (const agent of GATE_AGENTS) {
    it(`${agent} still requires evidence before reporting a finding`, () => {
      const prompt: string = PROFILES[agent] || '';
      expect(prompt).toMatch(/verify|evidence|cite|grounding|must not report/i);
    });
  }
});
