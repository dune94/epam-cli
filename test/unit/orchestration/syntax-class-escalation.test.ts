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

  // check_syntax_class_error also calls run_change_with_reviewer_retry, which
  // is defined elsewhere in claude.sh -- extract it too so the real
  // reviewer-gated persist path actually runs, not a stub.
  function extractReviewerRetryFn(): string {
    const start = claudeSrc.indexOf('run_change_with_reviewer_retry() {');
    if (start === -1) throw new Error('run_change_with_reviewer_retry not found');
    const braceStart = claudeSrc.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < claudeSrc.length; i++) {
      if (claudeSrc[i] === '{') depth++;
      else if (claudeSrc[i] === '}') {
        depth--;
        if (depth === 0) return claudeSrc.slice(start, i + 1);
      }
    }
    throw new Error('Could not find end of run_change_with_reviewer_retry');
  }

  function extractSkillFormatFns(): string {
    const names = ['_skill_note_format_ok', '_ensure_imperative_opener'];
    return names
      .map((name) => {
        const start = claudeSrc.indexOf(`${name}() {`);
        if (start === -1) throw new Error(`${name} not found`);
        const braceStart = claudeSrc.indexOf('{', start);
        let depth = 0;
        for (let i = braceStart; i < claudeSrc.length; i++) {
          if (claudeSrc[i] === '{') depth++;
          else if (claudeSrc[i] === '}') {
            depth--;
            if (depth === 0) return claudeSrc.slice(start, i + 1);
          }
        }
        throw new Error(`Could not find end of ${name}`);
      })
      .join('\n');
  }

  function runWithProfilePersist(opts: {
    diagnosis: string;
    role?: string;
    existingProfileText?: string;
    gateProviderSet?: boolean;
  }): { healingBroken: string; profileAfter: string } {
    const dir = mkdtempSync(join(tmpdir(), 'syntax-class-persist-'));
    try {
      const prdFile = join(dir, 'prd.json');
      const role = opts.role ?? 'test-engineer';
      writeFileSync(prdFile, JSON.stringify({ stories: [{ id: 'SKY-999', agentRole: role }] }));
      const profilesFile = join(dir, 'profiles.json');
      writeFileSync(profilesFile, JSON.stringify({ [role]: opts.existingProfileText ?? 'Base profile text.' }));

      const fnBody = extractFunctionBody('check_syntax_class_error');
      const reviewerFn = extractReviewerRetryFn();
      const skillFmtFns = extractSkillFormatFns();
      const script = [
        '#!/usr/bin/env bash',
        'log() { :; }',
        'warning() { :; }',
        'HEALING_BROKEN=0',
        `MAIN_PRD_FILE=${JSON.stringify(prdFile)}`,
        `PRD_FILE=${JSON.stringify(prdFile)}`,
        `AGENT_PROFILES_FILE=${JSON.stringify(profilesFile)}`,
        // No ORCH_GATE_PROVIDER means run_change_with_reviewer_retry's own
        // internal gate-model call would fail/be skipped -- fine, since the
        // format-check path inside it handles skill_note without a live LLM
        // call when the note already satisfies _skill_note_format_ok.
        skillFmtFns,
        reviewerFn,
        fnBody,
        `check_syntax_class_error "SKY-999" ${JSON.stringify(opts.diagnosis)}`,
      ].join('\n');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, script);
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const profileAfter = JSON.parse(readFileSync(profilesFile, 'utf8'))[role] as string;
      return { healingBroken: '1', profileAfter };
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

  // Found live 2026-07-14 (SKY-003-b, tier3-travel-app run): "malformed
  // template literal"/"malformed array or bracket"/"invalid computed
  // property" are all genuine syntax errors, but none matched the pattern
  // list -- 6 straight retries on the same corrupted line never escalated
  // via this function at all, only via the slower repeat-of-2 fallback.
  it.each([
    'Syntax error in cli.test.ts line 260: likely $[renders] instead of ${renders} in template literal',
    'Syntax error in cli.test.ts at line 260: esbuild parse failure on malformed test code',
    "Syntax error in cli.test.ts line 260: invalid computed property/access near 'renders'",
    'Syntax error at cli.test.ts:260 — likely a template literal misused as computed property name',
  ])('REPRODUCES the exact live SKY-003-b defect and proves the fix: "%s" now escalates', (diagnosis) => {
    const { healingBroken } = run(diagnosis);
    expect(healingBroken).toBe('1');
  });

  it('persists a generic "patch, don\'t rewrite" skill note to the story\'s own agentRole profile on first escalation', () => {
    const { profileAfter } = runWithProfilePersist({
      diagnosis: 'Missing closing brace in cli.test.ts at line 260',
      role: 'test-engineer',
    });
    expect(profileAfter).toMatch(/patch only the broken line range/i);
    expect(profileAfter).toMatch(/never regenerate the whole file/i);
  });

  it('the persisted note is under 200 chars (deterministic fast-path, no live LLM gate call needed)', () => {
    const { profileAfter } = runWithProfilePersist({
      diagnosis: 'Missing closing brace in cli.test.ts at line 260',
      role: 'test-engineer',
    });
    const noteMatch = profileAfter.match(/\[Self-Heal\] (.+)$/);
    expect(noteMatch).not.toBeNull();
    expect((noteMatch as RegExpMatchArray)[1].length).toBeLessThanOrEqual(200);
  });

  it('targets the STORY\'s own agentRole, not a hardcoded role name', () => {
    const { profileAfter } = runWithProfilePersist({
      diagnosis: 'Missing closing brace in server.ts',
      role: 'backend-engineer',
    });
    expect(profileAfter).toMatch(/patch only the broken line range/i);
  });

  it('does not duplicate the note if it is already present in the role profile', () => {
    const existing =
      'Base profile text.\n\n[Self-Heal] Always patch only the broken line range on a repeated syntax-error retry -- never regenerate the whole file, since a full rewrite tends to reproduce the same corruption elsewhere.';
    const { profileAfter } = runWithProfilePersist({
      diagnosis: 'Missing closing brace in cli.test.ts',
      role: 'test-engineer',
      existingProfileText: existing,
    });
    const occurrences = (profileAfter.match(/patch only the broken line range/gi) || []).length;
    expect(occurrences).toBe(1);
  });
});
