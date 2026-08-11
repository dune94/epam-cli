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
  // ALWAYS try every source extension, not just the source file's own. Real convention
  // across every codeline this plugin runs against (surveyed live 2026-08-06 across
  // next.metrolinx.com, next.gotransit.com, next.upexpress.com): .ts and .tsx test files
  // both exist in real numbers in EVERY one (e.g. 106 vs 139, 370 vs 366, 104 vs 137) — a
  // .tsx source paired with a .spec.ts test is common, not an edge case. Restricting to
  // the source's own extension made a real, committed, on-topic test file for a .tsx page
  // component invisible to every review cycle, because its test file used .ts.
  const extsToTry = SOURCE_EXTENSIONS;

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

  // 4. Top-level src/__tests__/ mirror, KEEPING the src/ prefix — confirmed live 2026-08-06
  //    as the real, actual convention across all 3 codelines this plugin runs against:
  //      next.metrolinx.com:  src/__tests__/[[...slug]].spec.ts        (flat)
  //      next.gotransit.com:  src/__tests__/[...slug].spec.ts          (flat)
  //      next.upexpress.com:  src/__tests__/pages/[[...slug]].spec.ts  (nested)
  //    Distinct from strategy 3's test/ mirror (drops src/, project-root test/ dir) — this
  //    keeps src/ and nests directly under src/__tests__/. Missing this meant the tool
  //    never found a real, correctly-placed baseline test, which is very likely how the
  //    ORIGINAL incident this plugin exists to prevent happened: a writer created a new
  //    file at the wrong location because the real one was invisible to this tool.
  if (dir !== 'src' && dir.startsWith('src/')) {
    const relFromSrcTests = dir.slice('src/'.length);
    for (const e of extsToTry) {
      for (const marker of TEST_EXTENSIONS) {
        candidates.push(path.join('src', '__tests__', relFromSrcTests, `${base}${marker}${e}`));
      }
    }
  }
  // Flat form: base directly in src/__tests__/, no subdirectory (metrolinx/gotransit's
  // actual convention for a src/pages/ file — NOT nested under src/__tests__/pages/).
  for (const e of extsToTry) {
    for (const marker of TEST_EXTENSIONS) {
      candidates.push(path.join('src', '__tests__', `${base}${marker}${e}`));
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

/**
 * Scans a package's REAL installed .d.ts files for a symbol declaration, tracking class
 * context so a caller can tell "instance method, needs `new X()`" from "direct export,
 * call it as-is". Bounded, best-effort: any single unreadable file is skipped, never
 * fatal — a package with unusual layout should degrade to "found nothing" rather than
 * crash the tool.
 */
function scanDeclarations(pkgDir, symbol) {
  const declarations = [];
  const symbolRe = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\s*[:(]`);
  const classOpenRe = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

  const usageExamples = [];
  // JSDoc/comment lines (leading *, //, /**) show WORKED EXAMPLES, not type
  // declarations — real signal, but mixing them into `declarations` under a
  // requiresInstantiation label is misleading (a doc example isn't itself a
  // declaration). Caught live scanning the real @contentstack/live-preview-utils
  // package: its own JSDoc examples for unsubscribeOnEntryChange read
  // "ContentstackLivePreview.unsubscribeOnEntryChange(callbackUid);" inside a
  // comment block, which is exactly the package's own documented usage.
  const commentLineRe = /^\s*(\*|\/\/|\/\*)/;

  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full, depth + 1);
      } else if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.cts')) {
        let content;
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        const lines = content.split('\n');
        // Simple brace-depth class tracker: good enough for the flat, single-class-per-
        // scope shape every real .d.ts emitted by tsc actually has.
        let classStack = [];
        let braceDepth = 0;
        for (const line of lines) {
          const classMatch = classOpenRe.exec(line);
          if (classMatch && /\bclass\b/.test(line)) {
            classStack.push({ name: classMatch[1], atDepth: braceDepth });
          }
          for (const ch of line) {
            if (ch === '{') braceDepth += 1;
            else if (ch === '}') {
              braceDepth -= 1;
              classStack = classStack.filter((c) => c.atDepth < braceDepth);
            }
          }
          if (!symbolRe.test(line)) continue;
          if (commentLineRe.test(line)) {
            usageExamples.push({ file: path.relative(pkgDir, full), example: line.trim().replace(/^\*\s?/, '') });
            continue;
          }
          const enclosing = classStack.length ? classStack[classStack.length - 1].name : null;
          // A `static` member is called directly on the class/export itself — no `new`
          // needed. Missing this distinction was a real accuracy bug caught live: this
          // exact package's ContentstackLivePreview.unsubscribeOnEntryChange (the
          // writer's actual call, and the default export's own name) IS a static method,
          // genuinely callable as written — flagging it "requires instantiation" would
          // have been WRONG guidance from the tool meant to prevent wrong guidance.
          const isStatic = /^\s*static\b/.test(line);
          declarations.push({
            file: path.relative(pkgDir, full),
            className: enclosing,
            requiresInstantiation: enclosing !== null && !isStatic,
            isStatic,
            declaration: line.trim(),
          });
        }
      }
    }
  };
  walk(pkgDir, 0);
  return { declarations, usageExamples };
}

/** README usage mentions — the package's OWN documented usage, separate from what .d.ts declares. */
function scanReadmeMentions(pkgDir, symbol) {
  const mentions = [];
  const symbolRe = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  let entries;
  try { entries = fs.readdirSync(pkgDir); } catch { return mentions; }
  for (const name of entries) {
    if (!/^readme/i.test(name)) continue;
    let content;
    try { content = fs.readFileSync(path.join(pkgDir, name), 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (symbolRe.test(lines[i])) {
        mentions.push(lines[i].trim());
      }
    }
  }
  return mentions;
}

const resolvePackageSymbolTool = {
  name: 'resolve_package_symbol',
  pluginApiVersion: PLUGIN_API_VERSION,
  description:
    'Given a package name and a symbol (method/function/property), reports the symbol\'s REAL declared shape from the package\'s actually-installed .d.ts files — including whether it is an instance method requiring instantiation (e.g. `new SomeClass()`) or a direct export — and separately reports whether the package\'s own README documents real usage of that symbol. Use this BEFORE calling a third-party SDK method you have not seen used in this codebase: a symbol that technically exists in a .d.ts file is not the same as the package\'s intended, documented usage — an internal class-instance method the README never calls directly is exactly the kind of near-miss that produces code that type-checks and fails at runtime.',
  permission: 'safe',
  definition: {
    name: 'resolve_package_symbol',
    description:
      'Report the real declared shape of a package symbol (class-instance method vs direct export) and any README-documented usage, checked against the actually-installed package.',
    inputSchema: {
      type: 'object',
      properties: {
        packageName: {
          type: 'string',
          description: 'The npm package name, including any scope (e.g. "@scope/package-name")',
        },
        symbol: {
          type: 'string',
          description: 'The method, function, or property name to look up, e.g. "onEntryChange"',
        },
      },
      required: ['packageName', 'symbol'],
    },
  },
  async execute(input) {
    try {
      const packageName = input && input.packageName;
      const symbol = input && input.symbol;
      if (!packageName || typeof packageName !== 'string') {
        return { toolUseId: '', content: 'Error: packageName (string) is required.', isError: true };
      }
      if (!symbol || typeof symbol !== 'string') {
        return { toolUseId: '', content: 'Error: symbol (string) is required.', isError: true };
      }
      const projectRoot = process.cwd();
      const pkgDir = path.join(projectRoot, 'node_modules', ...packageName.split('/'));
      if (!fs.existsSync(path.join(pkgDir, 'package.json'))) {
        return {
          toolUseId: '',
          content: `Package "${packageName}" is not installed at ${pkgDir} (no package.json found).`,
          isError: true,
        };
      }

      const { declarations, usageExamples } = scanDeclarations(pkgDir, symbol);
      const readmeMentions = scanReadmeMentions(pkgDir, symbol);

      const result = {
        packageName,
        symbol,
        found: declarations.length > 0,
        declarations,
        readmeMentions,
        docUsageExamples: usageExamples,
      };
      if (declarations.length === 0) {
        result.note = readmeMentions.length > 0
          ? 'Not found in any .d.ts declaration, but the README mentions this symbol — check the README example directly rather than assuming a type signature.'
          : 'Not found anywhere in this package\'s .d.ts files or README. Do not use this symbol — it does not exist in the installed version.';
      } else if (declarations.some((d) => d.requiresInstantiation) && readmeMentions.length === 0) {
        result.note = 'This symbol only appears as a class-instance method, and the README does not document calling it directly — this may be an internal implementation detail rather than the intended public API. Prefer a documented pattern if one exists for what you are trying to do.';
      }

      return { toolUseId: '', content: JSON.stringify(result, null, 2), isError: false };
    } catch (err) {
      return { toolUseId: '', content: `Error resolving package symbol: ${err.message}`, isError: true };
    }
  },
};

module.exports = {
  tools: [resolveTestFileTool, codelineFactsTool, gitStateTool, checkAntiPatternsTool, resolvePackageSymbolTool],
};
