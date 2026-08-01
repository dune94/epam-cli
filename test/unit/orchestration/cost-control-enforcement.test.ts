/**
 * The story-level cost-control block in claude.sh's implement_story() retry
 * loop (added 2026-08-01, alongside llm-settings.json's costControls). This
 * is a control-flow change — a hard-limit breach forces retry_count past
 * MAX_RETRIES and pre-marks _retry_extension_used=1 so
 * run_retry_extension_coordinator() (the self-heal path, which can GRANT
 * more retries right after the loop exits) is never consulted. That
 * short-circuit is exactly the kind of thing that must be proven against a
 * fixture before a live-cost sandbox run relies on it, not just read.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractCostControlBlock(src: string): string {
  const start = src.indexOf("# Cost controls. Sums this story's own real cost");
  const marker = '\n        fi\n';
  const firstFi = src.indexOf(marker, start);
  const end = src.indexOf(marker, firstFi + 1) + marker.length;
  return src.slice(start, end);
}

const COST_BLOCK = extractCostControlBlock(claudeSrc);

function runCostControlCheck(opts: {
  storyId: string;
  costRecords: Array<{ story_id: string; task_cost_usd: number }>;
  warningUsd?: number;
  hardLimitUsd?: number;
  initialBudgetWarned?: '0' | '1';
}): { warned: boolean; retryExtensionUsed: string; retryCount: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cost-control-test-'));
  try {
    const costFile = join(dir, 'phase-cost.jsonl');
    writeFileSync(costFile, opts.costRecords.map(r => JSON.stringify(r)).join('\n') + '\n');
    const scriptPath = join(dir, 'run.sh');
    const script = `
LOG_DIR="${dir}"
PHASE_COST_FILE="${costFile}"
story_id="${opts.storyId}"
MAX_RETRIES=7
retry_count=3
_retry_extension_used=0
_budget_warned="${opts.initialBudgetWarned ?? '0'}"
${opts.warningUsd !== undefined ? `EPAM_STORY_BUDGET_WARNING_USD="${opts.warningUsd}"` : ''}
${opts.hardLimitUsd !== undefined ? `EPAM_STORY_BUDGET_HARD_LIMIT_USD="${opts.hardLimitUsd}"` : ''}
warning() { echo "WARN: $1" >&2; }
error() { echo "ERROR: $1" >&2; }
check_cost_control() {
${COST_BLOCK}
}
check_cost_control
echo "_retry_extension_used=$_retry_extension_used"
echo "retry_count=$retry_count"
echo "_budget_warned=$_budget_warned"
exit 0
`;
    writeFileSync(scriptPath, script);
    const result = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
    const stdout = result.stdout ?? '';
    const stderrOut = result.stderr ?? '';
    const get = (name: string) => {
      const m = stdout.match(new RegExp(`^${name}=(.*)$`, 'm'));
      return m ? m[1] : '';
    };
    return {
      warned: /WARN:/.test(stderrOut),
      retryExtensionUsed: get('_retry_extension_used'),
      retryCount: get('retry_count'),
      stderr: stderrOut,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('story cost-control block — warning threshold', () => {
  it('warns once when cumulative cost exceeds the warning threshold', () => {
    const result = runCostControlCheck({
      storyId: 'US-1',
      costRecords: [
        { story_id: 'US-1', task_cost_usd: 2 },
        { story_id: 'US-1', task_cost_usd: 2 },
      ],
      warningUsd: 3,
    });
    expect(result.warned).toBe(true);
    expect(result.retryExtensionUsed).toBe('0');
    expect(result.retryCount).toBe('3'); // unchanged — warning never touches retry_count
  });

  it('does not warn when cost is under the threshold', () => {
    const result = runCostControlCheck({
      storyId: 'US-1',
      costRecords: [{ story_id: 'US-1', task_cost_usd: 1 }],
      warningUsd: 3,
    });
    expect(result.warned).toBe(false);
  });

  it('does not warn twice in the same story (respects _budget_warned=1 already set)', () => {
    const result = runCostControlCheck({
      storyId: 'US-1',
      costRecords: [{ story_id: 'US-1', task_cost_usd: 10 }],
      warningUsd: 1,
      initialBudgetWarned: '1',
    });
    expect(result.warned).toBe(false);
  });

  it('only sums cost records for the matching story_id, not other stories in the same run', () => {
    const result = runCostControlCheck({
      storyId: 'US-1',
      costRecords: [
        { story_id: 'US-1', task_cost_usd: 1 },
        { story_id: 'US-2', task_cost_usd: 100 },
      ],
      warningUsd: 5,
    });
    expect(result.warned).toBe(false);
  });
});

describe('story cost-control block — hard limit enforcement', () => {
  it('forces retry_count past MAX_RETRIES and pre-marks _retry_extension_used=1 when the hard limit is reached', () => {
    const result = runCostControlCheck({
      storyId: 'US-1',
      costRecords: [
        { story_id: 'US-1', task_cost_usd: 4 },
        { story_id: 'US-1', task_cost_usd: 4 },
      ],
      hardLimitUsd: 8,
    });
    expect(result.retryExtensionUsed).toBe('1');
    expect(Number(result.retryCount)).toBeGreaterThan(7); // > MAX_RETRIES (7)
    expect(result.stderr).toMatch(/hard limit/);
  });

  it('does not touch retry_count or _retry_extension_used when under the hard limit', () => {
    const result = runCostControlCheck({
      storyId: 'US-1',
      costRecords: [{ story_id: 'US-1', task_cost_usd: 1 }],
      hardLimitUsd: 8,
    });
    expect(result.retryExtensionUsed).toBe('0');
    expect(result.retryCount).toBe('3');
  });

  it('does nothing when neither warning nor hard-limit env vars are set (preserves current default: unlimited)', () => {
    const result = runCostControlCheck({
      storyId: 'US-1',
      costRecords: [{ story_id: 'US-1', task_cost_usd: 999 }],
    });
    expect(result.warned).toBe(false);
    expect(result.retryExtensionUsed).toBe('0');
    expect(result.retryCount).toBe('3');
  });

  it('triggers exactly at the threshold (>=), not only strictly above it', () => {
    const result = runCostControlCheck({
      storyId: 'US-1',
      costRecords: [{ story_id: 'US-1', task_cost_usd: 8 }],
      hardLimitUsd: 8,
    });
    expect(result.retryExtensionUsed).toBe('1');
  });
});
