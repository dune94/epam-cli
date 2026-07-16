import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SPEC_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const specSrc = readFileSync(SPEC_RUNNER, 'utf8');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractFunctionBodyBraceCounted(src: string, name: string): string {
  const start = src.indexOf(`${name}(`);
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
  throw new Error(`Could not find end of ${name}`);
}

describe('spec-pass timeout — default timeout raised to 180s', () => {
  it('RUNCLAUDE_TIMEOUT_MS defaults to 180000', () => {
    expect(specSrc).toContain("RUNCLAUDE_TIMEOUT_MS || '180000'");
  });

  it('MINIMAX_TOOL_TIMEOUT_MS defaults to 180000', () => {
    expect(specSrc).toContain("MINIMAX_TOOL_TIMEOUT_MS || '180000'");
  });
});

describe('spec-pass timeout — retry wrapper on null agent result', () => {
  it('SPEC_AGENT_MAX_RETRIES env var is read in spec-mode-runner.js', () => {
    expect(specSrc).toContain('SPEC_AGENT_MAX_RETRIES');
  });

  it('retry loop uses _specMaxRetries', () => {
    expect(specSrc).toContain('_specMaxRetries');
    expect(specSrc).toContain('_specRetry < _specMaxRetries');
  });

  it('retry warning message includes attempt counts', () => {
    expect(specSrc).toContain('retrying transient failure');
  });
});

describe('spec-pass timeout — specPassFailed flag written on exhausted retries', () => {
  it('specPassFailed is written to story.specification', () => {
    expect(specSrc).toContain('specPassFailed: true');
    expect(specSrc).toContain('specPassFailedReason');
  });

  it('hard WARN is emitted when spec pass fails and split is required', () => {
    expect(specSrc).toContain('[WARN] Spec pass FAILED for');
    expect(specSrc).toContain('execution proceeding at risk');
  });

  it('specPassFailed is only set when the story requires a split (not for fast-path stories)', () => {
    const flagIdx = specSrc.indexOf('specPassFailed: true');
    const splitReqIdx = specSrc.lastIndexOf('_splitReq.required', flagIdx);
    expect(splitReqIdx).toBeGreaterThan(0);
    expect(flagIdx - splitReqIdx).toBeLessThan(500);
  });
});

describe('spec-pass block gate in run-agent-orchestration.sh', () => {
  it('SPEC_PASS_BLOCK_ON_TIMEOUT env var is read', () => {
    expect(orchSrc).toContain('SPEC_PASS_BLOCK_ON_TIMEOUT');
  });

  it('block gate checks for stories with specPassFailed == true in prd.json', () => {
    expect(orchSrc).toContain('.specification.specPassFailed == true');
  });

  it('block gate emits error and exits 1 when triggered', () => {
    const body = extractFunctionBodyBraceCounted(orchSrc, 'run_specification_pass');
    expect(body).toContain('SPEC_PASS_BLOCK_ON_TIMEOUT');
    expect(body).toContain('Spec pass FAILED for untuned stories');
    expect(body).toContain('exit 1');
  });

  it('block gate is a no-op when SPEC_PASS_BLOCK_ON_TIMEOUT is false (default)', () => {
    const body = extractFunctionBodyBraceCounted(orchSrc, 'run_specification_pass');
    expect(body).toContain('SPEC_PASS_BLOCK_ON_TIMEOUT:-false');
  });

  it('block gate fires correctly when SPEC_PASS_BLOCK_ON_TIMEOUT=true and stories have specPassFailed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-block-gate-test-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({
        stories: [
          { id: 'TST-001', status: 'pending', specification: { specPassFailed: true } },
          { id: 'TST-002', status: 'pending', specification: {} }
        ]
      }));

      // Inline only the block-gate logic (not the whole function body) to avoid
      // dependency on the many internal helpers inside run_specification_pass().
      const script = join(dir, 'test-block-gate.sh');
      writeFileSync(script, `#!/bin/bash
PRD_FILE="${prdFile}"
error() { echo "ERROR: $*" >&2; }

if [ "\${SPEC_PASS_BLOCK_ON_TIMEOUT:-false}" = "true" ]; then
    _failed_untuned=$(jq -r '[.stories[] | select(.specification.specPassFailed == true)] | length' "$PRD_FILE" 2>/dev/null || echo 0)
    if [ "\${_failed_untuned:-0}" -gt 0 ]; then
        _failed_ids=$(jq -r '[.stories[] | select(.specification.specPassFailed == true) | .id] | join(", ")' "$PRD_FILE" 2>/dev/null || echo "unknown")
        error "Spec pass FAILED for untuned stories: $_failed_ids"
        error "  Execution blocked (SPEC_PASS_BLOCK_ON_TIMEOUT=true). Set to false to override."
        exit 1
    fi
fi
exit 0
`);
      chmodSync(script, 0o755);

      let threw = false;
      try {
        execFileSync('bash', [script], {
          encoding: 'utf8',
          env: { ...process.env, SPEC_PASS_BLOCK_ON_TIMEOUT: 'true', PRD_FILE: prdFile }
        });
      } catch (e: any) {
        threw = true;
        expect(e.stderr || e.stdout || '').toMatch(/Spec pass FAILED|untuned/i);
      }
      expect(threw).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('block gate does NOT fire when SPEC_PASS_BLOCK_ON_TIMEOUT=false even with specPassFailed stories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-block-gate-noop-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({
        stories: [{ id: 'TST-001', status: 'pending', specification: { specPassFailed: true } }]
      }));

      const script = join(dir, 'test-block-gate-noop.sh');
      writeFileSync(script, `#!/bin/bash
PRD_FILE="${prdFile}"
error() { echo "ERROR: $*" >&2; }

if [ "\${SPEC_PASS_BLOCK_ON_TIMEOUT:-false}" = "true" ]; then
    _failed_untuned=$(jq -r '[.stories[] | select(.specification.specPassFailed == true)] | length' "$PRD_FILE" 2>/dev/null || echo 0)
    if [ "\${_failed_untuned:-0}" -gt 0 ]; then
        _failed_ids=$(jq -r '[.stories[] | select(.specification.specPassFailed == true) | .id] | join(", ")' "$PRD_FILE" 2>/dev/null || echo "unknown")
        error "Spec pass FAILED for untuned stories: $_failed_ids"
        exit 1
    fi
fi
exit 0
`);
      chmodSync(script, 0o755);

      // Should NOT throw (SPEC_PASS_BLOCK_ON_TIMEOUT=false → gate is a no-op)
      const result = execFileSync('bash', [script], {
        encoding: 'utf8',
        env: { ...process.env, SPEC_PASS_BLOCK_ON_TIMEOUT: 'false', PRD_FILE: prdFile }
      });
      expect(result).not.toMatch(/Spec pass FAILED/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
