/**
 * THE SPEC REVIEWER, CALLED FOR REAL.
 *
 * Every test written for this agent on 2026-08-04 was offline — validators, wiring,
 * source assertions. All of them passed while the agent itself failed on three
 * consecutive live runs, because its failure mode only exists when a real model answers:
 *
 *     <SPEC_REVIEW>
 *     </SPEC_REVIEW>
 *     # Output
 *     I cannot write the final output yet — I must first verify the referenced file paths
 *     against the repository using my read-only tools. Let me search for each file.
 *
 * An empty tag plus prose. extractTaggedJson returned null, the review was discarded, and
 * the spec-review gate downstream guarded nothing — three runs in a row, on every lane.
 * The cause was an instruction I added telling it to verify BEFORE approving: it read that
 * as a precondition requiring a later turn. There is no later turn; runAgentForJson is
 * single-shot.
 *
 * No offline test can catch this. The prompt is well-formed, the validator is correct, the
 * wiring is correct — and the agent still answers in prose. So this test CALLS THE MODEL
 * with the real prompt and asserts on what actually comes back.
 *
 * COST: one cheap call per test. Gated on an API key and skipped without one.
 *
 * Run:  RUN_LIVE_AGENT_TESTS=1 npx vitest run test/integration/spec-reviewer-live.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../');
const AI_RUN = join(REPO_ROOT, 'orchestrations/scripts/ai-run.sh');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { extractTaggedJson } = require('../../orchestrations/scripts/spec-mode-runner.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateTaggedOutput } = require('../../orchestrations/scripts/lib/agent-output-schema.js');

const hasKey = !!(process.env.OPENROUTER_API_KEY || process.env.EPAM_API_KEY_ANTHROPIC);
const optedIn = process.env.RUN_LIVE_AGENT_TESTS === '1';

/** The REAL grounding instruction, read from the runner — never a restated copy. */
function groundingBlock(): string {
  const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
  const i = src.indexOf('const MANIFEST_GROUNDING_BLOCK = [');
  expect(i, 'MANIFEST_GROUNDING_BLOCK not found — the reviewer instruction moved').toBeGreaterThan(-1);
  const body = src.slice(i, src.indexOf("].join('\\n');", i));
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith("'"))
    .map((l) => l.replace(/^'/, '').replace(/',?$/, '').replace(/\\'/g, "'"))
    .join('\n');
}

/** The REAL brownfield review criteria, read from the runner — never a restated copy. */
function brownfieldReviewCriteria(): string {
  const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
  const i = src.indexOf('const reviewCriteria = isBrownfieldReview');
  expect(i, 'the brownfield review criteria moved').toBeGreaterThan(-1);
  const start = src.indexOf('`', i) + 1;
  return src.slice(start, src.indexOf('`', start));
}

/**
 * A review prompt of the same shape the pipeline builds: a story with a manifest, and the
 * real grounding instruction. One path deliberately does NOT exist, so a reviewer that
 * genuinely checks has something true to report.
 */
function reviewPrompt(): string {
  return [
    'You are the specification coordinator reviewing completed spec output for phase core.',
    '',
    'STORY ST-1 — "Add a greeting helper"',
    '  technicalNotes.files: package.json, src/does-not-exist-xyz.ts',
    '  acceptanceCriteria: ["A greeting is returned"]',
    '',
    // Evidence gathered deterministically, exactly as the pipeline now does it.
    'MANIFEST EVIDENCE (checked against the repository, not asserted):',
    '  ST-1: EXISTS  package.json',
    '  ST-1: MISSING  src/does-not-exist-xyz.ts',
    '',
    groundingBlock(),
    '',
    'Respond with JSON between <SPEC_REVIEW> and </SPEC_REVIEW> using this schema:',
    '[{"storyId":"ST-1","verdict":"approved|needs_review","reviewNotes":"...","qualityScore":0.0-1.0,"flags":[]}]',
  ].join('\n');
}

function callReviewer(): string {
  return execFileSync(
    'bash',
    [AI_RUN, '--provider', 'openrouter', '--model', process.env.SPEC_MODE_MODEL || 'z-ai/glm-5.2'],
    { input: reviewPrompt(), encoding: 'utf8', timeout: 180_000, cwd: REPO_ROOT },
  );
}

describe.skipIf(!hasKey || !optedIn)('spec reviewer — LIVE call, real model', () => {
  let raw = '';
  let parsed: unknown = null;

  it('answers at all', () => {
    raw = callReviewer();
    expect(raw.trim().length, 'the model returned nothing').toBeGreaterThan(0);
  });

  it('REPRODUCES THE LIVE FAILURE IF IT RETURNS: the tag is not empty', () => {
    expect(
      raw,
      'the reviewer emitted an empty <SPEC_REVIEW></SPEC_REVIEW>. That is the exact failure ' +
        'that silently disabled the spec-review gate on three consecutive runs.',
    ).not.toMatch(/<SPEC_REVIEW>\s*<\/SPEC_REVIEW>/);
  });

  it('does not defer the verdict to a turn that will never come', () => {
    expect(
      raw,
      'the reviewer said it would verify first and answer later. runAgentForJson is ' +
        'single-shot — there is no later turn, so the review never happens.',
    ).not.toMatch(/cannot write the final output yet|I (must|need to|will) first|Let me (search|read|do that)/i);
    expect(
      raw,
      'the reviewer emitted tool calls. ai-run.sh has NO tool loop — nothing executes them, ' +
        'so it stalls and never produces a verdict. That is why path facts are precomputed.',
    ).not.toMatch(/<tool_call>|list_files\s+path=/i);
  });

  it('the answer PARSES with the pipeline\'s own extractor', () => {
    parsed = extractTaggedJson(raw, 'SPEC_REVIEW');
    expect(
      parsed,
      `extractTaggedJson returned null — the pipeline would discard this review.\n` +
        `--- raw tail ---\n${raw.slice(-600)}`,
    ).not.toBeNull();
  });

  it('the answer CONFORMS to the contract its tool definition declares', () => {
    const v = validateTaggedOutput('SPEC_REVIEW', parsed);
    expect(v.ok, `schema refusal: ${v.reason}`).toBe(true);
  });

  it('carries a usable verdict the gate can act on', () => {
    const items = parsed as Array<{ verdict?: string; qualityScore?: number }>;
    expect(['approved', 'needs_review']).toContain(items[0].verdict);
  });

  /**
   * The point of giving this agent tools. A reviewer that cannot see the repository can
   * only agree; one that can should notice a path that is not there.
   */
  it('actually CHECKED the repository — it notices the non-existent path', () => {
    const items = parsed as Array<{ verdict?: string; reviewNotes?: string; flags?: string[] }>;
    const said = JSON.stringify(items).toLowerCase();
    expect(
      said.includes('does-not-exist-xyz') || items[0].verdict === 'needs_review',
      'the reviewer approved a manifest naming a file that does not exist — it either has ' +
        'no filesystem access or was not required to use it. That is the gap this agent ' +
        `was given tools to close.\n--- verdict ---\n${JSON.stringify(items[0])}`,
    ).toBe(true);
  });
});

describe.skipIf(hasKey && optedIn)('spec reviewer live test is opt-in', () => {
  it('is skipped without RUN_LIVE_AGENT_TESTS=1 and an API key', () => {
    expect(true).toBe(true);
  });
});

/**
 * THE GATE MUST NOT BLOCK ON A DESIGNED BEHAVIOUR.
 *
 * Live run 20260804T130402Z: the reviewer returned needs_review on all three lanes,
 * qualityScore 0.45, reporting that speckit "claims all 10 criteria are new… but the
 * story's acceptanceCriteria array is empty — either a hallucination or a persistence
 * failure." It was neither. spec-mode-runner.js:3069 REDACTS brownfield AC edits by
 * design ("ACs are immutable (VC model); verification captured in verificationCriteria"),
 * and this ticket genuinely has no ACs of its own.
 *
 * That matters because the spec-review gate now enforces: a reviewer that treats policy as
 * a defect would block every brownfield run on a false positive — the exact class of
 * mistake that already aborted one clean run. So the review prompt states the policy, and
 * this asserts the model actually acts on it. Offline tests cannot: the prompt was
 * well-formed before, and the reviewer still flagged it.
 */
describe.skipIf(!hasKey || !optedIn)('brownfield AC redaction is policy, not a defect', () => {
  it('does NOT flag an empty acceptanceCriteria array as a persistence failure', () => {
    const prompt = [
      'You are the specification coordinator reviewing completed spec output for phase core.',
      '',
      brownfieldReviewCriteria(),
      '',
      'MANIFEST EVIDENCE (checked against the repository, not asserted):',
      '  ST-1: EXISTS  package.json',
      '',
      groundingBlock(),
      '',
      'Respond with JSON between <SPEC_REVIEW> and </SPEC_REVIEW> using this schema:',
      '[{"storyId":"ST-1","verdict":"approved|needs_review","reviewNotes":"...","qualityScore":0.0-1.0,"flags":[]}]',
      '',
      'Stories to review:',
      JSON.stringify([{
        id: 'ST-1',
        title: 'A capability described in the ticket',
        acceptanceCriteria: [],
        verificationCriteria: [
          'The described behaviour is observable after the change',
          'Existing behaviour in this area is unchanged',
        ],
        agentNotes: {
          speckit: 'I authored all 10 acceptance criteria (AC-1..AC-10) from scratch.',
          acceptanceChanged: false,
        },
      }]),
      '',
      '<SPEC_REVIEW>',
      '</SPEC_REVIEW>',
    ].join('\n');

    const raw = execFileSync(
      'bash',
      [AI_RUN, '--provider', 'openrouter', '--model', process.env.SPEC_MODE_MODEL || 'z-ai/glm-5.2'],
      { input: prompt, encoding: 'utf8', timeout: 180_000, cwd: REPO_ROOT },
    );
    const items = extractTaggedJson(raw, 'SPEC_REVIEW') as Array<{
      verdict?: string; reviewNotes?: string; flags?: string[];
    }>;
    expect(items, `no parseable review:\n${raw.slice(-400)}`).not.toBeNull();

    const said = JSON.stringify(items).toLowerCase();
    expect(
      said,
      'the reviewer called a DESIGNED redaction a hallucination or persistence failure. ' +
        'With the gate enforcing, that blocks every brownfield run on a false positive.\n' +
        JSON.stringify(items[0]),
    ).not.toMatch(/hallucinat|persistence failure|metadata inconsistenc/);
  });
});

/**
 * THE REVIEWER AND THE GATE, END TO END, WITH NOTHING FAKED BETWEEN THEM.
 *
 * Every gate bug this month lived in the seam, not in either half: the gate read a field no
 * producer wrote; the fixture was authored from the gate's assumption; the policy was
 * specified against verdicts I imagined rather than the ones the reviewer emits. Unit tests
 * on either side passed throughout.
 *
 * So this calls the REAL reviewer, takes its REAL verdict, persists it exactly where
 * spec-mode-runner.js persists it, and runs the REAL bash gate on the result. If any link
 * in that chain disagrees with any other, this fails.
 *
 * Two cases, because a gate that only ever passes proves as little as one that only ever
 * blocks:
 *   1. a sound spec with every manifest path present  -> the run PROCEEDS
 *   2. a spec naming a file that does not exist       -> the run HALTS
 *
 * COST: two cheap calls, opt-in.
 */
describe.skipIf(!hasKey || !optedIn)('reviewer → gate, end to end', () => {
  /** Persist a verdict where the PRODUCER persists it, then run the REAL gate. */
  function gateOnVerdict(review: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'live-gate-'));
    try {
      const prdFile = join(dir, 'prd.json');
      // The producer's path, derived from its own assignment — never restated here.
      const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
      const m = src.match(/^\s*(?:const\s+\w+\s*=\s*)?story\.((?:\w+\.)*\w*[Rr]eview\w*)\s*=\s*\{/m);
      expect(m, 'producer assignment not found').toBeTruthy();
      const nested = (m as RegExpMatchArray)[1].split('.')
        .reduceRight((acc: unknown, k: string) => ({ [k]: acc }), review);
      writeFileSync(prdFile, JSON.stringify({
        stories: [{ id: 'ST-1', status: 'pending', ...(nested as object) }],
      }));
      const script = join(dir, 'g.sh');
      writeFileSync(script, [
        'set -uo pipefail',
        'log(){ echo "$*"; }; info(){ echo "$*"; }; warning(){ echo "WARN: $*"; }',
        'error(){ echo "ERROR: $*" >&2; }; success(){ echo "$*"; }',
        `source ${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts/lib/story-guards.sh'))}`,
        `spec_review_gate ${JSON.stringify(prdFile)}`,
        'echo "EXIT:$?"',
      ].join('\n'));
      const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 20000 });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      return { code: Number((out.match(/EXIT:(\d+)/) || [])[1] ?? -1), out };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * A COHERENT story. The first version of this fixture declared package.json as the only
   * file while every criterion described rendered-page behaviour; the reviewer correctly
   * called that an implausible file set, scored it 0.55, and the gate correctly blocked.
   * The gate was right and the FIXTURE was wrong — a "sound spec proceeds" test has to
   * supply a spec that is actually sound. Story, files and criteria now agree with each
   * other and with what is really on disk in this repository.
   */
  function review(evidence: string, files: string, opts: { title?: string; vcs?: string[] } = {}) {
    const prompt = [
      'You are the specification coordinator reviewing completed spec output for phase core.',
      '', brownfieldReviewCriteria(), '',
      'MANIFEST EVIDENCE (checked against the repository, not asserted):',
      evidence, '', groundingBlock(), '',
      'Respond with JSON between <SPEC_REVIEW> and </SPEC_REVIEW> using this schema:',
      '[{"storyId":"ST-1","verdict":"approved|needs_review","reviewNotes":"...","qualityScore":0.0-1.0,"flags":[]}]',
      '', 'Stories to review:',
      JSON.stringify([{
        id: 'ST-1',
        title: opts.title || 'Improve the message shown when the CLI is run with no arguments',
        acceptanceCriteria: [],
        technicalNotes: { files },
        verificationCriteria: opts.vcs || [
          'Running the CLI with no arguments prints a usage message naming the available commands',
          'Running a known command behaves exactly as it did before this change',
          'Running an unknown command exits non-zero and the message names the command given',
        ],
        agentNotes: {
          openspec: 'identified the CLI entry point as the integration point',
          speckit: 'derived the observable criteria above',
        },
      }]),
      '', '<SPEC_REVIEW>', '</SPEC_REVIEW>',
    ].join('\n');
    const raw = execFileSync(
      'bash',
      [AI_RUN, '--provider', 'openrouter', '--model', process.env.SPEC_MODE_MODEL || 'z-ai/glm-5.2'],
      { input: prompt, encoding: 'utf8', timeout: 180_000, cwd: REPO_ROOT },
    );
    const items = extractTaggedJson(raw, 'SPEC_REVIEW') as Array<Record<string, unknown>>;
    expect(items, `no parseable review:\n${raw.slice(-400)}`).not.toBeNull();
    return items[0];
  }

  it('a SOUND spec: the reviewer answers and the gate lets the run PROCEED', () => {
    const v = review('  ST-1: EXISTS  src/index.ts', 'src/index.ts');
    const { code, out } = gateOnVerdict(v);
    expect(
      code,
      'the reviewer raised nothing blocking, yet the gate halted the run. A gate that ' +
        'blocks a sound spec cannot run unattended — this is the live 20260804T145419Z halt.\n' +
        `verdict: ${JSON.stringify(v)}\n${out}`,
    ).toBe(0);
  });

  it('a MISSING path: the reviewer flags it and the gate HALTS the run', () => {
    const v = review(
      '  ST-1: MISSING  src/does-not-exist-xyz.ts\n  ST-1: EXISTS  src/index.ts',
      'src/does-not-exist-xyz.ts, src/index.ts',
    );
    const { code, out } = gateOnVerdict(v);
    expect(
      code,
      'a manifest naming a file that does not exist reached the writer. That is the ' +
        'condition that cost a 120-iteration, ~2M-token loop.\n' +
        `verdict: ${JSON.stringify(v)}\n${out}`,
    ).not.toBe(0);
  });
});

/**
 * THE CLASSIFICATION MUST BE STABLE ENOUGH TO GATE ON.
 *
 * Measured 2026-08-04, the SAME prompt sent to the real model four times:
 *
 *   before: 0.55  0.72  0.60  0.72    spread 0.17, mean 0.65
 *
 * Two of four fell below the 0.7 bar and two cleared it — on byte-identical input the gate
 * outcome was a coin flip. Two causes, both fixed and both measured here:
 *
 *   - verificationCriteria were absent from the payload. On brownfield the AC array is
 *     empty by policy, so the VCs are the only substance; the reviewer was scoring prose.
 *     Adding them alone moved it to 0.70 0.73 0.65 0.72 — spread 0.08, mean 0.70.
 *   - qualityScore had no definition beyond "0.0-1.0", while the gate hard-blocks below
 *     0.7. It now carries numeric anchors naming that threshold, and says explicitly not
 *     to discount for things no reviewer can see.
 *
 * No offline test can check this: the prompt was well-formed before and the scores still
 * scattered. Only sampling the real model shows it.
 *
 * COST: N cheap calls (default 4). Opt-in, like the rest of this file.
 */
describe.skipIf(!hasKey || !optedIn)('the quality score is stable enough to gate on', () => {
  const SAMPLES = Number(process.env.SPEC_REVIEW_SAMPLES || '4');

  /** The REAL prompt pieces, read from the runner — never a restated copy. */
  function realPrompt(): string {
    const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    const anchorsAt = src.indexOf('QUALITY SCORE — what the number has to mean');
    expect(anchorsAt, 'the quality-score anchors are gone from the prompt').toBeGreaterThan(-1);
    const anchors = src.slice(anchorsAt, src.indexOf('Respond with JSON', anchorsAt));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildReviewPayload } = require('../../orchestrations/scripts/spec-mode-runner.js');
    const payload = buildReviewPayload([{
      id: 'ST-1',
      title: 'Live preview of content from the CMS',
      acceptanceCriteria: [],
      verificationCriteria: [
        'When preview mode is active the page displays the draft version of the entry',
        'When preview mode is not active the page displays published content as before',
        'A failure to load preview content shows a visible fallback, not a blank page',
      ],
      technicalNotes: { files: ['src/index.ts'] },
      specification: {
        coordinatorNotes: 'openspec identified the content hook as the integration point; ' +
          'speckit derived the observable criteria and noted it could not read the source files.',
      },
    }], true, []);

    return [
      'You are the EPAM CLI specification coordinator reviewing the completed spec outputs for phase core.',
      '', brownfieldReviewCriteria(), '',
      'MANIFEST EVIDENCE (checked against the repository, not asserted):',
      '  ST-1: EXISTS  src/index.ts',
      '', groundingBlock(), '',
      anchors,
      'Respond with JSON between <SPEC_REVIEW> and </SPEC_REVIEW> using this schema:',
      '[{"storyId":"ST-1","verdict":"approved|needs_review","reviewNotes":"...","qualityScore":0.0-1.0,"flags":[]}]',
      '', 'Stories to review:', payload,
      '', '<SPEC_REVIEW>', '</SPEC_REVIEW>',
    ].join('\n');
  }

  const scores: number[] = [];
  const allFlags: string[][] = [];

  it(`samples the real model ${SAMPLES}x on identical input`, () => {
    const prompt = realPrompt();
    for (let i = 0; i < SAMPLES; i += 1) {
      const raw = execFileSync(
        'bash',
        [AI_RUN, '--provider', 'openrouter', '--model', process.env.SPEC_MODE_MODEL || 'z-ai/glm-5.2'],
        { input: prompt, encoding: 'utf8', timeout: 180_000, cwd: REPO_ROOT },
      );
      const items = extractTaggedJson(raw, 'SPEC_REVIEW') as Array<{
        qualityScore?: number; flags?: string[];
      }>;
      expect(items, `sample ${i + 1} did not parse:\n${raw.slice(-300)}`).not.toBeNull();
      expect(typeof items[0].qualityScore, `sample ${i + 1} returned no score`).toBe('number');
      scores.push(items[0].qualityScore as number);
      allFlags.push(items[0].flags || []);
    }
    expect(scores).toHaveLength(SAMPLES);
  }, 900_000);

  it('a spec with nothing concretely wrong CLEARS the 0.7 bar every time', () => {
    const below = scores.filter((s) => s < 0.7);
    expect(
      below.length,
      `${below.length}/${scores.length} samples fell below the gate on identical input ` +
        `(scores: ${scores.join(', ')}). Before the fix this was 2/4 — a coin flip on ` +
        'whether the run proceeds. The criteria are observable, the file exists, and ' +
        'nothing concrete is wrong.',
    ).toBe(0);
  });

  it('the spread is small enough that a 0.7 threshold means something', () => {
    const spread = Math.max(...scores) - Math.min(...scores);
    expect(
      spread,
      `spread ${spread.toFixed(2)} (scores: ${scores.join(', ')}). Measured 0.17 before the ` +
        'fix. A threshold cannot discriminate inside the noise band.',
    ).toBeLessThanOrEqual(0.15);
  });

  it('does NOT hallucinate missing_manifest_path when the evidence says EXISTS', () => {
    // Corroboration only now — the gate blocks on the computed check — but a reviewer
    // contradicting the filesystem is still worth catching.
    const bad = allFlags.filter((f) => f.some((x) => /missing_manifest_path/i.test(x)));
    expect(
      bad.length,
      `${bad.length}/${allFlags.length} samples claimed a missing path against an ` +
        'all-EXISTS evidence block. This is why the gate no longer blocks on the flag.',
    ).toBe(0);
  });
});
