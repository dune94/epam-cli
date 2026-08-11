/**
 * TC-fact-density split mandate + VERY HIGH complexity ceiling-model
 * assignment.
 *
 * Root cause this fixes (found live, 2026-07-14, tier3-travel-app run):
 * SKY-003-test had a modest 8 acceptanceCriteria (well under
 * SPLIT_MANDATE_AC_THRESHOLD=12, the existing spec-pass-time split mandate)
 * but 20 testCriteria.facts + 19 bannedPatterns crammed into ONE test file
 * — a density signal only known post-impl (when the inline TC writer
 * populates facts), not at spec-pass time. Every model at every escalation
 * rung, up to the ceiling (z-ai/glm-5.1), produced widespread syntax
 * corruption (30+ tsc errors) on it, 8/8 attempts, before HealingBroken
 * aborted the story at max rung.
 *
 * User directive (2026-07-15): "Split-mandate to cover TC-fact density
 * needs to be covered for test stories. As well - for VERY HIGH complexity
 * stories, starting with the most appropriate high model and avoiding
 * ladder assignment is an option. Only for VERY HIGH complexity."
 *
 * Two independent mechanisms, both wired at lib/tc-writer-gate.sh's
 * run_inline_tc_writer_gate() — the one point TC-fact density is actually
 * known, before the story's own implementation begins:
 *   1. checkTcFactDensityMandate/splitTestStoryByFacts (spec-mode-runner.js)
 *      — facts alone exceed EPAM_TC_FACTS_SPLIT_THRESHOLD (default 30):
 *      partition the test file into multiple stories (no LLM judgment
 *      needed — each fact is already an atomic, independent assertion).
 *   2. _tc_writer_gate_maybe_mark_very_high_complexity (lib/tc-writer-gate.sh)
 *      — facts + bannedPatterns combined exceed
 *      EPAM_TC_VERY_HIGH_CONSTRAINTS_THRESHOLD (default 30): assign the
 *      ceiling model directly and set skipLadder=true, so claude.sh's
 *      InferenceLadder doesn't burn several guaranteed-failing attempts
 *      climbing rung-by-rung to a model already known to be needed.
 * A mirrored, AC-count-based veryHighComplexity signal also exists in
 * modelComplexitySignals() for non-test (impl) stories, applied at
 * spec-pass time (Step 5 model re-assessment).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SPEC_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const GATE_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/tc-writer-gate.sh');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const specMode = require(SPEC_RUNNER);
const specSrc = readFileSync(SPEC_RUNNER, 'utf8');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const gateSrc = readFileSync(GATE_LIB, 'utf8');

function makeStory(id: string, overrides: Record<string, unknown> = {}) {
  return { id, title: `Story ${id}`, acceptanceCriteria: ['ac1', 'ac2'], status: 'pending', completed: false, ...overrides };
}

// ── checkTcFactDensityMandate — pure function ────────────────────────────────

describe('checkTcFactDensityMandate — pure function', () => {
  it('does not violate at or below the default threshold (30)', () => {
    expect(specMode.checkTcFactDensityMandate(30).violated).toBe(false);
    expect(specMode.checkTcFactDensityMandate(20).violated).toBe(false);
  });

  it('violates above the default threshold', () => {
    const result = specMode.checkTcFactDensityMandate(31);
    expect(result.violated).toBe(true);
    expect(result.reason).toMatch(/31 testCriteria\.facts/);
    expect(result.reason).toMatch(/split into multiple test stories/i);
  });

  it('respects a custom threshold argument', () => {
    expect(specMode.checkTcFactDensityMandate(20, 15).violated).toBe(true);
    expect(specMode.checkTcFactDensityMandate(10, 15).violated).toBe(false);
  });

  it('TC_FACTS_SPLIT_THRESHOLD default is exported and is 30', () => {
    expect(specMode.TC_FACTS_SPLIT_THRESHOLD).toBe(30);
  });
});

// ── splitTestStoryByFacts — real execution ───────────────────────────────────

describe('splitTestStoryByFacts — real execution', () => {
  it('REPRODUCES the exact live scenario: 35 facts on one test file splits into 2 children with a fair partition', () => {
    const facts = Array.from({ length: 35 }, (_, i) => `fact ${i + 1}`);
    const story = makeStory('SKY-003-test', {
      technicalNotes: { files: ['src/cli.test.ts'] },
      testCriteria: { facts, sourceFiles: ['src/cli.ts'], mockStrategy: 'vi.mock', bannedPatterns: ['x'], implStory: 'SKY-003-impl' },
    });
    const prd = { stories: [story], implementationOrder: { core: ['SKY-003-test'] } };

    const result = specMode.splitTestStoryByFacts(story, prd, 'core', 30);

    expect(result.splitCount).toBe(2);
    expect(result.childIds).toEqual(['SKY-003-test-tc1', 'SKY-003-test-tc2']);

    const child1 = prd.stories.find((s: any) => s.id === 'SKY-003-test-tc1');
    const child2 = prd.stories.find((s: any) => s.id === 'SKY-003-test-tc2');
    expect(child1.testCriteria.facts).toHaveLength(30);
    expect(child2.testCriteria.facts).toHaveLength(5);
    // Lossless, non-overlapping partition
    const unionFacts = [...child1.testCriteria.facts, ...child2.testCriteria.facts];
    expect(unionFacts).toEqual(facts);

    // Distinct test files, both derived generically from the parent's filename
    expect(child1.technicalNotes.files).toEqual(['src/cli.tc1.test.ts']);
    expect(child2.technicalNotes.files).toEqual(['src/cli.tc2.test.ts']);

    // Shared (non-partitioned) testCriteria fields copied to both children
    expect(child1.testCriteria.sourceFiles).toEqual(['src/cli.ts']);
    expect(child1.testCriteria.bannedPatterns).toEqual(['x']);
    expect(child1.testCriteria.implStory).toBe('SKY-003-impl');

    // Parent delegated (same convention as the AC-based split)
    expect(story.status).toBe('deprecated');
    expect(story.completed).toBe(true);
    expect(story.acceptanceCriteria[0]).toMatch(/Delegated to TC-density split children/);
    expect(story.acceptanceCriteria[0]).toContain('SKY-003-test-tc1');
    expect(story.acceptanceCriteria[0]).toContain('SKY-003-test-tc2');

    // implementationOrder: parent replaced by children, in place
    expect(prd.implementationOrder.core).toEqual(['SKY-003-test-tc1', 'SKY-003-test-tc2']);
  });

  it('does not split when facts are at or below maxFactsPerChild', () => {
    const story = makeStory('SKY-X', {
      technicalNotes: { files: ['src/a.test.ts'] },
      testCriteria: { facts: Array.from({ length: 30 }, (_, i) => `f${i}`) },
    });
    const prd = { stories: [story], implementationOrder: { core: ['SKY-X'] } };
    const result = specMode.splitTestStoryByFacts(story, prd, 'core', 30);
    expect(result.splitCount).toBe(0);
    expect(story.status).not.toBe('deprecated');
    expect(prd.stories).toHaveLength(1);
  });

  it('does not split a combo story (impl + test files together)', () => {
    const story = makeStory('SKY-COMBO', {
      technicalNotes: { files: ['src/a.ts', 'src/a.test.ts'] },
      testCriteria: { facts: Array.from({ length: 40 }, (_, i) => `f${i}`) },
    });
    const prd = { stories: [story], implementationOrder: { core: ['SKY-COMBO'] } };
    const result = specMode.splitTestStoryByFacts(story, prd, 'core', 30);
    expect(result.splitCount).toBe(0);
  });

  it('does not split a story with multiple test files (no single filename to derive children from)', () => {
    const story = makeStory('SKY-MULTI', {
      technicalNotes: { files: ['src/a.test.ts', 'src/b.test.ts'] },
      testCriteria: { facts: Array.from({ length: 40 }, (_, i) => `f${i}`) },
    });
    const prd = { stories: [story], implementationOrder: { core: ['SKY-MULTI'] } };
    const result = specMode.splitTestStoryByFacts(story, prd, 'core', 30);
    expect(result.splitCount).toBe(0);
  });

  it('does not split an already-deprecated story', () => {
    const story = makeStory('SKY-DEP', {
      status: 'deprecated',
      technicalNotes: { files: ['src/a.test.ts'] },
      testCriteria: { facts: Array.from({ length: 40 }, (_, i) => `f${i}`) },
    });
    const prd = { stories: [story], implementationOrder: { core: ['SKY-DEP'] } };
    const result = specMode.splitTestStoryByFacts(story, prd, 'core', 30);
    expect(result.splitCount).toBe(0);
  });

  it('a story with zero facts is not split (nothing to partition)', () => {
    const story = makeStory('SKY-EMPTY', {
      technicalNotes: { files: ['src/a.test.ts'] },
      testCriteria: { facts: [] },
    });
    const prd = { stories: [story], implementationOrder: { core: ['SKY-EMPTY'] } };
    const result = specMode.splitTestStoryByFacts(story, prd, 'core', 30);
    expect(result.splitCount).toBe(0);
  });

  it('handles a .spec.ts file with the same generic filename-derivation logic', () => {
    const facts = Array.from({ length: 35 }, (_, i) => `f${i}`);
    const story = makeStory('SKY-SPEC', {
      technicalNotes: { files: ['src/widget.spec.ts'] },
      testCriteria: { facts },
    });
    const prd = { stories: [story], implementationOrder: { core: ['SKY-SPEC'] } };
    const result = specMode.splitTestStoryByFacts(story, prd, 'core', 30);
    expect(result.splitCount).toBe(2);
    const child1 = prd.stories.find((s: any) => s.id === 'SKY-SPEC-tc1');
    expect(child1.technicalNotes.files).toEqual(['src/widget.tc1.spec.ts']);
  });
});

// ── --split-test-story CLI dispatch — real execution ─────────────────────────

describe('spec-mode-runner.js --split-test-story CLI — REAL execution', () => {
  it('splits a real PRD file on disk and writes it back atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'split-test-story-cli-'));
    try {
      const prdPath = join(dir, 'prd.json');
      const facts = Array.from({ length: 35 }, (_, i) => `fact ${i + 1}`);
      const prd = {
        stories: [makeStory('SKY-CLI', { technicalNotes: { files: ['src/cli.test.ts'] }, testCriteria: { facts } })],
        implementationOrder: { core: ['SKY-CLI'] },
      };
      writeFileSync(prdPath, JSON.stringify(prd, null, 2));

      const nodeBin = (() => {
        try { return execFileSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).trim(); } catch { return 'node'; }
      })();
      const stdout = execFileSync(nodeBin, [SPEC_RUNNER, '--split-test-story', prdPath, 'SKY-CLI'], { encoding: 'utf8' });
      expect(stdout).toMatch(/SKY-CLI-tc1, SKY-CLI-tc2/);

      const updated = JSON.parse(readFileSync(prdPath, 'utf8'));
      expect(updated.stories.map((s: any) => s.id).sort()).toEqual(['SKY-CLI', 'SKY-CLI-tc1', 'SKY-CLI-tc2']);
      const parent = updated.stories.find((s: any) => s.id === 'SKY-CLI');
      expect(parent.status).toBe('deprecated');
      expect(updated.implementationOrder.core).toEqual(['SKY-CLI-tc1', 'SKY-CLI-tc2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when the story is not eligible to split (facts below threshold)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'split-test-story-cli-ineligible-'));
    try {
      const prdPath = join(dir, 'prd.json');
      const prd = {
        stories: [makeStory('SKY-SMALL', { technicalNotes: { files: ['src/a.test.ts'] }, testCriteria: { facts: ['f1'] } })],
        implementationOrder: { core: ['SKY-SMALL'] },
      };
      writeFileSync(prdPath, JSON.stringify(prd, null, 2));
      const nodeBin = (() => {
        try { return execFileSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).trim(); } catch { return 'node'; }
      })();
      let exitCode = 0;
      try {
        execFileSync(nodeBin, [SPEC_RUNNER, '--split-test-story', prdPath, 'SKY-SMALL'], { encoding: 'utf8' });
      } catch (e: any) {
        exitCode = e.status ?? -1;
      }
      expect(exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── modelComplexitySignals — veryHighComplexity signal ───────────────────────

describe('modelComplexitySignals — veryHighComplexity (impl-story AC-count based)', () => {
  it('does not flag veryHighComplexity at or below the default threshold (20)', () => {
    const story = makeStory('SKY-Y', { acceptanceCriteria: Array.from({ length: 20 }, (_, i) => `ac${i}`) });
    expect(specMode.modelComplexitySignals(story).veryHighComplexity).toBe(false);
  });

  it('flags veryHighComplexity above the default threshold', () => {
    const story = makeStory('SKY-Z', { acceptanceCriteria: Array.from({ length: 21 }, (_, i) => `ac${i}`) });
    const signals = specMode.modelComplexitySignals(story);
    expect(signals.veryHighComplexity).toBe(true);
    expect(signals.veryHighReason).toMatch(/21 acceptance criteria/);
  });

  it('is independent of the existing needsUpgrade signal (both can be true)', () => {
    const story = makeStory('SKY-BOTH', {
      acceptanceCriteria: Array.from({ length: 25 }, (_, i) => `ac${i}`),
      technicalNotes: { files: ['src/single.ts'] },
    });
    const signals = specMode.modelComplexitySignals(story);
    expect(signals.needsUpgrade).toBe(true);
    expect(signals.veryHighComplexity).toBe(true);
  });
});

// ── lib/tc-writer-gate.sh — _tc_writer_gate_maybe_split_test_story ───────────

function extractFunctionBody(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name} not found`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`Could not find end of ${name}`);
}

describe('lib/tc-writer-gate.sh — _tc_writer_gate_maybe_split_test_story, REAL execution', () => {
  function run(opts: { facts: number; threshold?: string; nodeBin?: string }): { rc: number; stdout: string; prd: any } {
    const dir = mkdtempSync(join(tmpdir(), 'gate-split-'));
    try {
      const prdPath = join(dir, 'prd.json');
      const facts = Array.from({ length: opts.facts }, (_, i) => `f${i}`);
      const prd = {
        stories: [makeStory('SKY-GATE', { technicalNotes: { files: ['src/gate.test.ts'] }, testCriteria: { facts } })],
        implementationOrder: { core: ['SKY-GATE'] },
      };
      writeFileSync(prdPath, JSON.stringify(prd, null, 2));

      const fnBody = extractFunctionBody(gateSrc, '_tc_writer_gate_maybe_split_test_story');
      const nodeBin = opts.nodeBin ?? (() => {
        try { return execFileSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).trim(); } catch { return 'node'; }
      })();
      const script = [
        '#!/usr/bin/env bash',
        `PRD_FILE=${JSON.stringify(prdPath)}`,
        `LOG_DIR=${JSON.stringify(dir)}`,
        `SCRIPT_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts'))}`,
        `NODE_CMD=${JSON.stringify(nodeBin)}`,
        opts.threshold ? `EPAM_TC_FACTS_SPLIT_THRESHOLD=${opts.threshold}` : '',
        'log() { echo "LOG: $*" >&2; }',
        'warning() { echo "WARN: $*" >&2; }',
        'success() { echo "SUCCESS: $*" >&2; }',
        fnBody,
        '_tc_writer_gate_maybe_split_test_story "SKY-GATE" "core" ' + opts.facts,
        'echo "RC=$?"',
      ].filter(Boolean).join('\n');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, script);
      let stdout = '';
      try {
        stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      } catch (e: any) {
        stdout = ((e.stdout ?? '').toString()) + ((e.stderr ?? '').toString());
      }
      const rcMatch = stdout.match(/RC=(\d)/);
      const prdAfter = JSON.parse(readFileSync(prdPath, 'utf8'));
      return { rc: rcMatch ? parseInt(rcMatch[1], 10) : -1, stdout, prd: prdAfter };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('splits and returns 0 when facts exceed the threshold', () => {
    const { rc, prd } = run({ facts: 35 });
    expect(rc).toBe(0);
    expect(prd.stories.map((s: any) => s.id).sort()).toEqual(['SKY-GATE', 'SKY-GATE-tc1', 'SKY-GATE-tc2']);
  });

  it('does not split and returns 1 when facts are at or below the threshold', () => {
    const { rc, prd } = run({ facts: 20 });
    expect(rc).toBe(1);
    expect(prd.stories).toHaveLength(1);
  });

  it('respects a custom EPAM_TC_FACTS_SPLIT_THRESHOLD', () => {
    const { rc, prd } = run({ facts: 20, threshold: '15' });
    expect(rc).toBe(0);
    expect(prd.stories.length).toBeGreaterThan(1);
  });
});

// ── lib/tc-writer-gate.sh — _tc_writer_gate_maybe_mark_very_high_complexity ──

describe('lib/tc-writer-gate.sh — _tc_writer_gate_maybe_mark_very_high_complexity, REAL execution', () => {
  function run(opts: {
    facts: number;
    bannedPatterns: number;
    threshold?: string;
    ceilingModel?: string;
    ceilingProvider?: string;
  }): { prd: any; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gate-veryhigh-'));
    try {
      const prdPath = join(dir, 'prd.json');
      const prd = {
        stories: [makeStory('SKY-VH', {
          model: 'MiniMax-M3',
          aiProvider: 'minimax',
          testCriteria: { facts: [], bannedPatterns: Array.from({ length: opts.bannedPatterns }, (_, i) => `b${i}`) },
        })],
      };
      writeFileSync(prdPath, JSON.stringify(prd, null, 2));

      const fnBody = extractFunctionBody(gateSrc, '_tc_writer_gate_maybe_mark_very_high_complexity');
      const script = [
        '#!/usr/bin/env bash',
        `PRD_FILE=${JSON.stringify(prdPath)}`,
        opts.threshold ? `EPAM_TC_VERY_HIGH_CONSTRAINTS_THRESHOLD=${opts.threshold}` : '',
        opts.ceilingModel ? `EPAM_VERY_HIGH_COMPLEXITY_MODEL=${JSON.stringify(opts.ceilingModel)}` : '',
        opts.ceilingProvider ? `EPAM_VERY_HIGH_COMPLEXITY_PROVIDER=${JSON.stringify(opts.ceilingProvider)}` : '',
        'log() { echo "LOG: $*" >&2; }',
        'warning() { echo "WARN: $*" >&2; }',
        'success() { echo "SUCCESS: $*" >&2; }',
        fnBody,
        `_tc_writer_gate_maybe_mark_very_high_complexity "SKY-VH" ${opts.facts}`,
      ].filter(Boolean).join('\n');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, script);
      let stderr = '';
      try {
        execFileSync('bash', [scriptPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e: any) {
        stderr = (e.stderr ?? '').toString();
      }
      const prdAfter = JSON.parse(readFileSync(prdPath, 'utf8'));
      return { prd: prdAfter, stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live scenario: 20 facts + 19 bannedPatterns (combined 39) exceeds the default threshold (30) — assigns ceiling model + skipLadder', () => {
    const { prd } = run({ facts: 20, bannedPatterns: 19, ceilingModel: 'z-ai/glm-5.1', ceilingProvider: 'qwen' });
    const story = prd.stories.find((s: any) => s.id === 'SKY-VH');
    expect(story.model).toBe('z-ai/glm-5.1');
    expect(story.aiProvider).toBe('qwen');
    expect(story.skipLadder).toBe(true);
    expect(story.specification.veryHighComplexity.reason).toMatch(/facts=20/);
    expect(story.specification.veryHighComplexity.reason).toMatch(/bannedPatterns=19/);
  });

  it('does not mark very-high when combined density is at or below the threshold', () => {
    const { prd } = run({ facts: 10, bannedPatterns: 10, ceilingModel: 'z-ai/glm-5.1' });
    const story = prd.stories.find((s: any) => s.id === 'SKY-VH');
    expect(story.model).toBe('MiniMax-M3');
    expect(story.skipLadder).toBeUndefined();
  });

  it('is a no-op when no ceiling model is configured (neither EPAM_VERY_HIGH_COMPLEXITY_MODEL nor EPAM_FINAL_FALLBACK_MODEL)', () => {
    const { prd } = run({ facts: 20, bannedPatterns: 19 });
    const story = prd.stories.find((s: any) => s.id === 'SKY-VH');
    expect(story.model).toBe('MiniMax-M3');
    expect(story.skipLadder).toBeUndefined();
  });

  it('respects a custom EPAM_TC_VERY_HIGH_CONSTRAINTS_THRESHOLD', () => {
    const { prd } = run({ facts: 5, bannedPatterns: 5, threshold: '8', ceilingModel: 'z-ai/glm-5.1' });
    const story = prd.stories.find((s: any) => s.id === 'SKY-VH');
    expect(story.model).toBe('z-ai/glm-5.1');
    expect(story.skipLadder).toBe(true);
  });
});

// ── run_inline_tc_writer_gate — priority wiring (static) ─────────────────────

describe('run_inline_tc_writer_gate — split takes priority over very-high and the mild upgrade (static)', () => {
  it('calls the split check before the very-high check and the mild upgrade, on the success path', () => {
    const successIdx = gateSrc.indexOf('success "  TC writer populated testCriteria for $story_id');
    const splitIdx = gateSrc.indexOf('_tc_writer_gate_maybe_split_test_story', successIdx);
    const veryHighIdx = gateSrc.indexOf('_tc_writer_gate_maybe_mark_very_high_complexity', successIdx);
    const upgradeIdx = gateSrc.indexOf('_tc_writer_gate_maybe_upgrade_model "$story_id"', successIdx);
    expect(successIdx).toBeGreaterThan(-1);
    expect(splitIdx).toBeGreaterThan(successIdx);
    expect(veryHighIdx).toBeGreaterThan(splitIdx);
    expect(upgradeIdx).toBeGreaterThan(veryHighIdx);
  });

  it('returns 1 (caller must skip — story is now deprecated) when a split happens', () => {
    const splitIdx = gateSrc.indexOf('if _tc_writer_gate_maybe_split_test_story');
    expect(splitIdx).toBeGreaterThan(-1);
    const block = gateSrc.slice(splitIdx, splitIdx + 700);
    expect(block).toMatch(/^if _tc_writer_gate_maybe_split_test_story .*; then/);
    expect(block).toContain('return 1');
  });
});

// ── _tc_writer_gate_maybe_upgrade_model — must not downgrade from ceiling ──────

describe('_tc_writer_gate_maybe_upgrade_model — skips when skipLadder already set', () => {
  it('reads .skipLadder from PRD and returns early when true (static guard)', () => {
    const fnBody = extractFunctionBody(gateSrc, '_tc_writer_gate_maybe_upgrade_model');
    // Must check skipLadder before touching the model
    expect(fnBody).toContain('skipLadder');
    expect(fnBody).toMatch(/\[\s*"\$_skip_ladder"\s*=\s*"true"\s*\]/);
    expect(fnBody).toContain('return 0');
  });

  it('skipLadder guard appears before the current_model read (prevents mid-tier downgrade)', () => {
    const fnBody = extractFunctionBody(gateSrc, '_tc_writer_gate_maybe_upgrade_model');
    const skipIdx    = fnBody.indexOf('_skip_ladder');
    const modelIdx   = fnBody.indexOf('current_model');
    expect(skipIdx).toBeGreaterThan(-1);
    expect(modelIdx).toBeGreaterThan(-1);
    expect(skipIdx).toBeLessThan(modelIdx);
  });

  it('REPRODUCES live bug: very-high fires (sets skipLadder=true + ceiling), then upgrade must NOT downgrade to ORCH_UPGRADE_MODEL', async () => {
    // Arrange: story at ceiling model with skipLadder=true (as set by very-high gate)
    const tmpDir = mkdtempSync(join(tmpdir(), 'upgrade-skip-'));
    const prdPath = join(tmpDir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify({
      stories: [{
        id: 'SKY-VH2',
        model: 'moonshotai/kimi-k2',
        aiProvider: 'qwen',
        skipLadder: true,
        technicalNotes: { files: ['src/client.test.ts'] },
        testCriteria: { facts: Array.from({ length: 19 }, (_, i) => `fact-${i}`) },
      }],
    }));

    const env = {
      ...process.env,
      PRD_FILE: prdPath,
      PROJECT_ROOT: tmpDir,
      ORCH_UPGRADE_MODEL: 'MiniMax-M3',
      EPAM_TC_FACTS_UPGRADE_THRESHOLD: '15',
    };
    const script = `
      source "${join(REPO_ROOT, 'orchestrations/scripts/lib/tc-writer-gate.sh')}"
      _tc_writer_gate_maybe_upgrade_model "SKY-VH2" 19
    `;
    execFileSync('bash', ['-c', script], { env, stdio: 'pipe' });

    const story = JSON.parse(readFileSync(prdPath, 'utf8')).stories[0];
    // Model must NOT have been touched — still at ceiling kimi-k2
    expect(story.model).toBe('moonshotai/kimi-k2');
    expect(story.skipLadder).toBe(true);

    rmSync(tmpDir, { recursive: true });
  });
});

// ── claude.sh InferenceLadder — skipLadder wiring (static) ───────────────────

describe('claude.sh InferenceLadder — skipLadder (VERY HIGH complexity) skips model reassignment, keeps effort escalation', () => {
  it('reads .skipLadder from the PRD once per retry, before the rung case statement', () => {
    expect(claudeSrc).toContain("'.stories[] | select(.id == $id) | .skipLadder // false'");
  });

  it('Rung 2: skipLadder=true only prevents downgrade — model still escalates when a higher step exists', () => {
    // New semantics (2026-07-16): skipLadder=true means downgrade prevention only.
    // Extract the Rung 2 case block using content-bounded anchors, not a fixed char window.
    const rung2Start = claudeSrc.indexOf('Rung 2: model escalation');
    const rung2End   = claudeSrc.indexOf(';;', rung2Start);
    const block = claudeSrc.slice(rung2Start, rung2End);
    // Log still references skipLadder=true but only when no higher step found (else branch)
    expect(block).toMatch(/InferenceLadder\[Rung2\/R\$\{retry_count\}\]: skipLadder=true.*ceiling/);
    // skipLadder guard is NOT the outer gate — escalation path is not skipped wholesale
    expect(block).not.toMatch(/if \[ "\$_skip_ladder" = "true" \]; then\s*\n\s*log.*Rung2.*keeping/);
  });

  it('Rung 3: skipLadder=true only prevents downgrade — model still escalates when a higher step exists', () => {
    // Extract the Rung 3 case block using content-bounded anchors, not a fixed char window.
    const rung3Start = claudeSrc.indexOf('Rung 3+: escalate to the strongest configured model');
    const rung3End   = claudeSrc.indexOf(';;', rung3Start);
    const block = claudeSrc.slice(rung3Start, rung3End);
    // Log still references skipLadder=true but only when no higher step found (else branch)
    expect(block).toMatch(/InferenceLadder\[Rung3\/R\$\{retry_count\}\]: skipLadder=true.*ceiling/);
  });

  it('reasoning-effort and iteration-budget escalation are NOT inside the skipLadder-guarded model-switching branches (still apply when skipLadder=true)', () => {
    // Anchor to Rung 2's own skipLadder check specifically (Rung 1 also
    // contains the literal text "effort → medium" in its unrelated log
    // line, so search from there, not from the top of the whole ladder
    // block).
    const rung2SkipIdx = claudeSrc.indexOf('InferenceLadder[Rung2/R${retry_count}]: skipLadder=true');
    expect(rung2SkipIdx).toBeGreaterThan(-1);
    // The export is now wrapped in max_effort, so effort can only ever RISE as rungs climb.
    // The invariant this test guards is the PLACEMENT — outside the skipLadder if/else — which
    // is unchanged.
    const rung2End = claudeSrc.indexOf('export EPAM_REASONING_EFFORT="$(max_effort', rung2SkipIdx);
    const rung2Block = claudeSrc.slice(rung2SkipIdx, rung2End + 220);
    // EPAM_REASONING_EFFORT=... must appear OUTSIDE the skipLadder if/else
    // (after the closing fi of the inner if), so it always runs regardless of
    // skipLadder — same unconditional `fi \n export EPAM_REASONING_EFFORT`
    // pattern as before this change. Now env-overridable via
    // EPAM_RUNG2_REASONING_EFFORT — default raised to "high" 2026-08-10 (operator rule:
    // effort must never decrease as rungs climb; rung 2 defaulting to "medium" undercut rung 1).
    expect(rung2Block).toMatch(/fi\s*\n\s*fi\s*\n\s*export EPAM_REASONING_EFFORT="\$\(max_effort/);
    expect(rung2Block).toContain('EPAM_RUNG2_REASONING_EFFORT:-high');
  });
});

// ── Priority design note: split (facts alone) vs very-high (combined) ───────

describe('Design invariant: split threshold (facts alone) and very-high threshold (facts+bannedPatterns) are independently configurable', () => {
  it('a story with facts alone below the split threshold, but combined density above the very-high threshold, gets very-high treatment without splitting', () => {
    // SKY-003-test's exact live shape: 20 facts (< 30 default split
    // threshold, so no split) + 19 bannedPatterns (combined 39 > 30
    // default very-high threshold, so ceiling model + skipLadder).
    const splitCheck = specMode.checkTcFactDensityMandate(20);
    expect(splitCheck.violated).toBe(false);
    // The combined-density check itself lives in bash (gate lib), already
    // covered by the REAL-execution describe block above with the exact
    // 20+19 shape — this test just documents the JS-side half of that
    // invariant (split threshold alone does not trigger here).
  });
});
