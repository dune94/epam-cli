/**
 * Misleading gpt-5-codex log line (found live, 2026-07-10, tier3-travel-app
 * run): resolve_effort_settings() logged "Effort[low] -> model=gpt-5-codex
 * ..." unconditionally, BEFORE resolve_model_from_story() ever checked
 * prd.json for a per-story model override. In every observed live
 * invocation the PRD assignment overrode it to MiniMax-M3/moonshotai/kimi-k2
 * -- gpt-5-codex (a config placeholder default) was never actually
 * dispatched, and there was never a corresponding Cost[...] line naming it.
 * Read at a glance mid-run, it looks like a third model is in rotation and
 * costing money, which it never is.
 *
 * Fix (log-only, zero behavior/cost impact): resolve_effort_settings() no
 * longer logs a model name at all (only effort/turns/maxIter/maxOutTok,
 * which are real regardless of which model ends up used).
 * resolve_model_from_story() now ALWAYS logs the model that will actually be
 * used -- either the prd.json override, or (new) the effort-tier default
 * when no override exists -- so exactly one model name is ever logged per
 * story, and it's always the real one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(claudeSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

describe('resolve_effort_settings() — no longer logs a provisional model name (static)', () => {
  it('does not log "model=" in its own Effort[...] line', () => {
    const fnBody = extractFunctionBody('resolve_effort_settings');
    const logLineIdx = fnBody.indexOf('log "  Effort[');
    expect(logLineIdx).toBeGreaterThan(-1);
    const logLine = fnBody.slice(logLineIdx, fnBody.indexOf('\n', logLineIdx));
    expect(logLine).not.toMatch(/model=/);
  });

  it('still logs the real, always-accurate fields: turns/maxIter/maxOutTok', () => {
    const fnBody = extractFunctionBody('resolve_effort_settings');
    const logLineIdx = fnBody.indexOf('log "  Effort[');
    const logLine = fnBody.slice(logLineIdx, fnBody.indexOf('\n', logLineIdx));
    expect(logLine).toMatch(/turns=/);
    expect(logLine).toMatch(/maxIter=/);
    expect(logLine).toMatch(/maxOutTok=/);
  });
});

describe('resolve_model_from_story() — REAL execution: always logs the model that actually gets used', () => {
  function run(opts: { storyModelInPrd?: string }): { logOutput: string; storyModel: string } {
    const dir = mkdtempSync(join(tmpdir(), 'model-log-'));
    try {
      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({
          stories: [{ id: 'SKY-TEST', ...(opts.storyModelInPrd ? { model: opts.storyModelInPrd } : {}) }],
        }),
      );
      const fnBody = extractFunctionBody('resolve_model_from_story');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `PRD_FILE=${JSON.stringify(prdPath)}`,
          `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
          'STORY_MODEL="gpt-5-codex"', // the provisional effort-tier default, same as resolve_effort_settings would set
          'log() { echo "LOG: $*" >&2; }',
          fnBody,
          'resolve_model_from_story "SKY-TEST"',
          'echo "FINAL_MODEL=$STORY_MODEL"',
        ].join('\n'),
      );
      // log() writes to stderr, not stdout -- merge both streams via a
      // single execution (resolve_model_from_story has no side effects
      // sensitive to double-execution, but a single run + stream merge is
      // simpler and matches this repo's established pattern).
      const stderrPath = join(dir, 'stderr.log');
      const wrapperPath = join(dir, 'run-wrapper.sh');
      writeFileSync(wrapperPath, `bash ${JSON.stringify(scriptPath)} 2> ${JSON.stringify(stderrPath)}`);
      let stdout = '';
      try {
        stdout = execFileSync('bash', [wrapperPath], { encoding: 'utf8' });
      } catch (e: any) {
        stdout = (e.stdout ?? '').toString();
      }
      const stderr = readFileSync(stderrPath, 'utf8');
      const combined = stdout + stderr;
      const storyModel = combined.match(/FINAL_MODEL=(\S+)/)?.[1] ?? '';
      return { logOutput: combined, storyModel };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('logs the prd.json override when one exists (existing behavior, unchanged)', () => {
    const { logOutput, storyModel } = run({ storyModelInPrd: 'MiniMax-M3' });
    expect(storyModel).toBe('MiniMax-M3');
    expect(logOutput).toMatch(/Model\[prd\.json\] -> MiniMax-M3/);
  });

  it('NEW: logs the effort-tier default when no prd.json override exists, instead of logging nothing', () => {
    const { logOutput, storyModel } = run({});
    expect(storyModel).toBe('gpt-5-codex');
    expect(logOutput).toMatch(/Model\[effort-default\] -> gpt-5-codex/);
  });

  it('exactly one Model[...] line is ever logged per story, never zero and never two', () => {
    const withOverride = run({ storyModelInPrd: 'moonshotai/kimi-k2' });
    const withoutOverride = run({});
    const countModelLines = (s: string) => (s.match(/Model\[/g) || []).length;
    expect(countModelLines(withOverride.logOutput)).toBe(1);
    expect(countModelLines(withoutOverride.logOutput)).toBe(1);
  });
});
