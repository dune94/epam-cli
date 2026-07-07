/**
 * resolve_escalation() (claude.sh) — cross-split-story defect escalation.
 *
 * Root cause this fixes (found live, 2026-07-06): SKY-002-test's tests failed
 * because SKY-002-impl's constructor was missing apiKey validation — but
 * SKY-002-test's own agent is correctly forbidden (scope guard) from touching
 * client.ts, which is owned by SKY-002-impl. Its FailureAnalyst correctly
 * diagnosed the true root cause every retry, but had no way to act on it,
 * burning its entire retry ladder re-diagnosing a defect it could never fix
 * itself.
 *
 * Fix: escalate_defect_to_sibling_story (a new tool) lets the agent file the
 * diagnosis instead of repeatedly failing against a locked file.
 * resolve_escalation() (tested here) finds the sibling story that actually
 * owns the target file and applies a narrow, scoped fix there via
 * implement_story() reuse, then grants the escalating story a free retry.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

// resolve_escalation() contains multiple jq heredocs/pipelines but no nested
// bash heredocs — a plain '}' -at-column-0 search is safe here (unlike
// apply_known_fix, which embeds a python heredoc).
function extractFunctionBody(name: string): string {
  const lines = claudeSrc.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === `${name}() {`);
  if (startIdx === -1) throw new Error(`Could not find start of function ${name}`);
  const body: string[] = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    body.push(lines[i]);
    if (lines[i] === '}') return body.join('\n');
  }
  throw new Error(`Could not find end of function ${name}`);
}

describe('resolve_escalation() — design constraints (static)', () => {
  const body = extractFunctionBody('resolve_escalation');

  it('no-ops (returns 1) when no escalation file exists for this story', () => {
    expect(body).toMatch(/\[ -f "\$escalation_file" \] \|\| return 1/);
  });

  it('prefers a split-sibling match (same specification.createdFrom) before falling back to a project-wide owner search', () => {
    expect(body).toMatch(/specification\.createdFrom == \$parent/);
    expect(body).toMatch(/technicalNotes\.files\[\]\? == \$file/);
  });

  it('reuses implement_story() rather than duplicating provider-dispatch logic', () => {
    expect(body).toMatch(/implement_story "\$sibling_id"/);
  });

  it('bounds the fix invocation to a small retry budget (does not reuse the full MAX_RETRIES ladder)', () => {
    expect(body).toMatch(/MAX_RETRIES="\$\{ESCALATION_FIX_MAX_RETRIES:-1\}"/);
  });

  it('saves and restores MAX_RETRIES and COORDINATOR_PROMPT_AMENDMENT so the escalating story is unaffected afterward', () => {
    expect(body).toMatch(/_saved_max_retries="\$MAX_RETRIES"/);
    expect(body).toMatch(/MAX_RETRIES="\$_saved_max_retries"/);
    expect(body).toMatch(/_saved_amendment="\$\{COORDINATOR_PROMPT_AMENDMENT:-\}"/);
    expect(body).toMatch(/COORDINATOR_PROMPT_AMENDMENT="\$_saved_amendment"/);
  });

  it('deletes the escalation file after resolving (success or failure) so it is never re-processed', () => {
    const rmOccurrences = (body.match(/rm -f "\$escalation_file"/g) || []).length;
    expect(rmOccurrences).toBeGreaterThanOrEqual(3); // malformed, unresolved-owner, and post-resolution paths
  });

  it('the call site in the retry loop takes priority over the deterministic-check free-retry gate', () => {
    const escalationIdx = claudeSrc.indexOf('if resolve_escalation "$story_id"; then');
    const deterministicIdx = claudeSrc.indexOf('Deterministic-check failures get up to 3 FREE retries');
    expect(escalationIdx).toBeGreaterThan(-1);
    expect(deterministicIdx).toBeGreaterThan(escalationIdx);
  });

  it('a successful resolution grants a free retry via continue, not counted against retry_count', () => {
    const idx = claudeSrc.indexOf('if resolve_escalation "$story_id"; then');
    const block = claudeSrc.slice(idx, idx + 200);
    expect(block).toMatch(/continue/);
    expect(block).not.toMatch(/retry_count=\$\(\(retry_count \+ 1\)\)/);
  });
});

describe('resolve_escalation() — REAL execution (sibling resolution + PRD lookup)', () => {
  function runResolveEscalation(opts: {
    prd: object;
    escalation: object | null;
    escalatingStoryId: string;
    implementStoryStub: string; // bash body that receives $1 = story id; must use `return` (not `exit`) to set $?
  }): { exitCode: number; stdout: string; escalationFileExists: boolean } {
    const dir = mkdtempSync(join(tmpdir(), 'escalation-test-'));
    try {
      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify(opts.prd));
      if (opts.escalation) {
        mkdirSync(join(dir, '.epam/escalations'), { recursive: true });
        writeFileSync(
          join(dir, '.epam/escalations', `${opts.escalatingStoryId}.json`),
          JSON.stringify(opts.escalation)
        );
      }
      const fnBody = extractFunctionBody('resolve_escalation');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `PROJECT_ROOT="${dir}"`,
          `PRD_FILE="${prdPath}"`,
          `MAX_RETRIES=8`,
          `log() { echo "LOG: $*"; }`,
          `warning() { echo "WARN: $*"; }`,
          `success() { echo "SUCCESS: $*"; }`,
          `implement_story() { ${opts.implementStoryStub}; }`,
          fnBody,
          `resolve_escalation "${opts.escalatingStoryId}"`,
          `echo "EXIT:$?"`,
        ].join('\n')
      );
      const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const exitMatch = stdout.match(/EXIT:(\d+)/);
      const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : -1;
      let escalationFileExists = false;
      try {
        readFileSync(join(dir, '.epam/escalations', `${opts.escalatingStoryId}.json`), 'utf8');
        escalationFileExists = true;
      } catch {
        /* expected to be deleted in most cases */
      }
      return { exitCode, stdout, escalationFileExists };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const SPLIT_PRD = {
    stories: [
      {
        id: 'SKY-002-impl',
        specification: { createdFrom: 'SKY-002' },
        technicalNotes: { files: ['src/skyscanner/client.ts'] },
      },
      {
        id: 'SKY-002-test',
        specification: { createdFrom: 'SKY-002' },
        technicalNotes: { files: ['src/skyscanner/client.test.ts'] },
      },
    ],
  };

  it('no-ops (exit 1) when there is no escalation file', () => {
    const result = runResolveEscalation({
      prd: SPLIT_PRD,
      escalation: null,
      escalatingStoryId: 'SKY-002-test',
      implementStoryStub: 'return 0',
    });
    expect(result.exitCode).toBe(1);
  });

  it('REPRODUCES the exact live scenario: resolves SKY-002-impl as the sibling owning client.ts, invokes it, and returns 0 on success', () => {
    const result = runResolveEscalation({
      prd: SPLIT_PRD,
      escalation: {
        fromStoryId: 'SKY-002-test',
        targetFile: 'src/skyscanner/client.ts',
        diagnosis: 'Constructor lacks validation that apiKey is provided; must throw on undefined/empty apiKey.',
        requiredFix: 'Add a guard in the constructor that throws when apiKey is undefined or empty.',
      },
      escalatingStoryId: 'SKY-002-test',
      implementStoryStub: 'echo "IMPLEMENT_STORY_CALLED_WITH:$1"; return 0',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('IMPLEMENT_STORY_CALLED_WITH:SKY-002-impl');
    expect(result.stdout).toMatch(/escalated a defect in src\/skyscanner\/client\.ts \(owned by SKY-002-impl\)/);
    expect(result.escalationFileExists).toBe(false);
  });

  it('returns 1 (and deletes the escalation) when the scoped fix invocation fails', () => {
    const result = runResolveEscalation({
      prd: SPLIT_PRD,
      escalation: {
        fromStoryId: 'SKY-002-test',
        targetFile: 'src/skyscanner/client.ts',
        diagnosis: 'd',
        requiredFix: 'f',
      },
      escalatingStoryId: 'SKY-002-test',
      implementStoryStub: 'return 1',
    });
    expect(result.exitCode).toBe(1);
    expect(result.escalationFileExists).toBe(false);
  });

  it('does not escalate to an unrelated story that happens to share no split relationship and does not declare the file', () => {
    const prd = {
      stories: [
        { id: 'SKY-002-impl', specification: { createdFrom: 'SKY-002' }, technicalNotes: { files: ['src/skyscanner/client.ts'] } },
        { id: 'SKY-002-test', specification: { createdFrom: 'SKY-002' }, technicalNotes: { files: ['src/skyscanner/client.test.ts'] } },
        { id: 'SKY-004', technicalNotes: { files: ['src/server.ts'] } },
      ],
    };
    const result = runResolveEscalation({
      prd,
      escalation: {
        fromStoryId: 'SKY-002-test',
        targetFile: 'src/does-not-exist-anywhere.ts',
        diagnosis: 'd',
        requiredFix: 'f',
      },
      escalatingStoryId: 'SKY-002-test',
      implementStoryStub: 'echo "SHOULD_NOT_BE_CALLED"; return 0',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain('SHOULD_NOT_BE_CALLED');
    expect(result.stdout).toMatch(/Could not resolve an owning story/);
  });

  it('falls back to a project-wide owner search when there is no split-sibling relationship (non-split cross-story dependency)', () => {
    const prd = {
      stories: [
        { id: 'APP-001', technicalNotes: { files: ['src/shared/config.ts'] } },
        { id: 'APP-002', technicalNotes: { files: ['src/consumer.ts'] } },
      ],
    };
    const result = runResolveEscalation({
      prd,
      escalation: {
        fromStoryId: 'APP-002',
        targetFile: 'src/shared/config.ts',
        diagnosis: 'missing default export',
        requiredFix: 'export a default config object',
      },
      escalatingStoryId: 'APP-002',
      implementStoryStub: 'echo "IMPLEMENT_STORY_CALLED_WITH:$1"; return 0',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('IMPLEMENT_STORY_CALLED_WITH:APP-001');
  });

  it('treats a malformed escalation file (missing required fields) as a no-op and deletes it', () => {
    const result = runResolveEscalation({
      prd: SPLIT_PRD,
      escalation: { fromStoryId: 'SKY-002-test' }, // missing targetFile/requiredFix
      escalatingStoryId: 'SKY-002-test',
      implementStoryStub: 'echo "SHOULD_NOT_BE_CALLED"; return 0',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain('SHOULD_NOT_BE_CALLED');
    expect(result.escalationFileExists).toBe(false);
  });
});
