/**
 * classify_failure_class() — the Layer 1 (rule-based, zero-cost) triage that
 * runs before every model-escalation decision, classifying a story's failure
 * into env / capability / quality / unknown. Found completely untested
 * (2026-07-07 test-coverage audit) despite being 129 lines of real branching
 * logic, a live network call (OpenRouter key health check), and a
 * cross-run-memory side effect (KB entry synthesis after 3+ capability
 * failures) — exactly the kind of load-bearing, easy-to-silently-break code
 * this project's "always write tests, never assume the surface is adequate"
 * rule exists for.
 *
 * All external dependencies (curl, epam binary presence, story-failures.jsonl,
 * KB.md) are stubbed/fixture-controlled — no real network calls.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionByLineAnchor(name: string): string {
  const lines = claudeSrc.split('\n');
  const startIdx = lines.findIndex((l) => l === `${name}() {`);
  if (startIdx === -1) throw new Error(`${name} start anchor not found`);
  const endIdx = lines.findIndex((l, i) => i > startIdx && l === '}');
  if (endIdx === -1) throw new Error(`${name} end anchor not found`);
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

describe('classify_failure_class — design (static)', () => {
  const body = extractFunctionByLineAnchor('classify_failure_class');

  it('Class A (env): raw output empty AND non-zero exit', () => {
    expect(body).toMatch(/raw_size" -eq 0 \] && \[ "\$exit_code" -ne 0/);
  });

  it('active diagnosis checks both the CLI binary and the API key before deciding whether to still allow escalation', () => {
    expect(body).toMatch(/command -v "\$\{EPAM_CLI:-epam\}"/);
    expect(body).toMatch(/OPENROUTER_API_KEY/);
  });

  it('Class B (capability): matches "maximum iterations" in the result text', () => {
    expect(body).toMatch(/maximum iterations\\?\|max.\*iter/);
  });

  it('Class C (quality): falls through to quality when result text is non-empty and not a capability match', () => {
    const idx = body.indexOf('Class C: quality failure');
    expect(idx).toBeGreaterThan(-1);
  });

  it('cross-run memory: 2+ prior env failures suppress escalation', () => {
    expect(body).toMatch(/_prior_env_count:-0\}" -ge 2/);
  });

  it('cross-run memory: 3+ prior capability failures triggers KB decomposition-suggestion synthesis', () => {
    expect(body).toMatch(/_prior_cap_count:-0\}" -ge 3/);
    expect(body).toMatch(/decomposed into smaller children/);
  });
});

describe('classify_failure_class — REAL execution', () => {
  function run(opts: {
    rawContent?: string; // undefined = file doesn't exist
    resultJson?: object; // undefined = file doesn't exist
    exitCode: number;
    storyId?: string;
    epamOnPath?: boolean;
    curlBehavior?: 'valid' | 'invalid' | 'unreachable' | 'no-key';
    storyFailures?: Array<{ storyId: string; failureClass: string }>;
    kbFileExists?: boolean;
  }): { failureClass: string; escalate: string; stderr: string; kbContent: string } {
    const dir = mkdtempSync(join(tmpdir(), 'classify-failure-test-'));
    try {
      const rawFile = join(dir, 'raw.json');
      if (opts.rawContent !== undefined) writeFileSync(rawFile, opts.rawContent);

      const resultFile = join(dir, 'result.json');
      if (opts.resultJson !== undefined) writeFileSync(resultFile, JSON.stringify(opts.resultJson));

      const logDir = join(dir, 'logs');
      mkdirSync(logDir, { recursive: true });
      if (opts.storyFailures) {
        writeFileSync(
          join(logDir, 'story-failures.jsonl'),
          opts.storyFailures.map((f) => JSON.stringify(f)).join('\n') + '\n',
        );
      }

      const automationDir = join(dir, 'automation');
      const agentsDir = join(automationDir, 'agents');
      mkdirSync(agentsDir, { recursive: true });
      const kbFile = join(agentsDir, 'KB.md');
      if (opts.kbFileExists !== false) writeFileSync(kbFile, '# Knowledge Base\n');

      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({ stories: [{ id: opts.storyId ?? 'SKY-TEST', acceptanceCriteria: ['a', 'b', 'c'] }] }));

      // Stub curl (avoid any real network call to OpenRouter) by prepending a
      // stub dir to the REAL PATH — jq/bash/etc. must remain the real system
      // ones (used pervasively). `epam` presence is controlled via EPAM_CLI
      // below instead of PATH manipulation, since the real jq and the real
      // epam binary happen to live in the same directory on this system
      // (~/.local/bin) — excluding one via PATH would break the other.
      const binDir = join(dir, 'bin');
      mkdirSync(binDir, { recursive: true });
      const curlScript =
        opts.curlBehavior === 'valid'
          ? `#!/usr/bin/env bash\necho '{"data":{"label":"test-key-label"}}'\n`
          : opts.curlBehavior === 'invalid'
            ? `#!/usr/bin/env bash\necho '{"data":{"label":"invalid"}}'\n`
            : `#!/usr/bin/env bash\nexit 1\n`; // unreachable: curl itself fails, jq gets empty stdin -> "unreachable" per the || echo fallback
      writeFileSync(join(binDir, 'curl'), curlScript);
      chmodSync(join(binDir, 'curl'), 0o755);

      const fnBody = extractFunctionByLineAnchor('classify_failure_class');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `export PATH="${binDir}:$PATH"`,
          // Controls whether `command -v "${EPAM_CLI:-epam}"` resolves,
          // without touching PATH (see comment above).
          `EPAM_CLI="${opts.epamOnPath ? 'bash' : 'nonexistent-epam-binary-xyz-for-test'}"`,
          `warning() { echo "WARN: $*" >&2; }`,
          `log() { echo "LOG: $*" >&2; }`,
          `LOG_DIR="${logDir}"`,
          `AUTOMATION_DIR="${automationDir}"`,
          `MAIN_PRD_FILE="${prdFile}"`,
          `story_id="${opts.storyId ?? 'SKY-TEST'}"`,
          opts.curlBehavior !== 'no-key' ? `OPENROUTER_API_KEY="fake-key-for-test"` : `unset OPENROUTER_API_KEY`,
          fnBody,
          `classify_failure_class "${opts.rawContent !== undefined ? rawFile : join(dir, 'nonexistent-raw.json')}" "${opts.resultJson !== undefined ? resultFile : join(dir, 'nonexistent-result.json')}" "${opts.exitCode}"`,
          `echo "CLASS=$COORDINATOR_FAILURE_CLASS"`,
          `echo "ESCALATE=$COORDINATOR_ESCALATE"`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      const result = execFileSync('bash', [scriptPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const failureClass = result.match(/CLASS=(\S*)/)?.[1] ?? 'MISSING';
      const escalate = result.match(/ESCALATE=(\S*)/)?.[1] ?? 'MISSING';
      let kbContent = '';
      try {
        kbContent = readFileSync(kbFile, 'utf8');
      } catch {
        kbContent = '';
      }
      return { failureClass, escalate, stderr: result, kbContent };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  describe('Class A — environment crash', () => {
    it('empty raw output + non-zero exit + epam missing from PATH: env, escalate suppressed', () => {
      const { failureClass, escalate } = run({
        rawContent: '',
        exitCode: 1,
        epamOnPath: false,
        curlBehavior: 'valid',
      });
      expect(failureClass).toBe('env');
      expect(escalate).toBe('no');
    });

    it('empty raw output + non-zero exit + no API key configured: env, escalate suppressed', () => {
      const { failureClass, escalate } = run({
        rawContent: '',
        exitCode: 1,
        epamOnPath: true,
        curlBehavior: 'no-key',
      });
      expect(failureClass).toBe('env');
      expect(escalate).toBe('no');
    });

    it('empty raw output + non-zero exit + invalid API key: env, escalate suppressed', () => {
      const { failureClass, escalate } = run({
        rawContent: '',
        exitCode: 1,
        epamOnPath: true,
        curlBehavior: 'invalid',
      });
      expect(failureClass).toBe('env');
      expect(escalate).toBe('no');
    });

    it('empty raw output + non-zero exit but binary AND key are healthy: env class, but escalation flips back to "yes" (model/timeout issue, not a real crash)', () => {
      const { failureClass, escalate } = run({
        rawContent: '',
        exitCode: 1,
        epamOnPath: true,
        curlBehavior: 'valid',
      });
      expect(failureClass).toBe('env');
      expect(escalate).toBe('yes');
    });

    it('non-empty raw output does NOT count as an env crash even with a non-zero exit', () => {
      const { failureClass } = run({
        rawContent: 'some real output here',
        exitCode: 1,
        epamOnPath: true,
        curlBehavior: 'valid',
        resultJson: { result: 'partial output' },
      });
      expect(failureClass).not.toBe('env');
    });
  });

  describe('Class B — capability failure', () => {
    it('result text mentions "maximum iterations": capability, escalate approved', () => {
      const { failureClass, escalate } = run({
        rawContent: 'some output',
        exitCode: 1,
        resultJson: { result: 'Error: reached maximum iterations without completing the task' },
      });
      expect(failureClass).toBe('capability');
      expect(escalate).toBe('yes');
    });

    it('tokens consumed but no result text at all: capability (empty-output variant)', () => {
      const { failureClass, escalate } = run({
        rawContent: 'some output',
        exitCode: 1,
        resultJson: { result: '', usage: { outputTokens: 500 } },
      });
      expect(failureClass).toBe('capability');
      expect(escalate).toBe('yes');
    });

    it('few tokens AND no result text: falls through to unknown, not capability (100-token threshold)', () => {
      const { failureClass } = run({
        rawContent: 'some output',
        exitCode: 1,
        resultJson: { result: '', usage: { outputTokens: 50 } },
      });
      expect(failureClass).toBe('unknown');
    });
  });

  describe('Class C — quality failure', () => {
    it('agent ran and produced a real, non-empty result: quality, escalate tentatively approved', () => {
      const { failureClass, escalate } = run({
        rawContent: 'some output',
        exitCode: 0,
        resultJson: { result: 'I implemented the feature and wrote tests.' },
      });
      expect(failureClass).toBe('quality');
      expect(escalate).toBe('yes');
    });
  });

  describe('Unknown + cross-run memory', () => {
    it('no result file and no raw content matching any class: unknown, safe-default escalate', () => {
      const { failureClass, escalate } = run({
        rawContent: 'some output',
        exitCode: 0,
      });
      expect(failureClass).toBe('unknown');
      expect(escalate).toBe('yes');
    });

    it('2+ prior env failures for this exact story override to env and suppress escalation', () => {
      const { failureClass, escalate } = run({
        rawContent: 'some output',
        exitCode: 0,
        storyId: 'SKY-REPEAT',
        storyFailures: [
          { storyId: 'SKY-REPEAT', failureClass: 'env' },
          { storyId: 'SKY-REPEAT', failureClass: 'env' },
        ],
      });
      expect(failureClass).toBe('env');
      expect(escalate).toBe('no');
    });

    it('only 1 prior env failure does NOT trigger the override (threshold is 2+)', () => {
      const { failureClass } = run({
        rawContent: 'some output',
        exitCode: 0,
        storyId: 'SKY-ONCE',
        storyFailures: [{ storyId: 'SKY-ONCE', failureClass: 'env' }],
      });
      expect(failureClass).toBe('unknown');
    });

    it('3+ prior capability failures synthesizes a KB decomposition-suggestion entry', () => {
      const { kbContent } = run({
        rawContent: 'some output',
        exitCode: 0,
        storyId: 'SKY-BIG',
        storyFailures: [
          { storyId: 'SKY-BIG', failureClass: 'capability' },
          { storyId: 'SKY-BIG', failureClass: 'capability' },
          { storyId: 'SKY-BIG', failureClass: 'capability' },
        ],
      });
      expect(kbContent).toContain('KB-PERSIST-SKY-BIG');
      expect(kbContent).toContain('decomposed into smaller children');
      expect(kbContent).toContain('3 times with capability class');
    });

    it('does not duplicate the KB entry if one already exists for this story (de-dup marker check)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'classify-kb-dedup-test-'));
      try {
        const logDir = join(dir, 'logs');
        mkdirSync(logDir, { recursive: true });
        writeFileSync(
          join(logDir, 'story-failures.jsonl'),
          [
            { storyId: 'SKY-DUP', failureClass: 'capability' },
            { storyId: 'SKY-DUP', failureClass: 'capability' },
            { storyId: 'SKY-DUP', failureClass: 'capability' },
          ]
            .map((f) => JSON.stringify(f))
            .join('\n') + '\n',
        );
        const automationDir = join(dir, 'automation');
        const agentsDir = join(automationDir, 'agents');
        mkdirSync(agentsDir, { recursive: true });
        const kbFile = join(agentsDir, 'KB.md');
        writeFileSync(kbFile, '# Knowledge Base\n\n## KB-PERSIST-SKY-DUP -- 2026-01-01\n\nAlready here.\n');
        const prdFile = join(dir, 'prd.json');
        writeFileSync(prdFile, JSON.stringify({ stories: [{ id: 'SKY-DUP', acceptanceCriteria: [] }] }));

        const fnBody = extractFunctionByLineAnchor('classify_failure_class');
        const scriptPath = join(dir, 'run.sh');
        writeFileSync(
          scriptPath,
          [
            `warning() { :; }`,
            `log() { :; }`,
            `LOG_DIR="${logDir}"`,
            `AUTOMATION_DIR="${automationDir}"`,
            `MAIN_PRD_FILE="${prdFile}"`,
            `story_id="SKY-DUP"`,
            `unset OPENROUTER_API_KEY`,
            fnBody,
            `classify_failure_class "${join(dir, 'missing-raw')}" "${join(dir, 'missing-result')}" "0"`,
          ].join('\n'),
        );
        execFileSync('bash', [scriptPath], { encoding: 'utf8' });
        const kbContent = readFileSync(kbFile, 'utf8');
        const occurrences = kbContent.split('KB-PERSIST-SKY-DUP').length - 1;
        expect(occurrences).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
