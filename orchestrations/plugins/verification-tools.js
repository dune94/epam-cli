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
      return { typecheck: { command: `${runner} ${named}`, detected: `package.json scripts.${named}` } };
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

const verifyTypecheckTool = {
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
  MANIFEST_REL,
};
