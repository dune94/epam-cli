/**
 * Cost must be attributable to BOTH an agent and a story.
 *
 * Backlog B6, and the third "same omission shape" in as many days:
 *   1. emits existed but carried no cost      -> fixed
 *   2. cost existed but no agent attribution  -> fixed (costAgent now passed)
 *   3. agent attribution exists but no STORY  -> this file
 *
 * `runClaude` reads `opts.costStoryId` (spec-mode-runner.js) and NO call site ever
 * passed it, so every cost_snapshot carried `storyId: ''`. Live symptom: story_id
 * null on 12 of 17 activity events. "What did this run cost" is answerable;
 * "which STORY cost most" is not — and that is the question that drives ladder and
 * model tuning.
 *
 * These are call-site completeness assertions, deliberately. The defect is "a call
 * site forgot to pass a parameter", which a behavioural test of any single site
 * cannot catch — only enumerating every site can. Same rationale as the
 * agent-invocation registry test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

/**
 * Every `runClaude(...)` invocation with its full argument text, excluding the
 * function's own definition. Brace-matched rather than line-sliced — a fixed-size
 * window has produced false results in this suite four times.
 */
function runClaudeCallSites(): { index: number; text: string }[] {
  const sites: { index: number; text: string }[] = [];
  const re = /runClaude\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SRC))) {
    const before = SRC.slice(Math.max(0, m.index - 10), m.index);
    if (/function\s+$/.test(before)) continue;            // the definition itself
    let depth = 0, i = m.index + 'runClaude'.length;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '(') depth++;
      else if (SRC[i] === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    sites.push({ index: m.index, text: SRC.slice(m.index, i) });
  }
  return sites;
}

/** 1-based line number, so a failure points at something clickable. */
const lineOf = (i: number) => SRC.slice(0, i).split('\n').length;

describe('cost attribution — every agent call site identifies itself', () => {
  const sites = runClaudeCallSites();

  it('finds the call sites', () => {
    expect(sites.length).toBeGreaterThan(3);
  });

  it('every runClaude call passes costAgent (never falls back to spec-mode-agent)', () => {
    const missing = sites.filter(s => !/costAgent\s*:/.test(s.text))
      .map(s => `spec-mode-runner.js:${lineOf(s.index)}`);
    expect(missing, 'these calls would be logged as the generic spec-mode-agent bucket')
      .toEqual([]);
  });

  it('every runClaude call passes costStoryId (B6 — cost was unattributable to a story)', () => {
    const missing = sites.filter(s => !/costStoryId\s*:/.test(s.text))
      .map(s => `spec-mode-runner.js:${lineOf(s.index)}`);
    expect(missing, 'these calls emit cost with storyId:"" — ungroupable by story')
      .toEqual([]);
  });
});
