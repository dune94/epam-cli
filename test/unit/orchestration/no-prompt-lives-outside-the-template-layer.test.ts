/**
 * NO PROMPT LIVES OUTSIDE THE TEMPLATE LAYER.
 *
 * Operator rule, 2026-08-15: every prompt lives in orchestrations/prompts/templates. All of
 * them, no exceptions.
 *
 * WHY THIS TEST EXISTS RATHER THAN A COUNT. Every sweep of this codebase has under-reported,
 * each by a different form:
 *
 *   - matching heredocs only            -> missed spec-mode-runner.js entirely (a whole file)
 *   - matching `const …Prompt = \``      -> counted four FILE PATHS as prompts
 *   - matching delimiters named *PROMPT* -> missed COORD_EOF, LINT_FIND_EOF, LINT_AC_EOF,
 *                                           all three of which carry agent-directed prose
 *   - matching `${VAR:0:N}` truncation   -> missed `${VAR: -500}`, which cut agent input
 *
 * The register in memory records the same lesson: a single-method sweep under-reports by a
 * factor of three. So the remaining work is not a number I assert — it is whatever this test
 * finds, and the count maintains itself.
 *
 * WHAT COUNTS AS A PROMPT. Second-person instruction addressed to a model: "You are …",
 * "Your job is …", "Output ONLY …", "Emit ONLY …", "Respond with …". That is deliberately
 * narrow. It will not catch a prompt written entirely in the third person, and it is not
 * meant to be the last word — it is meant to be a floor that cannot silently regress.
 *
 * THE ALLOWLIST IS EVIDENCE, NOT SUPPRESSION. Every entry states why the line is not a prompt
 * a model receives. An entry with no reason is itself a failure, so the list cannot grow by
 * habit — which is how "temporary" exemptions become permanent everywhere else.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations');
const TEMPLATES = join(ORCH, 'prompts/templates');

/** Second-person instruction to a model. Narrow on purpose — a floor, not a ceiling. */
const PROMPT_PROSE = [
  // "You are a/an/the …" AND "You are surveying/reviewing/checking …". The first version
  // only matched the article form and failed its own non-vacuity check against
  // estate-survey.json, whose prompt opens "You are surveying an estate" — a pattern that
  // cannot see a real shipped prompt is not a floor, it is decoration.
  /\bYou are (a|an|the|acting|now|being)\b/,
  /\bYou are \w+ing\b/,
  /\bYour (job|task|role|goal) is\b/,
  /\bYou (will|must) (receive|be given|answer|emit|output|return)\b/,
  /\bOutput ONLY\b/,
  /\bEmit ONLY\b/,
  /\bRespond with (ONLY|only|a|the)\b/,
];

/**
 * Lines that match the prose patterns but are NOT a prompt sent to a model.
 * Each entry must say why. Keyed by "<relative path>:<line>".
 */
const ALLOW: Record<string, string> = {};

/** Every orchestration source file, excluding the template layer itself. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'templates', 'logs', 'runs', 'archive']);
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (skip.has(e)) continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (/\.(sh|js|mjs)$/.test(e)) out.push(p);
    }
  };
  walk(join(ORCH, 'scripts'));
  walk(join(ORCH, 'plugins'));
  return out;
}

/** A comment line carries no prompt — it documents one. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('#') || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

type Hit = { key: string; text: string };

function findProse(): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles()) {
    const rel = relative(ROOT, file);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (isComment(line)) return;
      if (!PROMPT_PROSE.some((re) => re.test(line))) return;
      const key = `${rel}:${i + 1}`;
      if (ALLOW[key]) return;
      hits.push({ key, text: line.trim().slice(0, 100) });
    });
  }
  return hits;
}

describe('the guard is real', () => {
  it('walks a meaningful number of orchestration files', () => {
    expect(sourceFiles().length).toBeGreaterThan(40);
  });

  it('would catch prose if it appeared — the patterns match a known prompt', () => {
    // Non-vacuity: if PROMPT_PROSE stopped matching anything, every assertion below would
    // pass while proving nothing.
    const sample = readFileSync(join(TEMPLATES, 'estate-survey.json'), 'utf8');
    expect(PROMPT_PROSE.some((re) => re.test(sample))).toBe(true);
  });

  it('every allowlist entry states why it is not a prompt', () => {
    for (const [key, reason] of Object.entries(ALLOW)) {
      expect(String(reason).trim().length, `${key} is allowlisted with no reason`)
        .toBeGreaterThan(20);
    }
  });
});

describe('no orchestration file carries agent-directed prose', () => {
  it('lists everything still embedded', () => {
    const hits = findProse();
    const report = hits.map((h) => `  ${h.key}  ${h.text}`).join('\n');
    expect(hits.map((h) => h.key),
      `${hits.length} line(s) of agent-directed prose live outside the template layer:\n${report}`,
    ).toEqual([]);
  });
});
