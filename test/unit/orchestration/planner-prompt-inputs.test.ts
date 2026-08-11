/**
 * Verifies that LLM entry points receive the inputs they need.
 *
 * Root cause (found live 2026-07-15): run_planning_phase() sent only title +
 * ACs to the planner. The planner had no knowledge of technicalNotes.files
 * (the declared output paths) and hallucinated a tests/ directory structure
 * instead of the correct src/skyscanner/ path. The executor followed the
 * wrong plan, every WriteFile targeted a non-existent directory, and the
 * agent exhausted 151,704 input tokens trying to recover before the context
 * window was full.
 *
 * review_and_correct_plan() only checked import/dependency path consistency —
 * it had no way to catch output-path hallucinations because it didn't know
 * what files the story was supposed to create.
 *
 * Both functions now receive technicalNotes.files explicitly. This test file
 * confirms those inputs are actually present in the prompts sent to ai-run.sh,
 * so a future refactor can't silently drop them again.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBodyBraceCounted(name: string): string {
  const start = claudeSrc.indexOf(`${name}()`);
  if (start === -1) throw new Error(`Function ${name} not found in claude.sh`);
  const braceStart = claudeSrc.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < claudeSrc.length; i++) {
    if (claudeSrc[i] === '{') depth++;
    else if (claudeSrc[i] === '}') {
      depth--;
      if (depth === 0) return claudeSrc.slice(start, i + 1);
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

// Stubs ai-run.sh to capture stdin (the prompt) into a file and exit 0.
function makeAiRunCapture(scriptsDir: string, captureFile: string): void {
  writeFileSync(
    join(scriptsDir, 'ai-run.sh'),
    `#!/bin/bash\ncat > "${captureFile}"\n`,
  );
  chmodSync(join(scriptsDir, 'ai-run.sh'), 0o755);
}

describe('run_planning_phase — prompt inputs (LLM entry-point contract)', () => {
  function runPlanner(story: {
    id: string;
    title?: string;
    acceptanceCriteria?: string[];
    technicalNotes?: { files?: string[] };
    dependencies?: string[];
  }, contracts?: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'planner-prompt-test-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({
        stories: [{
          id: story.id,
          title: story.title ?? `Story ${story.id}`,
          acceptanceCriteria: story.acceptanceCriteria ?? ['AC1'],
          technicalNotes: story.technicalNotes ?? {},
          dependencies: story.dependencies ?? [],
        }],
      }));

      const scriptsDir = join(dir, 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      const captureFile = join(dir, 'prompt-capture.txt');
      makeAiRunCapture(scriptsDir, captureFile);

      if (contracts) {
        const contractsDir = join(dir, '.contracts');
        mkdirSync(contractsDir, { recursive: true });
        for (const [id, content] of Object.entries(contracts)) {
          writeFileSync(join(contractsDir, `${id}.md`), content);
        }
      }

      const plannerBody = extractFunctionBodyBraceCounted('run_planning_phase');

      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `PRD_FILE="${prdFile}"`,
          `PROJECT_ROOT="${dir}"`,
          `SCRIPT_DIR="${scriptsDir}"`,
          `EPAM_ORCHESTRATION_PROVIDER="claude"`,
          `EPAM_CLI="epam"`,
          `get_story_title() { jq -r --arg id "$1" '.stories[] | select(.id == $id) | .title' "${prdFile}"; }`,
          `log() { :; }`,
          // The prompt renders declared paths through _classify_declared_paths (added
          // 2026-08-10 so the planner knows which declared files already exist). It lives
          // outside run_planning_phase, so unstubbed it is `command not found` and the paths
          // silently vanish from the prompt — which reads exactly like the planner never
          // being given them. Lifted, not stubbed: its output IS what these tests assert on.
          // Faithful stub rather than a lift: the brace counter mis-terminates on this
          // function. What these tests assert is that the declared paths REACH the prompt,
          // and this reproduces that contract — it echoes each path it is given.
          `_classify_declared_paths() { printf '%s\\n' "$1"; }`,
          plannerBody,
          `run_planning_phase "${story.id}" "test-planner-model"`,
        ].join('\n'),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      try {
        return readFileSync(captureFile, 'utf8');
      } catch {
        return '';
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('includes the declared output file paths in the planning prompt', () => {
    const prompt = runPlanner({
      id: 'SKY-002-test',
      title: 'Write unit tests for SkyscannerClient',
      acceptanceCriteria: ['Tests cover all public methods'],
      technicalNotes: { files: ['/home/user/project/src/skyscanner/client.test.ts'] },
    });
    expect(prompt).toContain('/home/user/project/src/skyscanner/client.test.ts');
    expect(prompt).toMatch(/Output paths \(EXACT/i);
  });

  it('instructs the planner to use EXACT paths, not invent alternatives', () => {
    const prompt = runPlanner({
      id: 'SKY-002-test',
      technicalNotes: { files: ['/project/src/skyscanner/client.test.ts'] },
    });
    expect(prompt).toMatch(/exact/i);
    expect(prompt).toMatch(/never invent/i);
  });

  it('includes dependency contracts in the planning prompt when available', () => {
    const prompt = runPlanner(
      {
        id: 'SKY-002-test',
        dependencies: ['SKY-002-impl'],
        technicalNotes: { files: ['/project/src/skyscanner/client.test.ts'] },
      },
      { 'SKY-002-impl': '# SKY-002-impl contract\nexport class SkyscannerClient { fetch(): Promise<FlightResult[]> {} }' },
    );
    expect(prompt).toContain('SKY-002-impl');
    expect(prompt).toContain('SkyscannerClient');
  });

  it('includes acceptance criteria in the planning prompt', () => {
    const prompt = runPlanner({
      id: 'SKY-TEST',
      acceptanceCriteria: ['Must handle empty results gracefully', 'Must throw on invalid API key'],
    });
    expect(prompt).toContain('Must handle empty results gracefully');
    expect(prompt).toContain('Must throw on invalid API key');
  });

  it('still includes declared files even when there are no dependencies', () => {
    const prompt = runPlanner({
      id: 'SKY-001',
      technicalNotes: { files: ['/project/src/server.ts'] },
      dependencies: [],
    });
    expect(prompt).toContain('/project/src/server.ts');
  });
});

describe('review_and_correct_plan — declared output files included in review prompt', () => {
  function runReview(opts: {
    dependencies?: string[];
    declaredFiles?: string[];
    contracts?: Record<string, string>;
    aiRunResponse: string;
  }): { capturedPrompt: string; callCount: number } {
    const dir = mkdtempSync(join(tmpdir(), 'review-prompt-test-'));
    try {
      const reviewBody = extractFunctionBodyBraceCounted('review_and_correct_plan');
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({
        stories: [{
          id: 'SKY-999',
          dependencies: opts.dependencies ?? [],
          technicalNotes: { files: opts.declaredFiles ?? [] },
        }],
      }));

      const scriptsDir = join(dir, 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      const captureFile = join(dir, 'prompt-capture.txt');
      const callLog = join(dir, 'calls.txt');
      writeFileSync(
        join(scriptsDir, 'ai-run.sh'),
        `#!/bin/bash\necho called >> "${callLog}"\ncat > "${captureFile}"\necho '${opts.aiRunResponse}'\n`,
      );
      chmodSync(join(scriptsDir, 'ai-run.sh'), 0o755);

      if (opts.contracts) {
        const contractsDir = join(dir, '.contracts');
        mkdirSync(contractsDir, { recursive: true });
        for (const [id, content] of Object.entries(opts.contracts)) {
          writeFileSync(join(contractsDir, `${id}.md`), content);
        }
      }

      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `PRD_FILE="${prdFile}"`,
          `PROJECT_ROOT="${dir}"`,
          `SCRIPT_DIR="${scriptsDir}"`,
          `EPAM_ORCHESTRATION_PROVIDER="claude"`,
          `ORCH_GATE_MODEL="gate-model"`,
          `EPAM_CLI="epam"`,
          `warning() { :; }`,
          reviewBody,
          `review_and_correct_plan "SKY-999" "1. Read source file.\\n2. Write tests/skyscannerClient.test.ts"`,
        ].join('\n'),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      let capturedPrompt = '';
      try { capturedPrompt = readFileSync(captureFile, 'utf8'); } catch { /* no call */ }
      let callCount = 0;
      try { callCount = readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).length; } catch { /* no calls */ }
      return { capturedPrompt, callCount };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('includes declared output files in the review prompt when they are declared', () => {
    const { capturedPrompt, callCount } = runReview({
      declaredFiles: ['/project/src/skyscanner/client.test.ts'],
      contracts: { 'SKY-002': '# SKY-002\nexport class SkyscannerClient {}' },
      dependencies: ['SKY-002'],
      aiRunResponse: '{"verdict":"ok"}',
    });
    expect(callCount).toBe(1);
    expect(capturedPrompt).toContain('/project/src/skyscanner/client.test.ts');
    expect(capturedPrompt).toMatch(/Declared Output Files/i);
  });

  it('runs the review even when there are no dependency contracts but there ARE declared files', () => {
    const { callCount } = runReview({
      declaredFiles: ['/project/src/skyscanner/client.test.ts'],
      dependencies: [],
      aiRunResponse: '{"verdict":"ok"}',
    });
    expect(callCount).toBe(1);
  });

  it('skips the review when there are neither contracts nor declared files (nothing to check)', () => {
    const { callCount } = runReview({
      declaredFiles: [],
      dependencies: [],
      aiRunResponse: '{"verdict":"ok"}',
    });
    expect(callCount).toBe(0);
  });
});
