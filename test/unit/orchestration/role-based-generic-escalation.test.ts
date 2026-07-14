/**
 * Generalizes the SKY-003-b fix (2026-07-14): that story kept failing on a
 * genuinely subtle bug (a mocked process.exit() throw getting swallowed by
 * the CLI's own try/catch) and burned through two watchdog cycles before the
 * pipeline gave up. The user explicitly rejected hardcoding anything about
 * "process.exit" or "test-writing" into engine code -- the fix must be
 * driven by signals the pipeline already measures generically for ANY
 * project/stack, following the existing EPAM_MODEL_LADDER (family) and
 * EPAM_MODEL_PROVIDER_MAP pipe-separated-env-var convention.
 *
 * Three additions, all role- or evidence-keyed rather than content-keyed:
 *   1. resolve_role_timeout_multiplier() (run-agent-orchestration.sh) --
 *      scales a story's watchdog timeout by its agentRole via
 *      EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP (default "test-engineer=1.5").
 *   2. resolve_role_retry_extension_max() (claude.sh) -- caps the dynamic
 *      retry-extension coordinator's grant by agentRole via
 *      EPAM_ROLE_RETRY_EXTENSION_MAP (default "test-engineer=4"), instead of
 *      the flat global EPAM_RETRY_EXTENSION_MAX.
 *   3. classify_ladder_tier() (claude.sh) -- a third, purely measured
 *      escalation signal: low average FailureAnalyst diagnosis groundedness
 *      (from failure-diagnosis-groundedness.jsonl, a file every project
 *      already produces) means the analyst keeps having to guess, which
 *      generically correlates with "genuinely hard story" regardless of
 *      language or bug type -- so the ladder escalates to "high" tier.
 *
 * agentRole itself is never hardcoded to a project's stack: it's whatever
 * the pipeline's own Step 0.5/0.9 coordinators assigned in prd.json.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBodyBraceCounted(src: string, name: string): string {
  const start = src.indexOf(`${name}()`);
  if (start === -1) throw new Error(`Function ${name} not found`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

describe('resolve_role_timeout_multiplier — REAL execution (run-agent-orchestration.sh)', () => {
  function run(opts: { agentRole?: string; map?: string }): string {
    const dir = mkdtempSync(join(tmpdir(), 'role-timeout-mult-test-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(
        prdFile,
        JSON.stringify({ stories: [{ id: 'SKY-999', agentRole: opts.agentRole ?? null }] }),
      );
      const fnBody = extractFunctionBodyBraceCounted(orchSrc, 'resolve_role_timeout_multiplier');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, [fnBody, `MAIN_PRD_FILE="${prdFile}" resolve_role_timeout_multiplier SKY-999`].join('\n'));
      return execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, ...(opts.map ? { EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP: opts.map } : {}) },
      }).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('defaults to 1.5x for agentRole=test-engineer (no env var set)', () => {
    expect(run({ agentRole: 'test-engineer' })).toBe('1.5');
  });

  it('defaults to 1.0x (no-op) for an unrelated role', () => {
    expect(run({ agentRole: 'typescript-engineer' })).toBe('1.0');
  });

  it('defaults to 1.0x when the story has no agentRole at all', () => {
    expect(run({})).toBe('1.0');
  });

  it('is fully configurable: an arbitrary custom role/multiplier pair via env var, not hardcoded', () => {
    expect(run({ agentRole: 'pytest-engineer', map: 'pytest-engineer=2.0|go-test-engineer=1.8' })).toBe('2.0');
  });

  it('an unmatched role under a custom map still falls back to 1.0', () => {
    expect(run({ agentRole: 'test-engineer', map: 'pytest-engineer=2.0' })).toBe('1.0');
  });
});

describe('run_story_with_watchdog — wired to apply the role multiplier (static)', () => {
  it('the effort-derived timeout_secs is scaled by resolve_role_timeout_multiplier before use', () => {
    const fnBody = extractFunctionBodyBraceCounted(orchSrc, 'run_story_with_watchdog');
    expect(fnBody).toMatch(/resolve_role_timeout_multiplier "\$story_id"/);
    expect(fnBody).toMatch(/\$\{timeout_secs\} \* \$\{role_multiplier\}/);
  });

  it('the explicit STORY_TIMEOUT_SECS override still bypasses effort AND role scaling (unchanged behavior)', () => {
    const fnBody = extractFunctionBodyBraceCounted(orchSrc, 'run_story_with_watchdog');
    const overrideBranch = fnBody.slice(0, fnBody.indexOf('\n    else\n'));
    expect(overrideBranch).toMatch(/timeout_secs="\$STORY_TIMEOUT_SECS"/);
    expect(overrideBranch).not.toMatch(/role_multiplier/);
  });
});

describe('resolve_role_retry_extension_max — REAL execution (claude.sh)', () => {
  function run(opts: { agentRole?: string; map?: string; globalMax?: string }): string {
    const dir = mkdtempSync(join(tmpdir(), 'role-retry-max-test-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(
        prdFile,
        JSON.stringify({ stories: [{ id: 'SKY-999', agentRole: opts.agentRole ?? null }] }),
      );
      const fnBody = extractFunctionBodyBraceCounted(claudeSrc, 'resolve_role_retry_extension_max');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, [fnBody, `MAIN_PRD_FILE="${prdFile}" resolve_role_retry_extension_max SKY-999`].join('\n'));
      return execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...(opts.map ? { EPAM_ROLE_RETRY_EXTENSION_MAP: opts.map } : {}),
          ...(opts.globalMax ? { EPAM_RETRY_EXTENSION_MAX: opts.globalMax } : {}),
        },
      }).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('defaults to 4 for agentRole=test-engineer (no env var set)', () => {
    expect(run({ agentRole: 'test-engineer' })).toBe('4');
  });

  it('falls back to the flat EPAM_RETRY_EXTENSION_MAX (default 2) for an unrelated role', () => {
    expect(run({ agentRole: 'typescript-engineer' })).toBe('2');
  });

  it('honors a custom EPAM_RETRY_EXTENSION_MAX for unmatched roles', () => {
    expect(run({ agentRole: 'typescript-engineer', globalMax: '5' })).toBe('5');
  });

  it('is fully configurable: an arbitrary custom role/cap pair via env var, not hardcoded', () => {
    expect(run({ agentRole: 'pytest-engineer', map: 'pytest-engineer=6' })).toBe('6');
  });

  it('falls back to the global default when the story has no agentRole at all', () => {
    expect(run({})).toBe('2');
  });
});

describe('run_retry_extension_coordinator — wired to use the per-role cap (static)', () => {
  it('calls resolve_role_retry_extension_max instead of a flat EPAM_RETRY_EXTENSION_MAX literal', () => {
    const fnBody = extractFunctionBodyBraceCounted(claudeSrc, 'run_retry_extension_coordinator');
    expect(fnBody).toMatch(/_max=\$\(resolve_role_retry_extension_max "\$story_id"\)/);
  });
});

describe('classify_ladder_tier — groundedness-based escalation, REAL execution (claude.sh)', () => {
  function run(opts: {
    scores: number[];
    minSamples?: string;
    threshold?: string;
    storyId?: string;
  }): string {
    const dir = mkdtempSync(join(tmpdir(), 'ladder-tier-groundedness-test-'));
    try {
      const storyId = opts.storyId ?? 'SKY-999';
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({ stories: [{ id: storyId }] }));

      const logDir = join(dir, 'logs');
      mkdirSync(logDir, { recursive: true });
      const groundednessFile = join(logDir, 'failure-diagnosis-groundedness.jsonl');
      for (const score of opts.scores) {
        appendFileSync(
          groundednessFile,
          JSON.stringify({ storyId, diagnosis: 'some diagnosis', score, timestamp: new Date().toISOString() }) + '\n',
        );
      }

      const fnBody = extractFunctionBodyBraceCounted(claudeSrc, 'classify_ladder_tier');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [fnBody, `MAIN_PRD_FILE="${prdFile}" LOG_DIR="${logDir}" classify_ladder_tier "${storyId}"`].join('\n'),
      );
      return execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...(opts.minSamples ? { EPAM_LADDER_GROUNDEDNESS_MIN_SAMPLES: opts.minSamples } : {}),
          ...(opts.threshold ? { EPAM_LADDER_GROUNDEDNESS_ESCALATION_THRESHOLD: opts.threshold } : {}),
        },
      }).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the fix: low average groundedness (like SKY-003-b\'s 0.51) with enough samples escalates to "high"', () => {
    expect(run({ scores: [0.51, 0.4] })).toBe('high');
  });

  it('stays "medium" when average groundedness is healthy (agent diagnoses are well-grounded)', () => {
    expect(run({ scores: [0.95, 0.98] })).toBe('medium');
  });

  it('does NOT escalate on a single low-score sample below the minimum sample count (avoids noise)', () => {
    expect(run({ scores: [0.1] })).toBe('medium');
  });

  it('minimum sample count is configurable', () => {
    expect(run({ scores: [0.1, 0.2, 0.3], minSamples: '3' })).toBe('high');
  });

  it('escalation threshold is configurable', () => {
    expect(run({ scores: [0.7, 0.75], threshold: '0.8' })).toBe('high');
  });

  it('is a no-op (stays "medium") when no groundedness file exists at all for this project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladder-tier-no-file-test-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({ stories: [{ id: 'SKY-999' }] }));
      const logDir = join(dir, 'logs');
      mkdirSync(logDir, { recursive: true });
      const fnBody = extractFunctionBodyBraceCounted(claudeSrc, 'classify_ladder_tier');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [fnBody, `MAIN_PRD_FILE="${prdFile}" LOG_DIR="${logDir}" classify_ladder_tier SKY-999`].join('\n'),
      );
      expect(execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim()).toBe('medium');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an explicit PRD .ladderTier override still wins over groundedness evidence entirely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladder-tier-override-test-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({ stories: [{ id: 'SKY-999', ladderTier: 'medium' }] }));
      const logDir = join(dir, 'logs');
      mkdirSync(logDir, { recursive: true });
      appendFileSync(
        join(logDir, 'failure-diagnosis-groundedness.jsonl'),
        JSON.stringify({ storyId: 'SKY-999', score: 0.01, timestamp: new Date().toISOString() }) + '\n' +
          JSON.stringify({ storyId: 'SKY-999', score: 0.01, timestamp: new Date().toISOString() }) + '\n',
      );
      const fnBody = extractFunctionBodyBraceCounted(claudeSrc, 'classify_ladder_tier');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [fnBody, `MAIN_PRD_FILE="${prdFile}" LOG_DIR="${logDir}" classify_ladder_tier SKY-999`].join('\n'),
      );
      expect(execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim()).toBe('medium');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is domain-agnostic: an unrelated story ID\'s scores in the same file do not affect this story\'s classification', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladder-tier-domain-test-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({ stories: [{ id: 'SKY-999' }, { id: 'SKY-888' }] }));
      const logDir = join(dir, 'logs');
      mkdirSync(logDir, { recursive: true });
      const groundednessFile = join(logDir, 'failure-diagnosis-groundedness.jsonl');
      appendFileSync(groundednessFile, JSON.stringify({ storyId: 'SKY-888', score: 0.01, timestamp: new Date().toISOString() }) + '\n');
      appendFileSync(groundednessFile, JSON.stringify({ storyId: 'SKY-888', score: 0.02, timestamp: new Date().toISOString() }) + '\n');
      appendFileSync(groundednessFile, JSON.stringify({ storyId: 'SKY-999', score: 0.95, timestamp: new Date().toISOString() }) + '\n');
      appendFileSync(groundednessFile, JSON.stringify({ storyId: 'SKY-999', score: 0.97, timestamp: new Date().toISOString() }) + '\n');
      const fnBody = extractFunctionBodyBraceCounted(claudeSrc, 'classify_ladder_tier');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [fnBody, `MAIN_PRD_FILE="${prdFile}" LOG_DIR="${logDir}" classify_ladder_tier SKY-999`].join('\n'),
      );
      expect(execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim()).toBe('medium');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
