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
import { createHash } from 'node:crypto';
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
  // src/ TOO. The sweep and this guard both walked orchestrations/ only, so three prompts sat in
  // TypeScript — including the one the orchestration mint loads through dist/sdk.js, which made
  // the FIRST agent of every run take its instructions from compiled code while a template
  // written for it was rendered by nothing. A guard that cannot see a directory certifies it.
  walk(join(ROOT, 'src'));
  return out;
}

/** Words that make a block prose rather than code, data or a path list. */
const wordCount = (s: string) => (s.match(/\b[a-z]{3,}\b/g) || []).length;

type Hit = { key: string; head: string; lines: number };

/**
 * A block's identity: its file plus a digest of its own text.
 *
 * Line numbers were the obvious key and the wrong one. They move whenever anything above them
 * changes, so each migration invalidated part of the allowlist and re-reported explained blocks
 * as unexplained -- 23 of them in one commit. A digest survives that.
 *
 * It also fails CLOSED where a line number failed open: editing an allowlisted block changes
 * its digest, the exemption stops applying, and the new text has to be explained. A line-number
 * key would have gone on covering whatever the block became.
 */
const blockKey = (rel: string, body: string) =>
  `${rel}#${createHash('sha256').update(body).digest('hex').slice(0, 12)}`;

/**
 * Multi-line template literals in JS.
 *
 * Balanced by counting backticks per line, which is enough here: the corpus has no nested
 * template literal spanning lines, and a miscount would OVER-report by joining two literals —
 * an error that shows up as a hit to be explained, never as a silent pass.
 */
function jsLiterals(): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles(/\.(js|mjs|ts)$/)) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    let i = 0;
    while (i < lines.length) {
      const isComment = /^\s*(\/\/|\*|\/\*)/.test(lines[i]);
      // A TEMPLATE LITERAL OPENS IN EXPRESSION POSITION.
      //
      // Counting every backtick on the line swallowed regions of 700+ lines: a backtick inside a
      // regex character class (/`[^`]*`/g, stripping inline code) reads as an unbalanced opener
      // and the scan runs on until it happens to find an odd one somewhere far below. One
      // allowlist entry then covers hundreds of lines, which is an exemption with no meaning.
      //
      // Requiring an operator, keyword or bracket immediately before the backtick keeps the real
      // openers — assignment, return, a call argument, a ternary arm, concatenation — and drops
      // backticks appearing inside other syntax.
      const opens = /(?:[=(,:?+[]|\breturn|\bthrow|=>|&&|\|\|)\s*`/.test(lines[i]);
      if (!isComment && opens) {
        let j = i;
        let ticks = (lines[i].match(/`/g) || []).length;
        // Bounded. An unterminated scan is a detector fault, not a 700-line prompt, and it must
        // say so rather than quietly reporting a region nobody can explain.
        const LIMIT = 200;
        while (ticks % 2 === 1 && j < lines.length - 1 && j - i < LIMIT) {
          j += 1;
          ticks += (lines[j].match(/`/g) || []).length;
        }
        if (j - i >= LIMIT) { i += 1; continue; }
        const body = lines.slice(i, j + 1).join('\n');
        if (j - i >= 3 && wordCount(body) >= 25) {
          hits.push({ key: blockKey(rel, body), head: `${rel}:${i + 1}  ${lines[i].trim().slice(0, 60)}`, lines: j - i + 1 });
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
        hits.push({ key: blockKey(rel, body), head: `${rel}:${i + 1}  <<${delim}`, lines: j - i });
      }
      i = j;
    }
  }
  return hits;
}

/**
 * Multi-line DOUBLE-QUOTED strings in shell.
 *
 * A heredoc is not the only way to build a prompt in bash. contextualize-stories.sh assembles its
 * reviewer prompt with echo "..." spanning twenty lines, and the heredoc detector could not see it
 * — so "four prompts remain" was, once again, a floor produced by looking for one shape.
 *
 * That is the third time this exercise has under-reported for the same reason: a detector finds
 * what it was told to look for. Both shapes are covered now, and any third one will show up the
 * same way this did — as a prompt found by accident while chasing something else.
 */
function shellQuotedStrings(): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles(/\.sh$/)) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    let i = 0;
    while (i < lines.length) {
      if (/^\s*#/.test(lines[i])) { i += 1; continue; }
      // An opening quote that does not close on its own line.
      const quotes = (lines[i].match(/(?<!\\)"/g) || []).length;
      if (quotes % 2 === 1) {
        let j = i;
        let total = quotes;
        const LIMIT = 200;
        while (total % 2 === 1 && j < lines.length - 1 && j - i < LIMIT) {
          j += 1;
          total += (lines[j].match(/(?<!\\)"/g) || []).length;
        }
        if (j - i < LIMIT) {
          const body = lines.slice(i, j + 1).join('\n');
          if (j - i >= 3 && wordCount(body) >= 25) {
            hits.push({ key: blockKey(rel, body), head: `${rel}:${i + 1}  ${lines[i].trim().slice(0, 60)}`, lines: j - i + 1 });
          }
        }
        i = j + 1;
      } else i += 1;
    }
  }
  return hits;
}

/**
 * Blocks that have a prompt's SHAPE but are not sent to a model. Each states why.
 * Keyed by "<relative path>:<line>".
 */
const ALLOW: Record<string, string> = {
  'orchestrations/scripts/lib/codeline-health.sh#a55f261c1bee':
    'A command substitution that asks the ecosystem handler which sibling repositories the estate '
    + 'provides, then reshapes its JSON into name|path lines. Shell plumbing across several lines, '
    + 'not text — no model receives it.',
  'orchestrations/scripts/lib/codeline-health.sh#37b15b4170c5':
    'A command substitution reading the missing-dependency list out of the same handler and '
    + 'stripping the JSON punctuation so a shell for-loop can iterate it. Plumbing, not prose.',
  'src/cli/commands/context.ts#f17a6f828694':
    'A FILE THIS COMMAND WRITES, not text sent to a model. `epam new` scaffolds a project and this is the content of one of the files it creates; the markdown heading is the file\u2019s own, and the reader is a developer opening it in the repository.',
  'src/cli/commands/new.ts#32cf3084efaf':
    'A FILE THIS COMMAND WRITES, not text sent to a model. `epam new` scaffolds a project and this is the content of one of the files it creates; the markdown heading is the file\u2019s own, and the reader is a developer opening it in the repository.',
  'src/scaffold/ProjectScaffolder.ts#9ce7fd46fbe5':
    'A FILE THIS COMMAND WRITES, not text sent to a model. `epam new` scaffolds a project and this is the content of one of the files it creates; the markdown heading is the file\u2019s own, and the reader is a developer opening it in the repository.',
  'src/scaffold/ProjectScaffolder.ts#f4e1ffcc6f5c':
    'A FILE THIS COMMAND WRITES, not text sent to a model. `epam new` scaffolds a project and this is the content of one of the files it creates; the markdown heading is the file\u2019s own, and the reader is a developer opening it in the repository.',
  'src/scaffold/ProjectScaffolder.ts#ffd0726d7ba6':
    'A FILE THIS COMMAND WRITES, not text sent to a model. `epam new` scaffolds a project and this is the content of one of the files it creates; the markdown heading is the file\u2019s own, and the reader is a developer opening it in the repository.',
  'src/scaffold/ScaffoldRunner.ts#ac7b08a92f3d':
    'A FILE THIS COMMAND WRITES, not text sent to a model. `epam new` scaffolds a project and this is the content of one of the files it creates; the markdown heading is the file\u2019s own, and the reader is a developer opening it in the repository.',
  'src/cli/commands/phase.ts#cc60275723df':
    'An error message printed to the operator when a phase has no valid approval. It names the command that fixes it. No model receives it.',
  'src/providers/codemie/CodemieSSO.ts#f99398ac4306':
    'The HTML page the local SSO callback server returns to the browser after a login redirect. Markup, not prose, and its reader is a browser.',
  'src/providers/copilot/CopilotProvider.ts#218b2338fdd3':
    'Device-flow sign-in instructions shown in the terminal \u2014 the code to enter and where to enter it. Read by the person at the keyboard, never by a model.',
  'orchestrations/scripts/lib/node-bin.sh#f8c3b22d3909':
    'A sed expression that reads the required node major version out of a package.json engines '
    + 'field. The detector sees the unbalanced quote inside the sed script and swallows the rest '
    + 'of the file with it. No model receives any of it.',
  'orchestrations/scripts/reset-cost-test.sh#d82c0c4d204a':
    'A grep -v pattern that strips this run\u2019s cost-test records out of a JSONL log. The same '
    + 'detector artefact as node-bin.sh: an unbalanced quote inside the pattern swallows the lines '
    + 'after it. It is a filter, not text sent anywhere.',
  'orchestrations/scripts/claude.sh#15f48a1c6038':
    'A python pipeline that TRIMS an amendment to its most recent entries. It processes '
    + 'prompt text; it is not prompt text, and no model receives it.',
  'orchestrations/scripts/claude.sh#f9b33d43266b':
    'The shell pipeline that EXTRACTS quoted string invariants from the acceptance criteria and '
    + 'formats them as a list. Its output becomes a template value (__STRING_LIST__); the pipeline '
    + 'itself is text processing, not prompt text. Re-keyed 2026-08-19: the block changed when its '
    + 'values file moved to jq_vals, and the key is a content hash, which is the point — an edited '
    + 'block loses its exemption and has to be re-explained rather than silently keeping it.',
  'orchestrations/scripts/claude.sh#29cd61ddd376':
    'A python pipeline that TRIMS an amendment to its most recent entries. It processes '
    + 'prompt text; it is not prompt text, and no model receives it.',
  'orchestrations/scripts/claude.sh#3a5231f4dfc5':
    'A python pipeline that TRIMS an amendment to its most recent entries. It processes '
    + 'prompt text; it is not prompt text, and no model receives it.',
  'orchestrations/scripts/claude.sh#3be1c81f8bcc':
    'A python pipeline that TRIMS an amendment to its most recent entries. It processes '
    + 'prompt text; it is not prompt text, and no model receives it.',
  'orchestrations/scripts/claude.sh#e253eb0dbdcb':
    'A python pipeline that TRIMS an amendment to its most recent entries. It processes '
    + 'prompt text; it is not prompt text, and no model receives it.',
  'orchestrations/scripts/lib/tc-writer-gate.sh#410d0d7b286e':
    'A multi-line shell command whose quoted argument is a program or expression, not '
    + 'prose. Executed, never sent to a model.',
  'orchestrations/scripts/run-agent-orchestration.sh#0a7253b53380':
    'A multi-line shell command whose quoted argument is a program or expression, not '
    + 'prose. Executed, never sent to a model.',
  'orchestrations/scripts/run-agent-orchestration.sh#70b09ed905af':
    'A multi-line shell command whose quoted argument is a program or expression, not '
    + 'prose. Executed, never sent to a model.',
  'orchestrations/scripts/run-agent-orchestration.sh#fdec67f3d494':
    'A multi-line shell command whose quoted argument is a program or expression, not '
    + 'prose. Executed, never sent to a model.',
  'orchestrations/scripts/claude.sh#032d3e8b03eb':
    'Usage text printed to a human operator on a bad invocation. It reaches a terminal, '
    + 'never a model.',
  'orchestrations/scripts/codemie-claude.sh#032d3e8b03eb':
    'Usage text printed to a human operator on a bad invocation. It reaches a terminal, '
    + 'never a model.',
  'orchestrations/scripts/contextualize-stories.sh#bc0d5db2a428':
    'Usage text printed to a human operator on a bad invocation. It reaches a terminal, '
    + 'never a model.',
  'orchestrations/scripts/estimate-stories.sh#64d80753eeac':
    'Usage text printed to a human operator on a bad invocation. It reaches a terminal, '
    + 'never a model.',
  'orchestrations/scripts/provider-cutover.sh#9cbb0bf8546b':
    'Usage text printed to a human operator on a bad invocation. It reaches a terminal, '
    + 'never a model.',
  'orchestrations/scripts/run-agent-orchestration.sh#0df4a51b79cf':
    'Usage text printed to a human operator on a bad invocation. It reaches a terminal, '
    + 'never a model.',
  'orchestrations/scripts/preflight-static.sh#6a43ac38a0ba':
    'A node -e scanner program the pre-flight runs over engine source. It is executed by '
    + 'node and its output is read by the shell; no model ever sees it.',
  'orchestrations/scripts/test/test-epam-providers.sh#5304c244046b':
    'A test fixture: a stub script written to disk so a test runs without the real binary. '
    + 'Executed, never sent to a model.',
  'orchestrations/scripts/test/test-epam-providers.sh#d8a768c48c03':
    'A test fixture: a stub script written to disk so a test runs without the real binary. '
    + 'Executed, never sent to a model.',
  'orchestrations/scripts/update-cost-forecasts.sh#a1a0b8b48d07':
    'Usage text printed to a human operator on a bad invocation. It reaches a terminal, '
    + 'never a model.',
};

const unexplained = (hits: Hit[]) => hits.filter((h) => !ALLOW[h.key]);

const report = (hits: Hit[]) =>
  hits.map((h) => `  ${h.head}  (${h.lines} lines)\n      key: ${h.key}`).join('\n');

describe('the detector is real', () => {
  it('walks a meaningful corpus in both languages', () => {
    expect(sourceFiles(/\.(js|mjs|ts)$/).length).toBeGreaterThan(15);
    expect(sourceFiles(/\.sh$/).length).toBeGreaterThan(20);
  });

  it('finds the shapes it is looking for — it is not matching nothing', () => {
    // Non-vacuity. If either detector stopped finding anything, "zero prompts outside the layer"
    // would pass while proving the opposite. Counted BEFORE the allowlist, so it stays true once
    // the migration is finished and every remaining block is explained.
    expect(jsLiterals().length + shellHeredocs().length + shellQuotedStrings().length,
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
    const live = new Set([...jsLiterals(), ...shellHeredocs(), ...shellQuotedStrings()].map((h) => h.key));
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

  it('shell holds no multi-line quoted prompt either', () => {
    // The shape the heredoc detector could not see. A prompt built with echo "..." over twenty
    // lines is a prompt; the syntax used to assemble it is not the point.
    const hits = unexplained(shellQuotedStrings());
    expect(hits.map((h) => h.key),
      `${hits.length} multi-line quoted string(s) in shell are unexplained. Each is a prompt to `
      + `migrate, or a non-prompt to allowlist WITH ITS REASON:\n${report(hits)}`,
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
