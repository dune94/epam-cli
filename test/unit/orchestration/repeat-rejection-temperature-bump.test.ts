/**
 * Repeat-rejection temperature bump — added 2026-08-01. When
 * _rejection_repeat_check detects the SAME model producing the SAME
 * rejection twice in a row (real live evidence: AMSD-2041 2026-07-30
 * produced byte-identical prescribed-helper rejections on attempts 2, 3, 4
 * while the corrective sat in the prompt 21 times over), that's direct
 * evidence this exact input/temperature combination is stuck — not just
 * "this is a new rung now". This bump nudges temperature further on top of
 * whatever the rung's own baseline already set, additive and capped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractBumpBlock(): string {
  const start = claudeSrc.indexOf('# Repeat-rejection temperature bump:');
  const marker = '                    export EPAM_TEMPERATURE="$_bumped_temp"\n                fi\n';
  const end = claudeSrc.indexOf(marker, start) + marker.length;
  return claudeSrc.slice(start, end);
}

const BUMP_BLOCK = extractBumpBlock();

function runBump(baselineTemp: string, repeatDetected: boolean, envOverrides: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'repeat-rejection-bump-'));
  try {
    const scriptPath = join(dir, 'run.sh');
    const envLines = Object.entries(envOverrides).map(([k, v]) => `${k}="${v}"`).join('\n');
    const script = `
log() { :; }
EPAM_TEMPERATURE="${baselineTemp}"
_repeat_rejection_detected=${repeatDetected}
${envLines}
apply_bump() {
${BUMP_BLOCK}
}
apply_bump
echo "$EPAM_TEMPERATURE"
`;
    writeFileSync(scriptPath, script);
    return execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('repeat-rejection temperature bump', () => {
  it('does nothing when no repeat rejection was detected', () => {
    expect(runBump('0.3', false)).toBe('0.3');
  });

  it('adds the default bump (0.2) on top of a rung baseline of 0.3', () => {
    expect(runBump('0.3', true)).toBe('0.50');
  });

  it('adds 0.2 to a rung-1 baseline of 0', () => {
    expect(runBump('0', true)).toBe('0.20');
  });

  it('adds 0.2 to a rung-2 baseline of 0.5', () => {
    expect(runBump('0.5', true)).toBe('0.70');
  });

  it('caps at the default max (1.0) rather than exceeding it', () => {
    expect(runBump('0.9', true)).toBe('1.00');
  });

  it('does not exceed the cap even from a rung-3 baseline already near it', () => {
    expect(runBump('0.95', true)).toBe('1.00');
  });

  it('respects a custom EPAM_REPEAT_REJECTION_TEMPERATURE_BUMP', () => {
    expect(runBump('0.2', true, { EPAM_REPEAT_REJECTION_TEMPERATURE_BUMP: '0.5' })).toBe('0.70');
  });

  it('respects a custom EPAM_REPEAT_REJECTION_TEMPERATURE_MAX cap', () => {
    expect(runBump('0.8', true, { EPAM_REPEAT_REJECTION_TEMPERATURE_MAX: '0.9' })).toBe('0.90');
  });
});
