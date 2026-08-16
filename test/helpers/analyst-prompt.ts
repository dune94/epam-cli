/**
 * The failure analyst's prompt text, for tests that assert what the analyst is INSTRUCTED
 * to do.
 *
 * Until 2026-08-11 this lived as a heredoc inside claude.sh, so tests read the shell
 * source to assert prompt content. It now lives in a JSON file, and the engine renders it
 * through lib/prompt-library.js. Tests asserting the analyst's CONTRACT — its output
 * schema, its decision rules, its tool guidance — must read the prompt, not the engine.
 *
 * They read the TEMPLATE, not a project copy: this is the generic contract, identical for
 * every project. only-project-authority-prompts-are-executed.test.ts separately proves the
 * project-authority copy matches the template by hash, so an assertion here holds for what
 * actually runs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATE = join(__dirname, '../../orchestrations/prompts/templates/failure-analyst.json');

/** The rendered-prompt body, with placeholders still in place. */
export function analystPromptBody(): string {
  const doc = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  if (typeof doc.body !== 'string' || doc.body.length < 500) {
    throw new Error('analyst prompt template is missing or implausibly short — tests would pass vacuously');
  }
  return doc.body;
}

/** claude.sh source plus the prompt, for assertions that may target either. */
export function engineAndPrompt(claudeSrc: string): string {
  return `${claudeSrc}\n${analystPromptBody()}`;
}

/**
 * Make a temp dir usable as BOTH $SCRIPT_DIR and $EPAM_PROJECT_CONFIG_DIR for a harness
 * that executes run_failure_analyst for real.
 *
 * The function now resolves its prompt through $SCRIPT_DIR/lib/prompt-library.js and
 * refuses to run without a project-authority prompt — deliberately, since a silent
 * fallback to the generic template is the failure mode the library exists to prevent. A
 * harness must therefore provision both, and it does so by COPYING THE CANONICAL FILES:
 * a hand-authored prompt fixture would let the tests pass against a prompt nobody ships.
 */
export function provisionAnalystPrompt(dir: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { mkdirSync, copyFileSync, writeFileSync, readFileSync: rf } = require('node:fs');

  // THE WHOLE lib DIRECTORY, not prompt-library.js alone.
  //
  // Copying the one file worked only while that file had no siblings to require. When the
  // placeholder rule was unified into engine-prompt.js (2026-08-16), the lone copy could no
  // longer resolve its own require: the render failed, run_failure_analyst was handed an
  // EMPTY prompt, and every assertion about what the analyst was told compared against ''.
  // Nothing in the engine was broken — only this fixture's idea of what a module needs.
  mkdirSync(join(dir, 'lib'), { recursive: true });
  const libSrc = join(__dirname, '../../orchestrations/scripts/lib');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  for (const entry of require('node:fs').readdirSync(libSrc)) {
    if (!entry.endsWith('.js')) continue;
    copyFileSync(join(libSrc, entry), join(dir, 'lib', entry));
  }

  mkdirSync(join(dir, 'prompts'), { recursive: true });
  const tpl = JSON.parse(rf(TEMPLATE, 'utf8'));
  writeFileSync(
    join(dir, 'prompts/failure-analyst.json'),
    JSON.stringify({ ...tpl, authority: 'project', derivedFrom: TEMPLATE }, null, 2),
  );
}

/** The env lines a harness must set so the real function can build its prompt. */
export function analystPromptEnv(dir: string): string {
  const node = process.execPath;
  return [`NODE_BIN="${node}"`, `EPAM_PROJECT_CONFIG_DIR="${dir}"`].join('\n');
}
