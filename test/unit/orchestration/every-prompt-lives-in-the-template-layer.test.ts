/**
 * EVERY PROMPT LIVES IN THE TEMPLATE LAYER — DETECTED STRUCTURALLY, NOT BY PROSE.
 *
 * Operator, 2026-08-16: "I want 100% of prompts anywhere in templates - do not overrule or hide
 * this."
 *
 * WHY THIS REPLACES THE PROSE GUARD. no-prompt-lives-outside-the-template-layer.test.ts matches
 * second-person and imperative openers. It reported 84, then 98 once the imperative forms were
 * added, and it still missed:
 *
 *   - lib/codeline-discovery.js entirely — its prompt opens with a heading, not "You are"
 *   - every prompt in spec-mode-runner.js reachable only as a multi-line template literal
 *
 * Each of those counts was quoted as if it were the total. It never was, and a method that
 * under-reports by an unknown amount cannot answer "is it 100%".
 *
 * THE STRUCTURAL RULE. A prompt is a long piece of text assembled in code and handed to a model.
 * There is exactly one shape for that in each language:
 *
 *   JS     a multi-line template literal carrying sentences
 *   shell  a heredoc carrying sentences
 *
 * So this looks for those shapes and does not care what words they open with. It over-detects on
 * purpose — a SQL string or a usage message has the same shape — and every non-prompt is
 * allowlisted with a stated reason. Over-detection with evidence is a floor that cannot silently
 * rise; pattern-matching prose is a floor that rises whenever someone writes a prompt in the
 * third person.
 *
 * THE ALLOWLIST IS THE POINT. An entry says why that literal is not sent to a model. An entry
 * with no reason fails, so the list cannot grow by habit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations');

/** Source files that could carry a prompt. The template zone itself is where they belong. */
function sourceFiles(exts: RegExp): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'templates', 'logs', 'runs', 'archive', 'dashboards']);
  const walk = (dir: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (skip.has(e)) continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (exts.test(e)) out.push(p);
    }
  };
  walk(join(ORCH, 'scripts'));
  walk(join(ORCH, 'plugins'));
  return out;
}

/** Words that make a block prose rather than code, data or a path list. */
const wordCount = (s: string) => (s.match(/\b[a-z]{3,}\b/g) || []).length;

type Hit = { key: string; head: string; lines: number };

/**
 * Multi-line template literals in JS.
 *
 * Balanced by counting backticks per line, which is enough here: the corpus has no nested
 * template literal spanning lines, and a miscount would OVER-report by joining two literals —
 * an error that shows up as a hit to be explained, never as a silent pass.
 */
function jsLiterals(): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles(/\.(js|mjs)$/)) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    let i = 0;
    while (i < lines.length) {
      const isComment = /^\s*(\/\/|\*|\/\*)/.test(lines[i]);
      if (!isComment && lines[i].includes('`')) {
        let j = i;
        let ticks = (lines[i].match(/`/g) || []).length;
        while (ticks % 2 === 1 && j < lines.length - 1) {
          j += 1;
          ticks += (lines[j].match(/`/g) || []).length;
        }
        const body = lines.slice(i, j + 1).join('\n');
        if (j - i >= 3 && wordCount(body) >= 25) {
          hits.push({ key: `${rel}:${i + 1}`, head: lines[i].trim().slice(0, 70), lines: j - i + 1 });
        }
        i = j + 1;
      } else i += 1;
    }
  }
  return hits;
}

/** Heredocs in shell, by their opening delimiter. */
function shellHeredocs(): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles(/\.sh$/)) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\s*#/.test(lines[i])) continue;
      const m = lines[i].match(/<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*$/);
      if (!m) continue;
      const delim = m[1];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== delim) j += 1;
      const body = lines.slice(i + 1, j).join('\n');
      if (j - i >= 4 && wordCount(body) >= 25) {
        hits.push({ key: `${rel}:${i + 1}`, head: `<<${delim}`, lines: j - i });
      }
      i = j;
    }
  }
  return hits;
}

/**
 * Blocks that have a prompt's SHAPE but are not sent to a model. Each states why.
 * Keyed by "<relative path>:<line>".
 */
const ALLOW: Record<string, string> = {};

const unexplained = (hits: Hit[]) => hits.filter((h) => !ALLOW[h.key]);

const report = (hits: Hit[]) =>
  hits.map((h) => `  ${h.key}  (${h.lines} lines)  ${h.head}`).join('\n');

describe('the detector is real', () => {
  it('walks a meaningful corpus in both languages', () => {
    expect(sourceFiles(/\.(js|mjs)$/).length).toBeGreaterThan(15);
    expect(sourceFiles(/\.sh$/).length).toBeGreaterThan(20);
  });

  it('finds the shapes it is looking for — it is not matching nothing', () => {
    // Non-vacuity. If either detector stopped finding anything, "zero prompts outside the layer"
    // would pass while proving the opposite. Counted BEFORE the allowlist, so it stays true once
    // the migration is finished and every remaining block is explained.
    expect(jsLiterals().length + shellHeredocs().length,
      'neither detector finds any multi-line block at all — they have stopped working',
    ).toBeGreaterThan(0);
  });

  it('every allowlist entry says why that block is not a prompt', () => {
    for (const [key, reason] of Object.entries(ALLOW)) {
      expect(String(reason).trim().length, `${key} is allowlisted with no reason`).toBeGreaterThan(25);
    }
  });

  it('no allowlist entry points at a block that no longer exists', () => {
    // A stale entry silently covers whatever moves onto that line next.
    const live = new Set([...jsLiterals(), ...shellHeredocs()].map((h) => h.key));
    const stale = Object.keys(ALLOW).filter((k) => !live.has(k));
    expect(stale, `allowlist entries for blocks that are gone:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});

describe('no prompt is assembled in code', () => {
  it('JavaScript holds no multi-line prompt literal', () => {
    const hits = unexplained(jsLiterals());
    expect(hits.map((h) => h.key),
      `${hits.length} multi-line literal(s) in JS are unexplained. Each is a prompt to migrate, `
      + `or a non-prompt to allowlist WITH ITS REASON:\n${report(hits)}`,
    ).toEqual([]);
  });

  it('shell holds no heredoc prompt', () => {
    const hits = unexplained(shellHeredocs());
    expect(hits.map((h) => h.key),
      `${hits.length} heredoc(s) in shell are unexplained. Each is a prompt to migrate, or a `
      + `non-prompt to allowlist WITH ITS REASON:\n${report(hits)}`,
    ).toEqual([]);
  });
});
