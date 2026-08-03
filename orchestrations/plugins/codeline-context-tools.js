'use strict';
/**
 * Codeline Context Tools — a ToolPlugin (epam-cli plugin architecture,
 * src/tools/plugin.ts + PluginLoader.ts) exposing real, ground-truth facts
 * about the codeline the story-writer agent is currently working in.
 *
 * Built 2026-08-01 after two real, live mistakes in the same session: a
 * writer prescribed a test file path that didn't match the codeline's own
 * convention (test/unit/services/contentstack.test.ts vs the real
 * src/services/__tests__/contentstack.spec.ts), and a commit failed against
 * a real husky pre-commit hook because required Contentstack env vars
 * weren't documented anywhere the agent could see. Both are now queryable
 * facts instead of guesses.
 *
 * PROJECT-AGNOSTIC BY DESIGN: this file contains no reference to any
 * specific project or codeline name. All per-project/per-codeline data comes
 * from files dropped into the codeline's own .epam/ directory by the
 * pipeline's provisioning step (see run-agent-orchestration.sh) — itself
 * driven by <project>/plugins.json and <project>/codeline-facts.json.
 * Removing/adding this plugin, or pointing another project at it, is a
 * config change (plugins.json), never a code change here.
 *
 * Registered via a codeline's .epam/settings.json "tools" array using an
 * ABSOLUTE path to this file (PluginLoader resolves a leading "/" entry via
 * path.resolve, which short-circuits to the absolute path unchanged) — so
 * this module lives in epam-cli's own repo and is never committed into any
 * client codeline.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PLUGIN_API_VERSION = '1.0.0';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const TEST_EXTENSIONS = ['.spec', '.test'];

/**
 * Real candidate test-file locations for a given source file, in the order
 * a human maintainer of this specific repo is most likely to have used them.
 * Every candidate is checked against the REAL filesystem — this never
 * invents a convention, it only reports what already exists (or, if
 * nothing exists yet, what the most common candidate location would be).
 */
function candidateTestPaths(projectRoot, sourceFile) {
  const rel = sourceFile.replace(/^\/+/, '');
  const dir = path.dirname(rel);
  const ext = path.extname(rel);
  const base = path.basename(rel, ext);
  const extsToTry = SOURCE_EXTENSIONS.includes(ext) ? [ext] : SOURCE_EXTENSIONS;

  const candidates = [];
  for (const e of extsToTry) {
    for (const marker of TEST_EXTENSIONS) {
      // 1. Co-located __tests__ directory (most common convention observed).
      candidates.push(path.join(dir, '__tests__', `${base}${marker}${e}`));
      // 2. Sibling file, no subdirectory.
      candidates.push(path.join(dir, `${base}${marker}${e}`));
    }
  }
  // 3. Mirrored top-level test/ directory (src/foo/bar.ts -> test/foo/bar.test.ts
  //    and test/unit/foo/bar.test.ts, both seen in different repos/conventions).
  const relFromSrc = dir.replace(/^src\/?/, '');
  for (const e of extsToTry) {
    for (const marker of TEST_EXTENSIONS) {
      candidates.push(path.join('test', relFromSrc, `${base}${marker}${e}`));
      candidates.push(path.join('test', 'unit', relFromSrc, `${base}${marker}${e}`));
    }
  }

  // De-duplicate while preserving priority order.
  return [...new Set(candidates)];
}

const resolveTestFileTool = {
  name: 'resolve_test_file',
  pluginApiVersion: PLUGIN_API_VERSION,
  description:
    'Given a source file path (relative to the project root), report which test file(s) ALREADY EXIST for it on disk, checked against this codeline\'s real conventions — co-located __tests__/, sibling .spec/.test files, and mirrored test/ directories. Use this BEFORE creating a new test file: extending an existing test file at its real, established path is almost always correct; inventing a new path/directory is almost always wrong.',
  permission: 'safe',
  definition: {
    name: 'resolve_test_file',
    description:
      'Report existing test file(s) for a given source file, checked against real filesystem state in this codeline.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceFile: {
          type: 'string',
          description: 'Source file path relative to the project root, e.g. "src/services/contentstack.ts"',
        },
      },
      required: ['sourceFile'],
    },
  },
  async execute(input) {
    try {
      const sourceFile = input && input.sourceFile;
      if (!sourceFile || typeof sourceFile !== 'string') {
        return { toolUseId: '', content: 'Error: sourceFile (string) is required.', isError: true };
      }
      const projectRoot = process.cwd();
      const candidates = candidateTestPaths(projectRoot, sourceFile);
      const existing = candidates.filter((c) => fs.existsSync(path.join(projectRoot, c)));

      const result =
        existing.length > 0
          ? {
              sourceFile,
              existingTestFiles: existing,
              recommendation: `Extend ${existing[0]} — it already exists and is the real, established test file for this source file. Do not create a new test file at a different path.`,
            }
          : {
              sourceFile,
              existingTestFiles: [],
              recommendation:
                candidates.length > 0
                  ? `No existing test file found. Checked ${candidates.length} conventional location(s); none exist. The most conventional new location in this codebase is: ${candidates[0]}`
                  : 'No existing test file found and no candidate locations could be derived.',
              checkedCandidates: candidates,
            };

      return { toolUseId: '', content: JSON.stringify(result, null, 2), isError: false };
    } catch (err) {
      return { toolUseId: '', content: `Error resolving test file: ${err.message}`, isError: true };
    }
  },
};

const codelineFactsTool = {
  name: 'codeline_facts',
  pluginApiVersion: PLUGIN_API_VERSION,
  description:
    'Return known, real, project-operator-curated facts and gotchas about the codeline currently being worked in — e.g. required local environment variables, known dependency quirks, test-environment requirements. These are facts that could not otherwise be discovered by reading the code alone; check this before assuming local tooling (lint, tsc, pre-commit hooks) will behave the same as in a fully-configured environment.',
  permission: 'safe',
  definition: {
    name: 'codeline_facts',
    description: 'Return curated facts/gotchas for the current codeline, if any are configured.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  async execute() {
    try {
      const factsPath = path.join(process.cwd(), '.epam', 'codeline-facts.json');
      if (!fs.existsSync(factsPath)) {
        return {
          toolUseId: '',
          content: 'No codeline-specific facts are configured for this project.',
          isError: false,
        };
      }
      const raw = fs.readFileSync(factsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const rawFacts = Array.isArray(parsed) ? parsed : Array.isArray(parsed.facts) ? parsed.facts : [];
      // A fact is either a bare string (legacy project configs) or {text, source}. Only
      // the text is handed to the agent; the source exists so a human can re-check and
      // expire the claim, not to spend prompt tokens on provenance on every call.
      const facts = rawFacts
        .map((f) => (f && typeof f === 'object' ? f.text : f))
        .filter((t) => typeof t === 'string' && t.trim().length > 0);
      if (facts.length === 0) {
        return { toolUseId: '', content: 'Codeline facts file present but empty.', isError: false };
      }
      return { toolUseId: '', content: JSON.stringify({ facts }, null, 2), isError: false };
    } catch (err) {
      return { toolUseId: '', content: `Error reading codeline facts: ${err.message}`, isError: true };
    }
  },
};

const gitStateTool = {
  name: 'git_state',
  pluginApiVersion: PLUGIN_API_VERSION,
  description:
    'Report the REAL current git state of this codeline: branch, HEAD SHA, and whether the working tree is dirty (with the list of changed files). Use this instead of assuming a clean baseline.',
  permission: 'safe',
  definition: {
    name: 'git_state',
    description: 'Report real git branch/HEAD/dirty-file state for the current codeline.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  async execute() {
    const cwd = process.cwd();
    const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
    try {
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
      const head = git(['rev-parse', 'HEAD']);
      const statusRaw = git(['status', '--porcelain']);
      const changedFiles = statusRaw ? statusRaw.split('\n').filter(Boolean) : [];
      const result = {
        branch,
        head,
        dirty: changedFiles.length > 0,
        changedFiles,
      };
      return { toolUseId: '', content: JSON.stringify(result, null, 2), isError: false };
    } catch (err) {
      return {
        toolUseId: '',
        content: `Error reading git state (is ${cwd} a git repository?): ${err.message}`,
        isError: true,
      };
    }
  },
};

const checkAntiPatternsTool = {
  name: 'check_anti_patterns',
  pluginApiVersion: PLUGIN_API_VERSION,
  description:
    'Check a piece of code you are about to write (or have just written) against this project\'s list of known, previously-diagnosed wrong patterns — rules operators have configured because a model has regressed to them before. Call this before finishing your implementation whenever you touch an area that might have a documented gotcha; it is advisory (nothing blocks you from writing), so treat any match as a real defect to fix, not a suggestion to weigh.',
  permission: 'safe',
  definition: {
    name: 'check_anti_patterns',
    description: 'Check code content against this project\'s configured anti-pattern rules; reports any matches.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The code content to check (e.g. the file you are about to write or just wrote).',
        },
        filePath: {
          type: 'string',
          description: 'Optional: the file path this content belongs to, included in the report for context.',
        },
      },
      required: ['content'],
    },
  },
  async execute(input) {
    try {
      const content = input && input.content;
      if (typeof content !== 'string') {
        return { toolUseId: '', content: 'Error: content (string) is required.', isError: true };
      }
      const filePath = (input && input.filePath) || '(unspecified file)';
      const rulesPath = path.join(process.cwd(), '.epam', 'anti-patterns.json');
      if (!fs.existsSync(rulesPath)) {
        return {
          toolUseId: '',
          content: 'No anti-pattern rules are configured for this project.',
          isError: false,
        };
      }
      let rules;
      try {
        rules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
      } catch (err) {
        return {
          toolUseId: '',
          content: `anti-patterns.json is malformed and was skipped: ${err.message}`,
          isError: false,
        };
      }
      if (!Array.isArray(rules)) {
        return { toolUseId: '', content: 'anti-patterns.json is present but not a rule array.', isError: false };
      }
      const violations = [];
      for (const rule of rules) {
        const pattern = rule && rule.matchPattern;
        if (!pattern) continue;
        let re;
        try {
          re = new RegExp(pattern);
        } catch {
          continue;
        }
        if (re.test(content)) {
          violations.push({
            id: rule.id || 'anti-pattern',
            file: filePath,
            message: rule.message || 'A known, previously-diagnosed wrong pattern was detected.',
          });
        }
      }
      if (violations.length === 0) {
        return { toolUseId: '', content: 'No configured anti-pattern matched.', isError: false };
      }
      return { toolUseId: '', content: JSON.stringify({ violations }, null, 2), isError: false };
    } catch (err) {
      return { toolUseId: '', content: `Error checking anti-patterns: ${err.message}`, isError: true };
    }
  },
};

module.exports = {
  tools: [resolveTestFileTool, codelineFactsTool, gitStateTool, checkAntiPatternsTool],
};
