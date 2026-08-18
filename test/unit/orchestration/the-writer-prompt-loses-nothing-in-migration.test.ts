/**
 * THE WRITER PROMPT LOSES NOTHING WHEN IT IS TAKEN APART.
 *
 * WRITTEN BEFORE THE MIGRATION, AND THE REASON THE MIGRATION CAN START.
 *
 * The writer prompt is about to change shape. Today it is a 711-line shell function that holds
 * twenty-five blocks of prose, hand-renders eleven other agents' outputs, and decides what to
 * include through thirty conditionals. It is due to become two things: a base prompt document, and
 * inputs collected by declared kind.
 *
 * The danger in that is not a loud failure. It is a section that quietly stops being emitted —
 * discovered three hours into a run, by a writer that never received the one instruction it needed.
 * This pipeline has lost runs that way before.
 *
 * So the bytes are captured first. Each fixture below renders the REAL build_implementation_prompt
 * and is compared against a committed capture. Move a block into the prompt document and the
 * capture should not move; if it does, the diff names exactly what changed, in seconds.
 *
 * A capture is regenerated deliberately, never automatically:
 *
 *     UPDATE_WRITER_PROMPT_CAPTURES=1 vitest run the-writer-prompt-loses-nothing-in-migration
 *
 * and the resulting diff is the migration's evidence. `git diff` on test/fixtures/writer-prompt/
 * is the answer to "what did this step change about what the writer is told?".
 *
 * GUARDING AGAINST A VACUOUS PASS
 *
 * A harness that renders nothing would make every capture match an empty file, and every
 * "nothing was lost" claim would be true and worthless. So each fixture also declares SENTINELS —
 * values that exist nowhere but that fixture — and the test asserts they arrived. If the render
 * hollows out, those assertions fail before the byte comparison ever runs.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  renderWriterPrompt, cleanupWriterPromptFixtures, stabilise, claudeShAsLibrary,
  type WriterPromptFixture,
} from '../../helpers/writer-prompt';

afterAll(cleanupWriterPromptFixtures);

const CAPTURES = join(__dirname, '../../fixtures/writer-prompt');
const UPDATING = process.env.UPDATE_WRITER_PROMPT_CAPTURES === '1';

interface Case {
  name: string;
  fixture: WriterPromptFixture;
  /** Strings that must appear in the render. A hollow prompt fails here first. */
  sentinels: string[];
  /** Strings that must NOT appear — over-inclusion is the failure a capture cannot see. */
  absent?: string[];
  /** Expected exit status: a refusal to build is a behaviour worth pinning too. */
  rc?: number;
}

/** A story shaped the way the PRD shapes one. No project or client fact appears anywhere here. */
const story = (over: Record<string, unknown> = {}) => ({
  id: 'CAP-1',
  title: 'SENTINEL-TITLE render live content',
  description: 'SENTINEL-DESCRIPTION the page must refetch when the editor publishes',
  acceptanceCriteria: [
    'SENTINEL-AC-ONE the response contains "sentinel-literal-string"',
    'SENTINEL-AC-TWO the request is not cached',
  ],
  technicalNotes: { files: ['src/service.ts'], notes: 'SENTINEL-TECHNICAL-NOTE' },
  ...over,
});

const CASES: Case[] = [
  {
    // The floor: brownfield, one declared file, no other agent has published anything.
    name: 'brownfield-bare',
    fixture: {
      story: story(),
      env: { EPAM_BROWNFIELD: '1' },
      projectFiles: { 'src/service.ts': 'export const SENTINEL_EXISTING_CODE = 1;\n' },
    },
    sentinels: [
      'SENTINEL-TITLE', 'SENTINEL-DESCRIPTION', 'SENTINEL-AC-ONE', 'SENTINEL-AC-TWO',
      'sentinel-literal-string',      // the string-invariants block extracted it from the AC
      'SENTINEL_EXISTING_CODE',       // the file contents were injected
      'SENTINEL-TECHNICAL-NOTE',
    ],
  },
  {
    // Greenfield: the same story down the other branch. Half the blocks are brownfield-only, and
    // the migration must not quietly make them unconditional.
    name: 'greenfield-bare',
    fixture: {
      story: story(),
      projectFiles: { 'src/service.ts': 'export const SENTINEL_EXISTING_CODE = 1;\n' },
    },
    sentinels: ['SENTINEL-TITLE', 'SENTINEL-AC-ONE'],
    absent: [
      // Brownfield injects the file's contents; greenfield must not, or every greenfield prompt
      // silently grows by the size of the repository.
      'SENTINEL_EXISTING_CODE',
    ],
  },
  {
    // Everything at once: what the prompt looks like on a retry, when five other agents have
    // spoken. This is the capture that the migration will be judged against.
    name: 'brownfield-every-input',
    fixture: {
      story: story({
        // The detective's real output shape. That this fixture has to know these field names is
        // precisely the coupling the migration removes — after it, the producer renders this and
        // the fixture publishes rendered text instead.
        fixSiteAnalysis: [
          {
            file: 'src/service.ts',
            function: 'SENTINEL_FUNCTION',
            reason: 'SENTINEL-ROOT-CAUSE the fetch is memoised',
            fix: 'SENTINEL-MINIMAL-FIX pass a cache-busting parameter',
            helper: 'SENTINEL_HELPER',
            deliveryRole: 'produces',
            runsIn: 'SENTINEL-RUNS-IN',
            fixVerified: true,
            evidenceVerified: true,
            changeRequired: true,
          },
          {
            // The second site carries BOTH warning branches. They are the longest prose in the
            // block and the easiest to lose in a migration precisely because they are conditional.
            file: 'src/consumer.ts',
            function: '',
            reason: 'SENTINEL-SECOND-SITE-REASON',
            fix: 'SENTINEL-SECOND-SITE-FIX',
            helper: 'SENTINEL_MISSING_HELPER',
            deliveryRole: 'carries',
            runsIn: 'n/a',
            fixVerified: false,
            evidenceVerified: false,
            brokenLine: 'SENTINEL-BROKEN-LINE',
            changeRequired: true,
          },
        ],
        fixSiteAnalysisCoverage: {
          complete: false,
          uncoveredVerificationCriteria: ['SENTINEL-UNCOVERED-VC'],
        },
        verificationCriteria: ['SENTINEL-VC-ONE'],
        dependencies: ['CAP-0'],
        agentRole: 'sentinel-engineer',
        testCriteria: { facts: ['SENTINEL-TC-FACT'], mockStrategy: 'SENTINEL-MOCK', bannedPatterns: ['SENTINEL-BANNED'] },
      }),
      // Again the real shape: severity is what separates a blocker from advice, and rendering
      // them into one flat list is a defect this pipeline has already shipped once.
      reviewFeedback: {
        issues: [
          {
            severity: 'blocker',
            description: 'SENTINEL-BLOCKER no test accompanies the change',
            file: 'src/service.ts',
            line: 12,
            suggestedFix: 'SENTINEL-SUGGESTED-FIX',
          },
          { severity: 'advisory', description: 'SENTINEL-ADVISORY reuse the existing helper' },
        ],
      },
      vcCoverage: { uncovered: ['SENTINEL-UNCOVERED-VC'] },
      // profiles.json is a flat role → text map, and the notes are read paragraph-wise.
      profiles: {
        'sentinel-engineer': '[Self-Heal] SENTINEL-SKILL-NOTE always check the cache header',
      },
      env: { EPAM_BROWNFIELD: '1' },
      projectFiles: {
        'src/service.ts': 'export const SENTINEL_EXISTING_CODE = 1;\n',
        '.epam/codeline-facts.json': JSON.stringify({ facts: ['SENTINEL-CODELINE-FACT'] }),
        '.epam/dependency-check.json': JSON.stringify({ manifestFile: 'package.json' }),
        'package.json': JSON.stringify({ name: 'sentinel-app', dependencies: {} }),
        '.contracts/CAP-0.md': 'SENTINEL-DEPENDENCY-CONTRACT\n',
      },
    },
    sentinels: [
      'SENTINEL-ROOT-CAUSE', 'SENTINEL-MINIMAL-FIX', 'SENTINEL_FUNCTION', 'SENTINEL-RUNS-IN',
      'SENTINEL-SECOND-SITE-REASON', 'SENTINEL_MISSING_HELPER', 'SENTINEL-BROKEN-LINE',
      'SENTINEL-BLOCKER', 'SENTINEL-SUGGESTED-FIX', 'SENTINEL-ADVISORY', 'SENTINEL-SKILL-NOTE',
      'SENTINEL-TC-FACT', 'SENTINEL-MOCK', 'SENTINEL-BANNED',
      'SENTINEL-VC-ONE', 'SENTINEL-CODELINE-FACT',
      'SENTINEL-DEPENDENCY-CONTRACT', 'SENTINEL_EXISTING_CODE',
      // The two warning branches, by their own words — the prose most likely to be dropped.
      'UNVERIFIED', 'UNGROUNDED DIAGNOSIS', 'THIS CHANGE PRODUCES THE VALUE',
    ],
  },
];

describe('THE HARNESS RENDERS THE REAL THING', () => {
  it('it runs claude.sh itself, with only the entry point removed', () => {
    // If this ever becomes a copy of the prompt builder, every capture below becomes a test of
    // the copy, and the migration it is meant to police happens unwatched.
    const lib = claudeShAsLibrary();
    expect(lib).toContain('build_implementation_prompt() {');
    expect(lib).not.toMatch(/^main "\$@"$/m);
    expect(lib.length).toBeGreaterThan(300_000);
  });

  it('a render produces a substantial prompt, not a stub', () => {
    const r = renderWriterPrompt(CASES[0].fixture);
    expect(r.rc, `the builder refused: ${r.stderr}`).toBe(0);
    expect(r.text.length, 'the harness rendered almost nothing, so every capture below would '
      + 'match trivially and prove nothing').toBeGreaterThan(2000);
  });
});

describe('EVERY CAPTURED PROMPT STILL RENDERS BYTE FOR BYTE', () => {
  for (const c of CASES) {
    it(`${c.name} — nothing added, nothing lost`, () => {
      const r = renderWriterPrompt(c.fixture);
      expect(r.rc, `render failed: ${r.stderr}`).toBe(c.rc ?? 0);

      // Anti-vacuity first: a hollow render must fail HERE, with a useful message, rather than
      // silently matching an empty capture.
      for (const s of c.sentinels) {
        expect(r.text, `'${s}' never reached the prompt — the writer would not be told it`)
          .toContain(s);
      }
      for (const s of c.absent ?? []) {
        expect(r.text, `'${s}' reached the prompt on a branch that must not include it`)
          .not.toContain(s);
      }

      const text = stabilise(r.text);
      const file = join(CAPTURES, `${c.name}.txt`);

      if (UPDATING || !existsSync(file)) {
        mkdirSync(CAPTURES, { recursive: true });
        writeFileSync(file, text);
        expect(existsSync(file)).toBe(true);
        return;
      }

      const captured = readFileSync(file, 'utf8');
      expect(text, `the writer prompt for '${c.name}' changed. If that was the point, re-capture `
        + 'with UPDATE_WRITER_PROMPT_CAPTURES=1 and read the diff before committing it — the diff '
        + 'IS the record of what the writer stopped being told.').toBe(captured);
    });
  }
});

describe('A REFUSAL IS ALSO BEHAVIOUR, AND IS ALSO PINNED', () => {
  it('no project-authority prompt means NO prompt — never a prompt missing its policy', () => {
    // The template is never executed and a missing policy is not an empty policy: without this,
    // a writer silently regains permission to write tests. The migration moves this rule into a
    // prompt document, and moving it must not turn a refusal into a quiet omission.
    const r = renderWriterPrompt({
      story: story(),
      env: { EPAM_BROWNFIELD: '1', EPAM_PROJECT_CONFIG_DIR: '/nonexistent-project-config' },
      projectFiles: { 'src/service.ts': 'export const SENTINEL_EXISTING_CODE = 1;\n' },
    });
    expect(r.rc, 'the builder produced a prompt with no test-ownership policy in it').not.toBe(0);
    expect(r.text.trim(), 'a partial prompt was emitted before the refusal').toBe('');
  });
});

describe('THE CAPTURES THEMSELVES ARE WORTH SOMETHING', () => {
  it('each one is a real prompt, of real size', () => {
    // A capture regenerated against a broken harness would be empty, and would then happily match
    // forever. Pin the floor.
    for (const c of CASES) {
      const file = join(CAPTURES, `${c.name}.txt`);
      if (!existsSync(file)) continue;
      const body = readFileSync(file, 'utf8');
      expect(body.length, `capture ${c.name}.txt is too small to be a prompt`).toBeGreaterThan(1000);
      expect(body, `capture ${c.name}.txt lost the story it was rendered for`)
        .toContain('SENTINEL-TITLE');
    }
  });

  it('no capture carries an absolute path from the machine that made it', () => {
    for (const c of CASES) {
      const file = join(CAPTURES, `${c.name}.txt`);
      if (!existsSync(file)) continue;
      const body = readFileSync(file, 'utf8');
      expect(body, `capture ${c.name}.txt pins a scratch path and will fail on another machine`)
        .not.toMatch(/\/tmp\/writer-prompt-[A-Za-z0-9]+/);
      expect(body, `capture ${c.name}.txt pins a home directory`).not.toContain('/home/');
    }
  });
});
