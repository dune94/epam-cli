/**
 * ENFORCEMENT — the engine must contain no client identity.
 *
 * The standing rule (see feedback_no_hardcoding_stack_facts) has been in place for
 * months and drifted anyway, because it was enforced by intention rather than by
 * anything that executes. Every violation found in the 2026-08-03 audit was found by
 * grepping by hand, once, on request. This test replaces that with a check that runs
 * on every suite run.
 *
 * THE VOCABULARY IS DERIVED, NOT LISTED. A hardcoded list of forbidden client names
 * would itself be the violation, and would silently fail to cover the next client.
 * Instead the forbidden tokens come from the repository's own structure:
 *   - directory names under orchestrations/projects/
 *   - each project's Jira key (JIRA_PROJECT_KEY in its config.env)
 *   - each project's codeline names (keys of its codeline-facts.json)
 * Onboard a new client and it is covered automatically, with no edit here.
 *
 * WHAT COUNTS AS "THE ENGINE": code that every project runs. A per-project launcher
 * (tier3-<project>-run.sh) is allowed to name its own project — that is what it is
 * for. Everything else — the orchestration scripts, the shared libs, the shipped
 * plugins, the shared agent profiles, and the CLI itself — must be client-free.
 *
 * SCOPE LIMIT, stated rather than hidden: comment-only lines are exempt. Provenance
 * notes ("found live 2026-07-23, AMSD-1820") are historical documentation and do not
 * change behaviour; failing on them would bury the real findings in noise. String
 * literals in prompts are NOT exempt — a prompt is behaviour, and prompts are where
 * client vocabulary does the most damage.
 *
 * Real violations this catches (all present when it was written):
 *   - plugin tool names prefixed with a client name, in a file whose own header
 *     claims "PROJECT-AGNOSTIC BY DESIGN"
 *   - a client's absolute path as an engine default in index-codelines.sh
 *   - PROJECT_NAME="<client>" in a generically-named script
 *   - a stray leftover holding a real client ticket
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const PROJECTS_DIR = join(REPO_ROOT, 'orchestrations/projects');

/** Client identity tokens, derived from the repo — never hand-listed. */
function forbiddenTokens(): string[] {
  const tokens = new Set<string>();
  if (!existsSync(PROJECTS_DIR)) return [];
  for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    tokens.add(entry.name); // project directory name
    const dir = join(PROJECTS_DIR, entry.name);

    const cfg = join(dir, 'config.env');
    if (existsSync(cfg)) {
      const m = /JIRA_PROJECT_KEY=([A-Za-z0-9]+)/.exec(readFileSync(cfg, 'utf8'));
      if (m) tokens.add(m[1]);
    }

    const facts = join(dir, 'codeline-facts.json');
    if (existsSync(facts)) {
      try {
        for (const k of Object.keys(JSON.parse(readFileSync(facts, 'utf8')))) tokens.add(k);
      } catch {
        /* a malformed project file is another test's problem */
      }
    }
  }
  // Very short tokens would match unrelated words; require enough length to be identity.
  return [...tokens].filter(t => t.length >= 4);
}

/** Files every project runs. A per-project launcher may name its own project. */
function engineFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, exts: string[]) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.git', 'runs', 'logs'].includes(entry.name)) continue;
        walk(full, exts);
      } else if (exts.some(e => entry.name.endsWith(e))) {
        out.push(full);
      }
    }
  };
  walk(join(REPO_ROOT, 'orchestrations/scripts'), ['.sh', '.js']);
  walk(join(REPO_ROOT, 'orchestrations/plugins'), ['.js']);
  walk(join(REPO_ROOT, 'src'), ['.ts']);
  for (const p of ['profiles.json', 'profiles.canonical.json', 'profiles.json.original']) {
    const f = join(REPO_ROOT, 'orchestrations/agents', p);
    if (existsSync(f)) out.push(f);
  }
  // A launcher named for its project may reference that project.
  return out.filter(f => !/^tier[0-9]+-.+-run\.sh$/.test(basename(f)));
}

const COMMENT_LINE = /^\s*(#|\/\/|\*|\/\*)/;

interface Violation {
  file: string;
  line: number;
  token: string;
  text: string;
}

function scan(files: string[], tokens: string[]): Violation[] {
  const found: Violation[] = [];
  const matchers = tokens.map(t => ({ token: t, re: new RegExp(t, 'i') }));
  for (const file of files) {
    let content: string;
    try {
      if (statSync(file).size > 4 * 1024 * 1024) continue;
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      // Referencing a per-project LAUNCHER BY FILENAME is not client vocabulary in
      // logic — kill-tier3-run.sh must name the launchers it sweeps for, and those
      // launchers are themselves exempt. Strip such filenames before matching rather
      // than weakening the token derivation, which would blind the whole check.
      const line = lines[i].replace(/tier[0-9]+-[a-z0-9-]+-run\\?\.sh/g, '<launcher>');
      if (COMMENT_LINE.test(line)) continue; // provenance notes are documentation
      for (const { token, re } of matchers) {
        if (re.test(line)) {
          found.push({
            file: relative(REPO_ROOT, file),
            line: i + 1,
            token,
            text: line.trim().slice(0, 140),
          });
          break;
        }
      }
    }
  }
  return found;
}

describe('the engine carries no client identity', () => {
  const tokens = forbiddenTokens();

  it('derives its forbidden vocabulary from the repo, not a hand-written list', () => {
    // If this ever returns nothing, the test below silently passes forever.
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('finds engine files to scan', () => {
    expect(engineFiles().length).toBeGreaterThan(0);
  });

  it('no client, project, codeline or ticket-key vocabulary appears in engine code, prompts, plugins, shared profiles or the CLI', () => {
    const violations = scan(engineFiles(), tokens);
    const report = violations
      .map(v => `  ${v.file}:${v.line}  [${v.token}]  ${v.text}`)
      .join('\n');
    expect(
      violations,
      `The engine must run on the NEXT UNKNOWN project unmodified. These lines name a ` +
        `specific client, project, codeline or ticket key:\n${report}\n\n` +
        `Fix by making the fact CONFIGURABLE (project config), DETERMINABLE (discovered ` +
        `at runtime by a plugin), or an LLM judgment — never a literal. A per-project ` +
        `launcher (tier<N>-<project>-run.sh) is exempt and may name its own project.`,
    ).toEqual([]);
  });
});
