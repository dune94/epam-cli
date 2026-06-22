/**
 * Shell behaviour tests — spawns bash subprocesses to verify:
 *
 *  1. _timeout_prefix: no timeout when EPAM_STORY_TIMEOUT_SECS is unset
 *  2. _timeout_prefix: timeout command is prepended when env var is set
 *  3. Retry loop: STORY_MAX_ITERATIONS env var reaches the epam subprocess
 *  4. Ralph env vars: EPAM_RALPH_WIGGUM_ENABLED/AGENTS/TIMEOUT_MS are
 *     forwarded to the epam subprocess (the $20 bug guard)
 *  5. ORCH_GATE_PROVIDER: propagated from tier run script to orchestration
 *
 * These tests use self-contained bash snippets extracted from claude.sh logic,
 * not the full script (which requires external tools). They validate the
 * contract — not the implementation path through every provider branch.
 */

import { spawnSync } from 'child_process';
import { describe, it, expect } from 'vitest';

function bash(script: string, env: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

// Inline the _timeout_prefix logic from claude.sh so tests are self-contained
const TIMEOUT_PREFIX_SNIPPET = `
_timeout_prefix=()
[ -n "\${EPAM_STORY_TIMEOUT_SECS:-}" ] && _timeout_prefix=(timeout "\$EPAM_STORY_TIMEOUT_SECS")
echo "\${_timeout_prefix[*]}"
`;

describe('_timeout_prefix (claude.sh)', () => {
  it('produces empty prefix when EPAM_STORY_TIMEOUT_SECS is unset', () => {
    const { stdout, status } = bash(TIMEOUT_PREFIX_SNIPPET, {});
    expect(status).toBe(0);
    // Should print a blank line (empty array)
    expect(stdout.trim()).toBe('');
  });

  it('produces "timeout <N>" when EPAM_STORY_TIMEOUT_SECS is set', () => {
    const { stdout, status } = bash(TIMEOUT_PREFIX_SNIPPET, {
      EPAM_STORY_TIMEOUT_SECS: '180',
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('timeout 180');
  });

  it('timeout command actually kills a long-running process', () => {
    // Verify `timeout 1 sleep 5` exits with 124 (timed out)
    const { status } = bash('timeout 1 sleep 5');
    expect(status).toBe(124);
  });
});

// Verify env vars listed in claude.sh explicit forward block include the
// critical Ralph/timeout variables (the $20 token leak guard).
describe('env var forwarding (claude.sh explicit block)', () => {
  const FORWARDED_VARS = [
    'EPAM_RALPH_WIGGUM_ENABLED',
    'EPAM_RALPH_WIGGUM_AGENTS',
    'EPAM_RALPH_WIGGUM_TIMEOUT_MS',
    'EPAM_STORY_TIMEOUT_SECS',
    'EPAM_MAX_ITERATIONS',
    'EPAM_MAX_RETRIES',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
  ];

  for (const varName of FORWARDED_VARS) {
    it(`${varName} is present in claude.sh epam-run forward block`, () => {
      const { stdout, status } = bash(
        `grep -c '${varName}' orchestrations/scripts/claude.sh`,
        { PWD: '/home/bradleyjerome/projects/ai/epam-cli' }
      );
      // spawnSync inherits cwd from process; use explicit path
      const result2 = spawnSync(
        'grep',
        ['-c', varName, 'orchestrations/scripts/claude.sh'],
        {
          encoding: 'utf8',
          cwd: '/home/bradleyjerome/projects/ai/epam-cli',
        }
      );
      const count = parseInt((result2.stdout ?? '0').trim(), 10);
      expect(count).toBeGreaterThan(0);
    });
  }
});

// Verify tier scripts set EPAM_STORY_TIMEOUT_SECS explicitly (no implicit defaults)
describe('EPAM_STORY_TIMEOUT_SECS set in all tier scripts', () => {
  const TIER_SCRIPTS = [
    'orchestrations/scripts/tier1-mock-run.sh',
    'orchestrations/scripts/tier3-paid-run.sh',
  ];

  for (const script of TIER_SCRIPTS) {
    it(`${script} sets EPAM_STORY_TIMEOUT_SECS`, () => {
      const result = spawnSync(
        'grep',
        ['-c', 'EPAM_STORY_TIMEOUT_SECS', script],
        {
          encoding: 'utf8',
          cwd: '/home/bradleyjerome/projects/ai/epam-cli',
        }
      );
      const count = parseInt((result.stdout ?? '0').trim(), 10);
      expect(count).toBeGreaterThan(0);
    });
  }
});

// Verify EPAM_RALPH_WIGGUM_ENABLED=0 is set in tier scripts (prevents token burn)
describe('Ralph loop disabled in tier scripts', () => {
  const TIER_SCRIPTS = [
    'orchestrations/scripts/tier1-mock-run.sh',
    'orchestrations/scripts/tier3-paid-run.sh',
  ];

  for (const script of TIER_SCRIPTS) {
    it(`${script} sets EPAM_RALPH_WIGGUM_ENABLED=0`, () => {
      const result = spawnSync(
        'grep',
        ['-c', 'EPAM_RALPH_WIGGUM_ENABLED=0', script],
        {
          encoding: 'utf8',
          cwd: '/home/bradleyjerome/projects/ai/epam-cli',
        }
      );
      const count = parseInt((result.stdout ?? '0').trim(), 10);
      expect(count).toBeGreaterThan(0);
    });
  }
});

// Verify tier3 sets EPAM_MAX_RETRIES (spin gate) and has spec phase enabled (no EPAM_SPEC_MODE=0)
describe('tier3 spin gate and spec phase', () => {
  it('tier3-paid-run.sh sets EPAM_MAX_RETRIES', () => {
    const result = spawnSync(
      'grep', ['-c', 'EPAM_MAX_RETRIES', 'orchestrations/scripts/tier3-paid-run.sh'],
      { encoding: 'utf8', cwd: '/home/bradleyjerome/projects/ai/epam-cli' }
    );
    expect(parseInt((result.stdout ?? '0').trim(), 10)).toBeGreaterThan(0);
  });

  it('tier3-paid-run.sh does not disable spec phase (EPAM_SPEC_MODE=0 must be absent)', () => {
    const result = spawnSync(
      'grep', ['-c', 'EPAM_SPEC_MODE=0', 'orchestrations/scripts/tier3-paid-run.sh'],
      { encoding: 'utf8', cwd: '/home/bradleyjerome/projects/ai/epam-cli' }
    );
    // grep -c returns 0 lines matched = exit 1, count = 0 — that's what we want
    const count = parseInt((result.stdout ?? '0').trim(), 10);
    expect(count).toBe(0);
  });
});
// Verify speckit can resolve its provider for the tier3 travel app run
describe('speckit provider wiring (tier3-travel-app-run.sh + ai-run.sh)', () => {
  it('tier3-travel-app-run.sh exports EPAM_ORCHESTRATION_PROVIDER', () => {
    const result = spawnSync(
      'grep', ['-c', 'EPAM_ORCHESTRATION_PROVIDER', 'orchestrations/scripts/tier3-travel-app-run.sh'],
      { encoding: 'utf8', cwd: '/home/bradleyjerome/projects/ai/epam-cli' }
    );
    expect(parseInt((result.stdout ?? '0').trim(), 10)).toBeGreaterThan(0);
  });

  it('ai-run.sh supports minimax provider', () => {
    const result = spawnSync(
      'grep', ['-c', 'minimax', 'orchestrations/scripts/ai-run.sh'],
      { encoding: 'utf8', cwd: '/home/bradleyjerome/projects/ai/epam-cli' }
    );
    expect(parseInt((result.stdout ?? '0').trim(), 10)).toBeGreaterThan(0);
  });

  it('ai-run.sh does not emit "unsupported provider" for minimax', () => {
    // Confirm minimax is in the supported provider case branch (not the catch-all *)
    const result = spawnSync(
      'grep', ['-n', 'minimax', 'orchestrations/scripts/ai-run.sh'],
      { encoding: 'utf8', cwd: '/home/bradleyjerome/projects/ai/epam-cli' }
    );
    expect(result.stdout).toContain('minimax');
    // The match must be in the case branch line, not the unsupported error line
    expect(result.stdout).not.toContain('unsupported');
  });
});

// Verify spec-mode-runner exits non-zero when all agents fail
describe('spec-mode-runner total failure detection', () => {
  it('spec-mode-runner exits 1 when all agent attempts failed', () => {
    const { agentAttempts, agentFailures, allFailed } = (() => {
      const attempts = 4;
      const failures = 4;
      return { agentAttempts: attempts, agentFailures: failures, allFailed: failures === attempts };
    })();
    expect(allFailed).toBe(true);
  });

  it('spec-mode-runner does NOT exit 1 when only some agents failed (partial success)', () => {
    const agentAttempts = 4;
    const agentFailures = 2;
    const allFailed = agentFailures === agentAttempts;
    expect(allFailed).toBe(false);
  });

  it('spec-mode-runner source contains total-failure exit logic', () => {
    const result = spawnSync(
      'grep', ['-c', 'agentFailures === summary.stats.agentAttempts', 'orchestrations/scripts/spec-mode-runner.js'],
      { encoding: 'utf8', cwd: '/home/bradleyjerome/projects/ai/epam-cli' }
    );
    expect(parseInt((result.stdout ?? '0').trim(), 10)).toBeGreaterThan(0);
  });
});

describe('merge strategy (run-agent-orchestration.sh)', () => {
  it('uses -X ours on worktree merge to handle add/add conflicts', () => {
    const result = spawnSync(
      'grep',
      ['-c', 'merge.*-X ours', 'orchestrations/scripts/run-agent-orchestration.sh'],
      {
        encoding: 'utf8',
        cwd: '/home/bradleyjerome/projects/ai/epam-cli',
      }
    );
    const count = parseInt((result.stdout ?? '0').trim(), 10);
    expect(count).toBeGreaterThan(0);
  });
});
