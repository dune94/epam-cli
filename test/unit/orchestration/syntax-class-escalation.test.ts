/**
 * check_syntax_class_error — escalate immediately on a pure syntax-error
 * diagnosis, instead of waiting for check_healing_effectiveness's 2-repeat
 * threshold to fire first.
 *
 * User request (2026-07-10, after SKY-003-impl recurred the SAME "Missing
 * closing brace in cli.ts at line 375" diagnosis 3+ times before escalating):
 * "how to resolve this annoying behavior" — chose "escalate immediately on
 * syntax-class errors" over waiting for a repeat. A pure syntax error (bad
 * brace/paren/bracket balance, unterminated string, missing semicolon,
 * invalid type assertion, a TS10xx/TS11xx parser diagnostic) is never a
 * subtle logic mistake that benefits from a same-tier retry with a text
 * hint — the model either can or can't produce syntactically valid
 * TypeScript, so there's nothing to "learn" from repeating at the same tier.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const start = claudeSrc.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name} not found`);
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

describe('claude.sh — check_syntax_class_error wiring (static)', () => {
  it('is defined', () => {
    expect(claudeSrc).toMatch(/check_syntax_class_error\(\)\s*\{/);
  });

  it('is called in run_failure_analyst BEFORE check_healing_effectiveness (so a syntax error never waits for a repeat)', () => {
    const syntaxIdx = claudeSrc.indexOf('check_syntax_class_error "$story_id" "$diagnosis"');
    const healingIdx = claudeSrc.indexOf('check_healing_effectiveness "$story_id" "$diagnosis"');
    expect(syntaxIdx).toBeGreaterThan(-1);
    expect(healingIdx).toBeGreaterThan(-1);
    expect(syntaxIdx).toBeLessThan(healingIdx);
  });
});

describe('check_syntax_class_error — REAL execution', () => {
  function run(diagnosis: string, alreadyBroken = false): { healingBroken: string } {
    const dir = mkdtempSync(join(tmpdir(), 'syntax-class-'));
    try {
      const fnBody = extractFunctionBody('check_syntax_class_error');
      const script = [
        'log() { :; }',
        `HEALING_BROKEN=${alreadyBroken ? 1 : 0}`,
        fnBody,
        `check_syntax_class_error "SKY-003-impl" ${JSON.stringify(diagnosis)}`,
        'echo "HEALING_BROKEN=$HEALING_BROKEN"',
      ].join('\n');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, script);
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const m = output.match(/HEALING_BROKEN=(\d)/);
      return { healingBroken: m ? m[1] : '' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live shape and proves the fix: "missing closing brace" escalates on the FIRST occurrence', () => {
    const { healingBroken } = run('Missing closing brace in cli.ts at line 375 causing TS1005 error.');
    expect(healingBroken).toBe('1');
  });

  it.each([
    'Unterminated string literal in server.ts at line 42',
    'Missing semicolon after function declaration in server.ts',
    "Invalid type assertion syntax in cli.ts",
    'Unexpected token in client.ts',
    'TS1128 error: Declaration or statement expected',
  ])('escalates on syntax-class diagnosis: "%s"', (diagnosis) => {
    const { healingBroken } = run(diagnosis);
    expect(healingBroken).toBe('1');
  });

  it('does NOT escalate a genuinely logical/semantic diagnosis (not a syntax error)', () => {
    const { healingBroken } = run('Constructor does not throw expected error for missing API key');
    expect(healingBroken).toBe('0');
  });

  it('does not touch HEALING_BROKEN if it is already set (no redundant re-trigger)', () => {
    const { healingBroken } = run('Missing closing brace in cli.ts', true);
    expect(healingBroken).toBe('1');
  });
});
