/**
 * Self-healing audit fix #1: spec-mode-runner.js applySpecChanges had zero
 * content review before writing AC/description/title rewrites and split
 * children directly to the PRD (runs every phase, every story). This is the
 * highest-frequency unreviewed write found in the self-healing audit.
 *
 * Fix: reviewPrdChange() calls the prd-change-reviewer gate (change type
 * spec_pass) after applySpecChanges, using the before/after snapshots the
 * loop already captures. On "fail" verdict, the story's fields are reverted
 * and any split children just added to newStories are spliced back out.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const SPEC_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const PROFILES = join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const PROFILES_ORIG = join(REPO_ROOT, 'orchestrations/agents/profiles.json.original');

const src = readFileSync(SPEC_RUNNER, 'utf8');
const profiles = JSON.parse(readFileSync(PROFILES, 'utf8'));
const profilesOrig = JSON.parse(readFileSync(PROFILES_ORIG, 'utf8'));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  buildGateExec,
  parseReviewVerdict,
  reviewPrdChange,
} = require(SPEC_RUNNER);

describe('spec-mode-runner.js — buildGateExec uses the gate model, not the story-agent model', () => {
  it('defaults to minimax/MiniMax-M3 when ORCH_GATE_PROVIDER/ORCH_GATE_MODEL are unset', () => {
    const exec = buildGateExec('/path/to/ai-run.sh', {});
    expect(exec.args).toContain('minimax');
    expect(exec.args).toContain('MiniMax-M3');
  });

  it('respects ORCH_GATE_PROVIDER and ORCH_GATE_MODEL when set', () => {
    const exec = buildGateExec('/path/to/ai-run.sh', {
      ORCH_GATE_PROVIDER: 'qwen',
      ORCH_GATE_MODEL: 'z-ai/glm-5.2',
    });
    expect(exec.args).toContain('qwen');
    expect(exec.args).toContain('z-ai/glm-5.2');
  });

  it('is independent of AI_PROVIDER/AI_MODEL (the story-agent provider)', () => {
    const exec = buildGateExec('/path/to/ai-run.sh', {
      AI_PROVIDER: 'qwen',
      AI_MODEL: 'moonshotai/kimi-k2',
    });
    // Should still default to the gate model, not the story-agent model
    expect(exec.args).toContain('minimax');
    expect(exec.args).toContain('MiniMax-M3');
  });
});

describe('spec-mode-runner.js — parseReviewVerdict', () => {
  it('parses a clean JSON verdict', () => {
    const result = parseReviewVerdict('{"verdict":"fail","issues":["vague AC"],"reason":"too vague"}');
    expect(result.verdict).toBe('fail');
    expect(result.issues).toEqual(['vague AC']);
  });

  it('falls back to regex when JSON parse fails (extra text around the JSON)', () => {
    const result = parseReviewVerdict('Here is my verdict: {"verdict":"fail","issues":[]}');
    expect(result.verdict).toBe('fail');
  });

  it('defaults to pass on totally unparseable output', () => {
    const result = parseReviewVerdict('no json here at all');
    expect(result.verdict).toBe('pass');
  });

  it('defaults to pass on empty/null input', () => {
    expect(parseReviewVerdict('').verdict).toBe('pass');
    expect(parseReviewVerdict(null).verdict).toBe('pass');
  });
});

describe('spec-mode-runner.js — reviewPrdChange is non-blocking by design', () => {
  it('returns pass immediately when ORCH_GATE_PROVIDER is unset (gate not configured)', async () => {
    const prevGate = process.env.ORCH_GATE_PROVIDER;
    delete process.env.ORCH_GATE_PROVIDER;
    try {
      const result = await reviewPrdChange({
        aiRunnerCmd: '/nonexistent/ai-run.sh',
        profiles: { 'prd-change-reviewer': 'some profile' },
        storyId: 'TEST-001',
        changeType: 'spec_pass',
        before: {},
        after: {},
        logDir: null,
      });
      expect(result.verdict).toBe('pass');
    } finally {
      if (prevGate !== undefined) process.env.ORCH_GATE_PROVIDER = prevGate;
    }
  });

  it('returns pass when prd-change-reviewer profile is missing', async () => {
    const prevGate = process.env.ORCH_GATE_PROVIDER;
    process.env.ORCH_GATE_PROVIDER = 'minimax';
    try {
      const result = await reviewPrdChange({
        aiRunnerCmd: '/nonexistent/ai-run.sh',
        profiles: {},
        storyId: 'TEST-001',
        changeType: 'spec_pass',
        before: {},
        after: {},
        logDir: null,
      });
      expect(result.verdict).toBe('pass');
    } finally {
      if (prevGate !== undefined) process.env.ORCH_GATE_PROVIDER = prevGate;
      else delete process.env.ORCH_GATE_PROVIDER;
    }
  });

  it('defaults to pass when the gate call itself throws (non-blocking contract)', async () => {
    const prevGate = process.env.ORCH_GATE_PROVIDER;
    process.env.ORCH_GATE_PROVIDER = 'minimax';
    try {
      const result = await reviewPrdChange({
        aiRunnerCmd: '/definitely/does/not/exist/ai-run.sh',
        profiles: { 'prd-change-reviewer': 'some profile' },
        storyId: 'TEST-001',
        changeType: 'spec_pass',
        before: { acceptanceCriteria: ['a'] },
        after: { acceptanceCriteria: ['a', 'b'] },
        logDir: null,
      });
      expect(result.verdict).toBe('pass');
    } finally {
      if (prevGate !== undefined) process.env.ORCH_GATE_PROVIDER = prevGate;
      else delete process.env.ORCH_GATE_PROVIDER;
    }
  }, 15000);
});

describe('spec-mode-runner.js — reviewer wired into the main story loop', () => {
  it('calls reviewPrdChange after applySpecChanges, before the JSONL log entry', () => {
    // `const changes` -> `let changes` (2026-07-13): needs to be reassignable
    // for the AC-review retry loop's re-application on each retry attempt.
    const applyIdx = src.indexOf('let changes = applySpecChanges(');
    const reviewIdx = src.indexOf('reviewPrdChange({');
    const logIdx = src.indexOf('appendJsonl(specLogPath,');
    expect(applyIdx).toBeGreaterThan(-1);
    expect(reviewIdx).toBeGreaterThan(applyIdx);
    expect(logIdx).toBeGreaterThan(reviewIdx);
  });

  it('only calls the reviewer when something actually changed (AC, split, description, title, or technicalNotes)', () => {
    const idx = src.indexOf('const anyFieldChanged =');
    const block = src.slice(idx, idx + 500);
    expect(block).toMatch(/changes\.acceptanceChanged/);
    expect(block).toMatch(/changes\.splitCount > 0/);
    expect(block).toMatch(/afterSnapshot\.description !== beforeSnapshot\.description/);
    expect(block).toMatch(/afterSnapshot\.title !== beforeSnapshot\.title/);
    expect(block).toMatch(/afterSnapshot\.technicalNotes/);
  });

  it('the guard checks the full snapshot, not just acceptanceChanged (a description/title-only rewrite must not slip through)', () => {
    const idx = src.indexOf('if (anyFieldChanged) {');
    expect(idx).toBeGreaterThan(-1);
    const reviewIdx = src.indexOf('reviewPrdChange({');
    expect(reviewIdx).toBeGreaterThan(idx);
  });

  it('passes change type "spec_pass" to the reviewer', () => {
    const reviewIdx = src.indexOf('reviewPrdChange({');
    const block = src.slice(reviewIdx, reviewIdx + 300);
    expect(block).toMatch(/changeType:\s*'spec_pass'/);
  });

  it('reverts acceptanceCriteria, description, title, and technicalNotes on reject', () => {
    // Anchor updated (2026-07-13): a retry-on-violation loop was added
    // between the initial reviewPrdChange call and this final revert block
    // — its own `while (reviewResult.verdict === 'fail' ...)` condition now
    // matches "verdict === 'fail'" FIRST. Anchor on the final `if (...) {`
    // revert block specifically (unchanged shape, just further down).
    const rejectIdx = src.indexOf("if (reviewResult.verdict === 'fail') {");
    const block = src.slice(rejectIdx, rejectIdx + 600);
    expect(block).toMatch(/story\.acceptanceCriteria = beforeSnapshot\.acceptanceCriteria/);
    expect(block).toMatch(/story\.description = beforeSnapshot\.description/);
    expect(block).toMatch(/story\.title = beforeSnapshot\.title/);
    expect(block).toMatch(/story\.technicalNotes = beforeSnapshot\.technicalNotes/);
  });

  it('splices split children just added by this agent call back out of newStories on reject', () => {
    // Anchor updated (2026-07-13): a retry-on-violation loop was added
    // between the initial reviewPrdChange call and this final revert block
    // — its own `while (reviewResult.verdict === 'fail' ...)` condition now
    // matches "verdict === 'fail'" FIRST. Anchor on the final `if (...) {`
    // revert block specifically (unchanged shape, just further down).
    const rejectIdx = src.indexOf("if (reviewResult.verdict === 'fail') {");
    const block = src.slice(rejectIdx, rejectIdx + 600);
    expect(block).toMatch(/newStories\.splice\(newStoriesCountBefore/);
  });

  it('resets changes.acceptanceChanged and changes.splitCount to false/0 on reject (stats stay accurate)', () => {
    // Anchor updated (2026-07-13): a retry-on-violation loop was added
    // between the initial reviewPrdChange call and this final revert block
    // — its own `while (reviewResult.verdict === 'fail' ...)` condition now
    // matches "verdict === 'fail'" FIRST. Anchor on the final `if (...) {`
    // revert block specifically (unchanged shape, just further down).
    const rejectIdx = src.indexOf("if (reviewResult.verdict === 'fail') {");
    const block = src.slice(rejectIdx, rejectIdx + 900);
    expect(block).toMatch(/changes\.acceptanceChanged = false/);
    expect(block).toMatch(/changes\.splitCount = 0/);
  });

  it('recomputes afterSnapshot post-revert so downstream logging reflects the reverted state', () => {
    // Anchor updated (2026-07-13): a retry-on-violation loop was added
    // between the initial reviewPrdChange call and this final revert block
    // — its own `while (reviewResult.verdict === 'fail' ...)` condition now
    // matches "verdict === 'fail'" FIRST. Anchor on the final `if (...) {`
    // revert block specifically (unchanged shape, just further down).
    const rejectIdx = src.indexOf("if (reviewResult.verdict === 'fail') {");
    const block = src.slice(rejectIdx, rejectIdx + 900);
    expect(block).toMatch(/afterSnapshot = captureStorySnapshot\(story\)/);
  });

  it('exports reviewPrdChange, buildGateExec, and parseReviewVerdict for testability', () => {
    expect(src).toMatch(/reviewPrdChange,/);
    expect(src).toMatch(/buildGateExec,/);
    expect(src).toMatch(/parseReviewVerdict,/);
  });
});

describe('prd-change-reviewer — spec_pass change type coverage', () => {
  const reviewer: string = profiles['prd-change-reviewer'];

  it('documents spec_pass as a recognized change type', () => {
    expect(reviewer).toMatch(/spec_pass/);
  });

  it('rejects vague/unmeasurable ACs in the AFTER state', () => {
    expect(reviewer).toMatch(/vague or unmeasurable/i);
  });

  it('rejects description/AC contradiction', () => {
    expect(reviewer).toMatch(/description no longer matches/i);
  });

  it('rejects HOW-not-WHAT implementation instructions in ACs', () => {
    expect(reviewer).toMatch(/implementation instructions/i);
  });

  it('rejects generic/uninformative titles', () => {
    expect(reviewer).toMatch(/generic or uninformative/i);
  });

  it('is present identically in profiles.json.original', () => {
    expect(profilesOrig['prd-change-reviewer']).toBe(reviewer);
  });
});
