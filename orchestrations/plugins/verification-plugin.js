'use strict';
/**
 * VERIFICATION IS A PROJECT FACT, NOT AN ENGINE FACT.
 *
 * The engine used to invoke a specific compiler from sixteen hardcoded call sites, each assuming
 * TypeScript, `tsconfig.json`, a `src/` directory, `.ts` extensions and a pinned Node path. Any
 * other stack silently "passed" every check, because a missing manifest was read as "nothing to
 * verify" rather than "I do not know how to verify this".
 *
 * That mattered most where the result decided whether the writer's work was kept or destroyed.
 *
 * Here the project declares how it verifies itself and the engine runs that, reading an exit code
 * and the checker's own output. Nothing in this file names a language, a tool, a file extension,
 * a directory layout or a runtime path — detection reads the repo's OWN manifests and uses the
 * repo's OWN scripts.
 */

const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { execSync } = require('node:child_process');

const PLUGIN_API_VERSION = '1.0.0';
const MANIFEST_REL = join('.epam', 'verification.json');

/** Read the project's declared verification, or null when it has not declared one. */
function readManifest(projectRoot) {
  const path = join(projectRoot, MANIFEST_REL);
  if (!existsSync(path)) return { ok: false, reason: 'no verification manifest declared' };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const command = parsed && parsed.typecheck && parsed.typecheck.command;
    if (typeof command !== 'string' || command.trim() === '') {
      return { ok: false, reason: 'verification manifest declares no typecheck command' };
    }
    return { ok: true, command, manifest: parsed };
  } catch (e) {
    return { ok: false, reason: `verification manifest is unreadable: ${e && e.message}` };
  }
}

/**
 * Detect how THIS repo verifies itself, from its own manifests and its own scripts.
 *
 * Deliberately returns null for anything unrecognised rather than guessing: a wrong command that
 * exits 0 is worse than no command at all, because it reads as a pass.
 *
 * The rule for every ecosystem: prefer a script the project already defines. A project that
 * renames its checker, pins a version, or wraps it in a monorepo runner keeps working, because
 * the engine never learns the tool's name.
 */
function detectVerification(projectRoot) {
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { pkg = null; }
    const scripts = (pkg && pkg.scripts) || {};
    // The project's OWN script name, in the order a human would try them.
    const named = ['typecheck', 'type-check', 'tsc', 'check-types', 'lint:types']
      .find((s) => typeof scripts[s] === 'string' && scripts[s].trim() !== '');
    if (named) {
      const runner = existsSync(join(projectRoot, 'pnpm-lock.yaml')) ? 'pnpm'
        : existsSync(join(projectRoot, 'yarn.lock')) ? 'yarn'
          : 'npm run';
      return {
        typecheck: {
          command: `${runner} ${named}`,
          // HOW ITS FAILURES ARE IDENTIFIED, beside how they are produced. Without this the
          // baseline delta cannot subtract and must report everything — correct, but useless.
          // The identity omits the COLUMN deliberately: editing a line above shifts columns, and
          // a baseline keyed on column reports every pre-existing error as new.
          failurePattern: '^([^(]+)\\((\\d+),(\\d+)\\): error ([A-Z0-9]+)',
          failureIdentity: '{1}:{2}:{4}',
          detected: `package.json scripts.${named}`,
        },
      };
    }
  }
  // Other ecosystems declare their own check command the same way; none are guessed at here.
  return null;
}

/**
 * Run the declared verification.
 *
 * ${PROJECT_ROOT} in the command is substituted, so a manifest can be written once and remain
 * valid whether the project is checked out in the main repo or a worktree.
 */
function runVerification(projectRoot, timeoutMs) {
  const m = readManifest(projectRoot);
  if (!m.ok) return { status: 'unknown', reason: m.reason };
  const command = m.command.replace(/\$\{PROJECT_ROOT\}/g, projectRoot);
  try {
    const out = execSync(command, {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs || 600000,
    });
    return { status: 'pass', exitCode: 0, output: out || '' };
  } catch (e) {
    const output = `${(e && e.stdout) || ''}${(e && e.stderr) || ''}`.trim();
    return { status: 'fail', exitCode: (e && e.status) != null ? e.status : 1, output, command };
  }
}

/* ── THE SUITE ────────────────────────────────────────────────────────────────
 *
 * Same contract as typecheck, for the same reason. `run_external_verification` — the check
 * that runs INSIDE the writer's retry loop and decides whether an attempt is kept — hardcoded
 * four ecosystem facts: a manifest filename, a key inside it, a command, and a test-file naming
 * convention. Hardcoding is permitted in plugins; that was not a plugin.
 *
 * Live 2026-08-11 (AMSD-2041/gotransit) the fallback also demanded that the STORY declare a test
 * file of its own. A brownfield story modifying existing code declares source files, so that is
 * zero by definition: the command stayed empty and the function returned 0 — PASS. The writer
 * was told its change passed the tests. Nothing had run, and ten previously-green suites were
 * broken by an import it had just added.
 *
 * repoHasTests is what replaces that guard. The guard itself was right — a scaffold story
 * writing a manifest into a repo with no tests ANYWHERE must not be failed for it — but it
 * asked the wrong question. "This repo has no tests" and "this story declares no test file" are
 * different states, and only the first justifies skipping.
 */

/** The declared suite, or why it cannot be run. */
function readTestManifest(projectRoot) {
  const path = join(projectRoot, MANIFEST_REL);
  if (!existsSync(path)) return { ok: false, reason: 'no verification manifest declared' };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const section = parsed && parsed.test;
    const command = section && section.command;
    if (typeof command !== 'string' || command.trim() === '') {
      return { ok: false, reason: 'verification manifest declares no test command' };
    }
    return { ok: true, command, pattern: section.testFilePattern || null, manifest: parsed };
  } catch (e) {
    return { ok: false, reason: `verification manifest is unreadable: ${e && e.message}` };
  }
}

/** Run the project's declared suite. UNKNOWN when undeclared — never a pass. */
function runTests(projectRoot, timeoutMs) {
  const m = readTestManifest(projectRoot);
  if (!m.ok) return { status: 'unknown', reason: m.reason };
  const command = m.command.replace(/\$\{PROJECT_ROOT\}/g, projectRoot);
  try {
    const out = execSync(command, {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs || 1800000,
    });
    return { status: 'pass', exitCode: 0, output: out || '', command };
  } catch (e) {
    const output = `${(e && e.stdout) || ''}${(e && e.stderr) || ''}`.trim();
    return { status: 'fail', exitCode: (e && e.status) != null ? e.status : 1, output, command };
  }
}

/**
 * Is this path a test file, by the PROJECT's own convention?
 *
 * null — not "false" — when no convention is declared. A repo that cannot answer must not be
 * recorded as having answered "no"; that is the fail-open shape this whole file exists to remove.
 */
function isTestFile(projectRoot, relPath) {
  const m = readTestManifest(projectRoot);
  const pattern = m.ok ? m.pattern : null;
  if (!pattern) return null;
  try { return new RegExp(pattern).test(String(relPath)); } catch { return null; }
}

/**
 * Does this repository contain ANY test file? The scaffold guard's real question.
 *
 * Walks the working tree, skipping the project's declared vendor directories and dot-dirs, and
 * stops at the first hit. null when no convention is declared — see isTestFile.
 */
function repoHasTests(projectRoot) {
  const m = readTestManifest(projectRoot);
  const pattern = m.ok ? m.pattern : null;
  if (!pattern) return null;
  let re;
  try { re = new RegExp(pattern); } catch { return null; }

  const { readdirSync, statSync } = require('node:fs');
  const skip = new Set(['.git']);
  try {
    const dep = JSON.parse(readFileSync(join(projectRoot, '.epam', 'dependency-check.json'), 'utf8'));
    for (const v of (dep.vendorDirs || [])) skip.add(v);
  } catch { /* no declaration — only .git is skipped */ }

  const walk = (dir, depth) => {
    if (depth > 12) return false;
    let entries;
    try { entries = readdirSync(dir); } catch { return false; }
    for (const name of entries) {
      if (skip.has(name) || name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (walk(full, depth + 1)) return true;
      } else if (re.test(full.slice(projectRoot.length + 1))) {
        return true;
      }
    }
    return false;
  };
  return walk(projectRoot, 0);
}

/**
 * Detect how THIS repo runs its suite, from its own scripts. Same rule as detectVerification:
 * prefer a script the project already defines, and return null rather than guess.
 */
function detectTests(projectRoot) {
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { pkg = null; }
    const scripts = (pkg && pkg.scripts) || {};
    const named = ['test', 'tests', 'test:unit', 'jest', 'vitest']
      .find((s) => typeof scripts[s] === 'string' && scripts[s].trim() !== '');
    if (named) {
      const runner = existsSync(join(projectRoot, 'pnpm-lock.yaml')) ? 'pnpm'
        : existsSync(join(projectRoot, 'yarn.lock')) ? 'yarn'
          : 'npm run';
      return {
        test: {
          command: `${runner} ${named}`,
          testFilePattern: '\\.(test|spec)\\.[jt]sx?$',
          // A failing SUITE is the stable identity, not a test name: runners report the suite
          // path consistently and individual case names churn. Subtracting on this is what lets
          // a brownfield run inherit pre-existing failures without inheriting blame.
          failurePattern: '^\\s*FAIL\\s+(\\S+)',
          failureIdentity: '{1}',
          detected: `package.json scripts.${named}`,
        },
      };
    }
  }
  return null;
}


/**
 * Detect how THIS repo lints, from its own scripts. Same rule as detectVerification and
 * detectTests: prefer a script the project already defines, and return null rather than guess.
 *
 * run_repo_lint_verification resolves its linter by probing for eslint. That is right for a repo
 * that lints with eslint and wrong for every other one: on finding none it warns "lint was NOT run;
 * nothing here proves the change is clean" and returns 0 -- a Tier-A gate carrying the delivery
 * contract, passing on a state it describes in its own words as unproven.
 *
 * Nothing here names eslint. A project that lints with biome, oxlint, ruff or a Makefile target
 * says so in its own scripts, and that is what runs.
 */
function detectLint(projectRoot) {
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { pkg = null; }
    const scripts = (pkg && pkg.scripts) || {};
    const named = ['lint', 'lint:js', 'lint:src', 'eslint']
      .find((s) => typeof scripts[s] === 'string' && scripts[s].trim() !== '');
    if (named) {
      const runner = existsSync(join(projectRoot, 'pnpm-lock.yaml')) ? 'pnpm'
        : existsSync(join(projectRoot, 'yarn.lock')) ? 'yarn'
          : 'npm run';
      return {
        lint: {
          command: `${runner} ${named}`,
          // A lint diagnostic names the FILE it is about; rule ids churn between versions and
          // configs, so the file is the stable identity for a baseline subtraction.
          failurePattern: '^\\s*(\\S+\\.[A-Za-z0-9]+)',
          failureIdentity: '{1}',
          detected: `package.json scripts.${named}`,
        },
      };
    }
  }
  return null;
}


/* ── FAILURE IDENTITY ─────────────────────────────────────────────────────────
 *
 * The baseline-delta gate — run the check, and if RED, run it again at the baseline SHA and
 * block only on what is NEW — is the one thing brownfield actually needs. lib/tsc-baseline-gate.sh
 * implemented it correctly and then parsed the output with a literal:
 *
 *     grep -oE '^[^(]+\([0-9]+,[0-9]+\): error [A-Z0-9]+'
 *
 * That is tsc's exact shape. Point it at any other checker and the grep matches nothing, the
 * baseline cache is empty, there is nothing to subtract, and `[ -z "$new_errors" ]` returns 0 —
 * PASS, having verified nothing. The invocation had been migrated to this plugin; the parsing
 * was left behind, which is the same defect one layer over.
 *
 * So the project declares how ITS failures are identified, beside how they are produced:
 *
 *     failurePattern   how to recognise one failure in this checker's output
 *     failureIdentity  which capture groups form a STABLE key for it
 *
 * Two keys, not one, because they answer different questions. The pattern finds a failure; the
 * identity decides what counts as the SAME failure across two runs. A TypeScript project
 * deliberately omits the column from its identity — editing a line above shifts columns, and a
 * baseline keyed on column reports every pre-existing error as new the moment anything moves.
 * That judgement belongs to the project and is only expressible when identity is separate.
 */

/** Failures in `output`, as the identities this project declares. null when it declares none. */
function parseFailures(projectRoot, output, section = 'typecheck', env = process.env) {
  const path0 = join(projectRoot, MANIFEST_REL);
  let cfg = null;
  try { cfg = JSON.parse(readFileSync(path0, 'utf8')); } catch { cfg = null; }
  if (!cfg && env.EPAM_PROJECT_CONFIG_DIR) {
    try { cfg = JSON.parse(readFileSync(join(env.EPAM_PROJECT_CONFIG_DIR, 'verification.json'), 'utf8')); }
    catch { cfg = null; }
  }
  const sec = cfg && cfg[section];
  const pattern = sec && typeof sec.failurePattern === 'string' ? sec.failurePattern : '';
  // UNKNOWN, NOT EMPTY. "[]" means checked and clean; null means we cannot tell. Collapsing them
  // is exactly how the old grep reported PASS for every project it could not parse.
  if (!pattern) return null;

  let re;
  try { re = new RegExp(pattern, 'gm'); } catch { return null; }
  const identity = typeof sec.failureIdentity === 'string' && sec.failureIdentity.trim()
    ? sec.failureIdentity
    : '{0}';

  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(String(output || ''))) !== null) {
    if (m[0] === '') { re.lastIndex += 1; continue; }
    const key = identity.replace(/\{(\d+)\}/g, (_w, g) => String(m[Number(g)] ?? '').trim());
    if (key && !seen.has(key)) { seen.add(key); out.push(key); }
  }
  return out;
}

/**
 * Failures present now and absent at the baseline.
 *
 * SET DIFFERENCE ON IDENTITY, never a count comparison: "745 passed -> 735 passed" says nothing
 * about WHICH, and a count diff reports "10 before, 10 after, fine" while the failing set has
 * changed completely.
 *
 * null propagates. If either side could not be parsed, the answer is unknown and the caller must
 * not treat it as "nothing new".
 */
function newFailures(current, baseline) {
  if (!Array.isArray(current) || !Array.isArray(baseline)) return null;
  const before = new Set(baseline);
  return current.filter((f) => !before.has(f));
}

// THE LOADER READS name/execute FROM THE TOOL, NOT FROM ITS DEFINITION.
// src/tools/PluginLoader.ts:79-80 requires both on the tool object. Every other plugin hoists
// them (see scan_secrets); this one nested them inside `definition`, so the loader rejected it
// with "plugin missing required field: name" — a WARNING, not an error, so nothing surfaced it and
// the verification tools silently never reached any agent. 15 such warnings across the runs of
// 2026-08-19/20. Hoisted here to match the shape the loader and every sibling plugin use.
const verifyTypecheckTool = {
  name: 'verify_typecheck',
  pluginApiVersion: PLUGIN_API_VERSION,
  definition: {
    name: 'verify_typecheck',
    pluginApiVersion: PLUGIN_API_VERSION,
    description:
      "Run the project's own declared type/compile check and report whether it passes. The " +
      'command comes from the project (.epam/verification.json), never from this tool, so it ' +
      'works for any stack. Returns the checker\'s own output on failure so the errors can be ' +
      'acted on. A project that has declared no verification reports UNKNOWN — never a pass.',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: {
          type: 'string',
          description: 'Absolute path to the repository to verify. Defaults to PROJECT_ROOT.',
        },
      },
      required: [],
    },
  },
  async execute(input) {
    const projectRoot = (input && input.projectRoot) || process.env.PROJECT_ROOT || process.cwd();
    const r = runVerification(projectRoot, Number(process.env.EPAM_VERIFY_TIMEOUT_MS) || 0);

    if (r.status === 'unknown') {
      // FAIL CLOSED. "This project has not declared how it verifies itself" and "this project
      // verifies clean" are different findings, and collapsing them is what let every non-TS
      // stack pass silently — and made the keep/discard decision unconditional.
      return {
        isError: true,
        content:
          `verification not declared for ${projectRoot}: ${r.reason}. ` +
          `Declare it in ${MANIFEST_REL} as {"typecheck":{"command":"..."}} — ` +
          'an undeclared stack is reported as unknown, never as passing.',
      };
    }
    if (r.status === 'fail') {
      return {
        isError: true,
        content: `verification FAILED (exit ${r.exitCode}) for \`${r.command}\`:\n${r.output || '(no output)'}`,
      };
    }
    return { isError: false, content: `verification passed (exit 0)${r.output ? `\n${r.output}` : ''}` };
  },
};

module.exports = {
  pluginApiVersion: PLUGIN_API_VERSION,
  tools: [verifyTypecheckTool],
  detectVerification,
  readManifest,
  runVerification,
  detectTests,
  detectLint,
  readTestManifest,
  runTests,
  parseFailures,
  newFailures,
  isTestFile,
  repoHasTests,
  MANIFEST_REL,
};
