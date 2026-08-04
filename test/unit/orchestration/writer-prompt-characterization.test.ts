/**
 * CHARACTERIZATION HARNESS for the writer prompt. This is the regression net.
 *
 * It runs the REAL `build_implementation_prompt` (626 lines, extracted verbatim from
 * claude.sh) against a real PRD fixture and asserts on the RENDERED PROMPT — the artifact
 * the writer actually receives. Nothing here greps source text.
 *
 * WHY THIS EXISTS. On 2026-08-03 the per-codeline manifest was stored on
 * `story.technicalNotes`. `## Technical Notes` renders that object with a blanket
 * `jq to_entries | map("- \(.key): \(.value)")`, so a writer scoped to ONE lane was handed
 * the resolution map for ALL THREE codelines — sibling absolute checkout paths plus the
 * fact that they diverge. It went cross-repo. One call billed in=1,916,632 out=40,859
 * ($0.624, 11.58 min) and produced nothing, ending "Let me confirm the scope with the user
 * before proceeding" — in a non-interactive loop, a dead end.
 *
 * That change shipped with 9 tests. Seven executed the producer and were correct. The two
 * wiring tests were `expect(claudeSrc).toMatch(/perCodeline/)`; the string also appears in
 * a comment, so deleting the working consumer line left all 9 green (mutation-verified).
 * Grepping source cannot see this defect: it lives in the artifact.
 *
 * TWO INVARIANTS ARE LOCKED HERE:
 *   1. ISOLATION — a lane is never shown another codeline.
 *   2. SIZE — the prompt does not grow. Every token added to this prompt is re-sent on
 *      EVERY iteration of the agent loop, and the run this came from had NO prompt
 *      caching (usage reported input_tokens/output_tokens only, no cache_read), so growth
 *      is multiplied by iteration count and billed in full each time.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const BUDGET_FILE = join(__dirname, 'writer-prompt-budget.json');

/**
 * Extract a shell function verbatim by name. Verbatim matters: a restated copy would keep
 * passing after claude.sh changed, which is the failure mode this file exists to prevent.
 */
function extractFn(src: string, name: string): string {
  const lines = src.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${name}()`));
  expect(i, `${name}() not found in claude.sh — the harness is pointed at the wrong thing`)
    .toBeGreaterThan(-1);
  const j = lines.findIndex((l, k) => k > i && l === '}');
  expect(j, `${name}() has no closing brace at column 0`).toBeGreaterThan(i);
  return lines.slice(i, j + 1).join('\n');
}

/**
 * Every function the prompt builder genuinely depends on is extracted and RUN — not
 * stubbed. Stubbing the lane resolver or the notes renderer would test a lookalike and
 * leave the real ones unverified, which is the mistake this whole file exists to correct.
 */
const REAL_FNS = [
  'get_story_details',
  '_current_lane',
  '_render_technical_notes',
  '_resolve_deliverable_path',
  'build_implementation_prompt',
];

let extracted = '';
beforeAll(() => {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  extracted = REAL_FNS.map((f) => extractFn(src, f)).join('\n\n') + '\n';
});

/** A story as the PRD really carries it. */
interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  codeline?: string;
  codelines?: string[];
  technicalNotes: Record<string, unknown>;
}

/**
 * Render the prompt the writer would actually receive.
 *
 * The five helpers build_implementation_prompt calls are stubbed to emit MARKERS rather
 * than nothing, so the test can prove the real code path reached them instead of silently
 * skipping whole sections.
 */
function renderPrompt(story: Story, env: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'writer-prompt-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [story] }));

  const runner = join(dir, 'run.sh');
  writeFileSync(
    runner,
    [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      'log(){ :; }; warning(){ :; }; success(){ :; }; error(){ :; }',
      'run_dependency_check(){ :; }',
      '_discover_vendor_packages(){ :; }',
      '_generate_vendor_contract(){ :; }',
      '_module_resolution_context(){ echo "[[STUB_MODULE_RESOLUTION]]"; }',
      '_resolve_deliverable_path(){ echo "$1"; }',
      `source ${JSON.stringify(join(dir, 'fn.sh'))}`,
      `build_implementation_prompt ${JSON.stringify(story.id)}`,
    ].join('\n'),
  );
  writeFileSync(join(dir, 'fn.sh'), extracted);

  const r = spawnSync('bash', [runner], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PRD_FILE: prd,
      PROJECT_ROOT: dir,
      LOG_DIR: join(dir, 'logs'),
      SCRIPT_DIR: join(REPO_ROOT, 'orchestrations/scripts'),
      AGENT_PROFILES_FILE: '',
      ...env,
    },
  });

  const out = r.stdout || '';
  // Vacuous-pass guard: if the render collapsed, every not.toContain below would pass
  // while proving nothing. That is exactly how the original defect escaped.
  expect(r.status, `the prompt builder exited ${r.status}: ${r.stderr}`).toBe(0);
  expect(out.length, 'HARNESS FAILURE: the prompt rendered empty').toBeGreaterThan(500);
  expect(out, 'HARNESS FAILURE: the real code path never reached the helper calls')
    .toContain('[[STUB_MODULE_RESOLUTION]]');
  return out;
}

/** The live AMSD-2041 shape: one story, three repos, the same file spelled three ways. */
function threeCodelineStory(overrides: Record<string, unknown> = {}): Story {
  return {
    id: 'ST-MULTI',
    title: 'A story spanning three codelines',
    description: 'Shared hook and service initialisation across three sibling repos.',
    acceptanceCriteria: ['Behaviour A holds', 'Behaviour B holds'],
    codeline: 'alpha',
    codelines: ['alpha', 'beta', 'gamma'],
    technicalNotes: {
      files: ['src/services/thing.ts', 'src/context/ThingContext.tsx'],
      ...overrides,
    },
  };
}

describe('the writer prompt renders at all (harness fidelity)', () => {
  it('produces a real prompt for a real story', () => {
    const out = renderPrompt(threeCodelineStory());
    expect(out).toContain('ST-MULTI');
    expect(out).toContain('A story spanning three codelines');
  });

  it('carries the story description and acceptance criteria', () => {
    const out = renderPrompt(threeCodelineStory());
    expect(out).toContain('Shared hook and service initialisation');
    expect(out).toContain('Behaviour A holds');
    expect(out).toContain('Behaviour B holds');
  });

  it('names the declared deliverables the writer must produce', () => {
    const out = renderPrompt(threeCodelineStory());
    expect(out).toContain('src/services/thing.ts');
    expect(out).toContain('src/context/ThingContext.tsx');
  });
});

/**
 * INVARIANT 1 — ISOLATION. These are the assertions the 1.9M-token call needed and did
 * not have. They are written against ANY per-codeline structure, so they keep holding when
 * the manifest is reintroduced.
 */
describe('a lane is never shown another codeline', () => {
  const SIBLING_MARKERS = ['/repos/beta-checkout', '/repos/gamma-checkout'];

  it('no sibling checkout path reaches a lane-scoped prompt', () => {
    const story = threeCodelineStory({
      perCodeline: {
        alpha: { files: ['src/context/ThingContext.tsx'], root: '/repos/alpha-checkout' },
        beta: { files: ['src/context/ThingContext.ts'], root: '/repos/beta-checkout' },
        gamma: { files: ['src/context/thingContext.tsx'], root: '/repos/gamma-checkout' },
      },
    });
    const out = renderPrompt(story, { CODELINE_NAME: 'alpha' });
    for (const marker of SIBLING_MARKERS) {
      expect(
        out,
        `a sibling checkout leaked into the alpha prompt — this is exactly what sent the ` +
          `AMSD-2041 gotransit writer cross-repo for 1,916,632 input tokens`,
      ).not.toContain(marker);
    }
  });

  it('no sibling FILENAME variant reaches a lane-scoped prompt', () => {
    const story = threeCodelineStory({
      perCodeline: {
        alpha: { files: ['src/context/ThingContext.tsx'] },
        beta: { files: ['src/context/ThingContext.ts'], match: 'extension_variant' },
        gamma: { files: ['src/context/thingContext.tsx'], match: 'case_variant' },
      },
    });
    const out = renderPrompt(story, { CODELINE_NAME: 'alpha' });
    expect(out, 'a divergent sibling spelling is an invitation to go compare')
      .not.toContain('thingContext.tsx');
    expect(out).not.toContain('extension_variant');
    expect(out).not.toContain('case_variant');
  });

  it('holds for EVERY lane, not just the first', () => {
    const perCodeline = {
      alpha: { files: ['a.ts'], root: '/repos/alpha-checkout' },
      beta: { files: ['b.ts'], root: '/repos/beta-checkout' },
      gamma: { files: ['c.ts'], root: '/repos/gamma-checkout' },
    };
    for (const [lane, others] of [
      ['beta', ['/repos/alpha-checkout', '/repos/gamma-checkout']],
      ['gamma', ['/repos/alpha-checkout', '/repos/beta-checkout']],
    ] as const) {
      const out = renderPrompt(threeCodelineStory({ perCodeline }), { CODELINE_NAME: lane });
      for (const o of others) expect(out, `${lane} was shown ${o}`).not.toContain(o);
    }
  });

  /**
   * NO HARDCODED KEY NAME. Excluding one field by name leaves the next per-codeline field
   * leaking, in a different file, forever. The rule must key on SHAPE.
   */
  it('holds for a per-codeline field that is not the one we already know about', () => {
    const story = threeCodelineStory({
      someFutureMap: { alpha: 'mine', beta: 'LEAK-beta', gamma: 'LEAK-gamma' },
    });
    const out = renderPrompt(story, { CODELINE_NAME: 'alpha' });
    expect(
      out,
      'the isolation rule is keyed to a literal field name, so every future ' +
        'per-codeline field leaks again',
    ).not.toContain('LEAK-');
  });
});

/**
 * INVARIANT 2 — SIZE. Every token here is re-sent on every iteration and, with no prompt
 * caching, billed in full each time. The budget is committed alongside this test; raising
 * it is a deliberate, reviewable act, not a side effect.
 */
describe('the writer prompt stays within its token budget', () => {
  const budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as {
    baselineBytes: Record<string, number>;
    allowancePct: number;
  };

  it('a minimal single-codeline prompt has not grown', () => {
    const out = renderPrompt({
      id: 'ST-1',
      title: 'Demo story',
      description: 'A demo description.',
      acceptanceCriteria: ['AC one', 'AC two'],
      codeline: 'alpha',
      technicalNotes: { files: ['src/a.ts', 'src/b.ts'], dependsOn: ['libx'] },
    });
    const cap = Math.round(budget.baselineBytes.minimal * (1 + budget.allowancePct / 100));
    expect(
      out.length,
      `the writer prompt grew from ${budget.baselineBytes.minimal} to ${out.length} bytes. ` +
        `Every added token is re-sent on EVERY agent iteration and billed in full ` +
        `(this pipeline gets no prompt caching). If the growth is intended, raise the ` +
        `baseline in writer-prompt-budget.json deliberately.`,
    ).toBeLessThanOrEqual(cap);
  });

  it('a three-codeline prompt has not grown', () => {
    const out = renderPrompt(threeCodelineStory(), { CODELINE_NAME: 'alpha' });
    const cap = Math.round(budget.baselineBytes.threeCodeline * (1 + budget.allowancePct / 100));
    expect(out.length, `three-codeline prompt grew to ${out.length} bytes (cap ${cap})`)
      .toBeLessThanOrEqual(cap);
  });

  /**
   * The isolation fix must not be implemented by deleting the section. A lane still needs
   * its own resolved truth — that was the entire point of the manifest.
   */
  it('adding a per-codeline map does not grow the prompt proportionally to codeline count', () => {
    const plain = renderPrompt(threeCodelineStory(), { CODELINE_NAME: 'alpha' });
    const withMap = renderPrompt(
      threeCodelineStory({
        perCodeline: {
          alpha: { files: ['src/context/ThingContext.tsx'], root: '/repos/alpha-checkout' },
          beta: { files: ['src/context/ThingContext.ts'], root: '/repos/beta-checkout' },
          gamma: { files: ['src/context/thingContext.tsx'], root: '/repos/gamma-checkout' },
        },
      }),
      { CODELINE_NAME: 'alpha' },
    );
    // One lane's worth of extra detail is fine. Three lanes' worth is the defect.
    expect(
      withMap.length - plain.length,
      'the prompt grew by roughly the whole map, meaning every codeline went in',
    ).toBeLessThan(400);
  });
});
