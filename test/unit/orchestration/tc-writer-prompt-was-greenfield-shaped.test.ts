// THE TC WRITER'S PROMPT CARRIED ANOTHER PROJECT'S STACK AND ANOTHER PROJECT'S DOMAIN.
//
// The seam that turns verification criteria into executable checks decides what "verified" means
// for every story. Its template hardcoded:
//
//   - ONE TEST FRAMEWORK: vi.mock, vi.hoisted, vi.stubGlobal, clearAllMocks/resetAllMocks, and
//     "@jest/globals" as a banned import. Prescribed to every codeline, whatever it actually runs.
//     metrolinx's PRD says testing: jest and the codeline runs its own `npm test`.
//   - ANOTHER PROJECT'S DOMAIN, in its worked examples: "GET /search only — no /cheapest route
//     exists", "'from' and 'to' not 'origin'/'destination'", "adults=0 is valid", "src/server.ts",
//     and column alignment for "table stories". That is the sample travel app, frozen into an
//     engine template, steering every project's test criteria toward routes and query params.
//   - AN INVERTED PRIORITY: "The testCriteria.facts OVERRIDE any conflicting AC. Write them as
//     ground truth." The seam consumes `implementation` (required) and reads the BUILT source, so
//     this authorises the tests to canonise whatever the writer produced — including a defect —
//     and to overrule the requirement while doing it. A descriptive test ratifies the defect.
//
// The codeline's own answers already exist: lib/ecosystem-registry.js knows the test command, and
// stack-facts.js produces __TEST_FILE_CONVENTIONS__ and __TEST_COMMAND__ ready to merge into a
// values file. This seam received neither — its only placeholders were __STORY_CONTEXT__,
// __TC_OUT_FILE__ and __TC_WRITER_PROFILE__.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/tc-writer.json');
const PRODUCER = join(ROOT, 'orchestrations/scripts/post-impl-tc-writer.sh');

const template = () => JSON.parse(readFileSync(TEMPLATE, 'utf8'));
const body = (): string => {
  const j = template();
  return String(j.body ?? Object.values(j.bodies ?? {}).join('\n'));
};

describe('the prompt names no test framework of its own', () => {
  // Every one of these is a vitest/jest idiom. Which one this codeline uses is a fact about the
  // codeline, and the engine already knows how to ask.
  for (const idiom of ['vi.mock', 'vi.hoisted', 'vi.stubGlobal', 'clearAllMocks', 'resetAllMocks', '@jest/globals']) {
    it(`does not prescribe ${idiom}`, () => {
      expect(body(), `the template hardcodes "${idiom}" for every project`).not.toContain(idiom);
    });
  }

  it('takes the conventions from the codeline instead', () => {
    expect(template().placeholders).toContain('__TEST_FILE_CONVENTIONS__');
  });

  it('and the producer supplies them', () => {
    expect(readFileSync(PRODUCER, 'utf8')).toMatch(/__TEST_FILE_CONVENTIONS__/);
  });
});

describe("the prompt carries no other project's domain", () => {
  for (const noun of ['/search', '/cheapest', 'origin', 'destination', 'adults=', 'src/server.ts']) {
    it(`does not name ${noun}`, () => {
      expect(body(), `a worked example from the sample app leaked into the engine template`)
        .not.toContain(noun);
    });
  }
});

describe('test criteria serve the requirement, not the implementation', () => {
  it('does not authorise facts to override the acceptance criteria', () => {
    expect(body().toLowerCase(), 'the tests are told to canonise whatever was built')
      .not.toContain('override any conflicting ac');
  });

  it('derives the criteria from the verification criteria', () => {
    // The VCs already reach this seam inside __STORY_CONTEXT__ (tc-story-context.py). The prompt
    // must say they are the source, or reading the built source silently becomes the source.
    expect(body().toLowerCase()).toMatch(/verification criteri/);
  });

  it('says what to do when the implementation contradicts a verification criterion', () => {
    // The interesting case for brownfield: built behaviour that disagrees with the requirement is
    // a finding, not a fact to write down.
    expect(body().toLowerCase()).toMatch(/contradict|disagree|conflict/);
  });
});

describe('brownfield: the repository already has tests', () => {
  it('tells the writer to match the conventions already in the repository', () => {
    expect(body().toLowerCase(), 'nothing points at the existing tests, so the idiom is guesswork')
      .toMatch(/existing test|already in (this|the) repositor|neighbouring test/);
  });
});
