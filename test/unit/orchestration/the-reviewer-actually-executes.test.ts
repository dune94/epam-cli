/**
 * THE REVIEWER MUST RUN. NOT PARSE — RUN.
 *
 * WRITTEN AFTER THREE DEFECTS THAT EVERY EXISTING CHECK PASSED.
 *
 * On 2026-08-12 the reviewer had been dead for two days and nothing caught it:
 *
 *   line 462   `local` at top level        -> died instantly, no verdict, 701 retry cycles
 *   line 553   raw " in prompt prose       -> string closed; `<the` parsed as a redirection
 *   line 559   raw ` in prompt prose       -> ran `name:` and spliced the result INTO the prompt
 *
 * `bash -n` passes on all three: they are RUNTIME errors, not syntax errors. shellcheck caught
 * only the first. The unit tests around this script pass on all three, because they either grep
 * its source text or call functions defined INSIDE it — and every one of these defects lives in
 * the top-level body, on the path only a real invocation reaches.
 *
 * The third is the reason this test exists at all. It did not stop the script. Bash executed
 * shell that lived inside the PROMPT and substituted the output, so the reviewer was handed a
 * mangled prompt and nobody was told. A test that only asserts "the script exited 0" would have
 * passed while the reviewer read corrupted instructions.
 *
 * SO THIS TEST EXECUTES THE REAL SCRIPT, with the LLM stubbed and a throwaway git repo, and
 * asserts on two things: no error from the script's own body, and the prompt it BUILT contains
 * the literal text the author wrote.
 *
 * It deliberately does NOT stub the prompt construction — that is the code under test.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const REVIEW_SH = join(SCRIPTS, 'team-lead-review.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

interface Run { status: number | null; out: string; prompt: string }

/**
 * Runs the REAL team-lead-review.sh against a throwaway repo with a stubbed ai-run.sh that
 * captures the prompt it is handed and returns a fixed verdict.
 */
function runReviewer(): Run {
  const d = mkdtempSync(join(tmpdir(), 'reviewer-executes-')); dirs.push(d);
  const repo = join(d, 'repo');
  const logDir = join(d, 'logs');
  mkdirSync(repo, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
  git('add', '-A');
  git('commit', '-qm', 'AMSD-1: story complete');

  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    implementationOrder: { core: ['AMSD-1'] },
    stories: [{
      id: 'AMSD-1', title: 'A story', agentRole: 'writer', phase: 'core',
      status: 'completed',
      technicalNotes: { files: ['a.ts'] },
      fixSiteAnalysis: [{ file: 'a.ts', reason: 'r', prescribedMinimalFix: 'f', changeRequired: true }],
      verificationCriteria: [{ id: 'VC1', description: 'a is 2' }],
    }],
  }));

  // A project config dir with the prompts the reviewer refuses to run without. Built by COPYING
  // the canonical templates — not hand-authored fixtures, and not naming any real project, so
  // this test stays true whatever projects exist. The reviewer aborts when either policy renders
  // empty (deliberately: it must never review without them), so without this the harness dies
  // at the gate and proves nothing about the script body.
  const cfgDir = join(d, 'project-config');
  const cfgPrompts = join(cfgDir, 'prompts');
  mkdirSync(cfgPrompts, { recursive: true });
  const templateDir = join(ROOT, 'orchestrations/prompts/templates');
  for (const f of readdirSync(templateDir).filter((n) => n.endsWith('.json'))) {
    writeFileSync(join(cfgPrompts, f), readFileSync(join(templateDir, f), 'utf8'));
  }

  const promptCapture = join(d, 'prompt.txt');
  const runner = join(d, 'ai-run.sh');
  writeFileSync(runner, [
    '#!/usr/bin/env bash',
    // The prompt reaches ai-run.sh on stdin or as an argument depending on the call shape;
    // capture BOTH so this harness cannot silently record nothing.
    `{ printf '%s\\n' "$*"; cat; } > ${JSON.stringify(promptCapture)} 2>/dev/null`,
    `echo '{"verdict":"approved","issues":[],"summary":"stub"}'`,
  ].join('\n'));
  chmodSync(runner, 0o755);

  const r = spawnSync('bash', [REVIEW_SH, 'core'], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      SCRIPT_DIR: SCRIPTS,
      PROJECT_ROOT: repo,
      PRD_FILE: prd,
      LOG_DIR: logDir,
      AGENT_PROFILES_FILE: join(d, 'profiles.json'),
      AI_RUNNER_CMD: runner,
      EPAM_PROJECT_CONFIG_DIR: cfgDir,
      AUTO_APPROVE: 'false',
      REVIEW_LOG: join(logDir, 'code-reviews.jsonl'),
    },
  });
  writeFileSync(join(d, 'profiles.json'), '{}');
  return {
    status: r.status,
    out: (r.stdout || '') + (r.stderr || ''),
    prompt: existsSync(promptCapture) ? readFileSync(promptCapture, 'utf8') : '',
  };
}

const run = runReviewer();

describe('the harness really invoked the reviewer', () => {
  it('the script produced output — otherwise every assertion below is vacuous', () => {
    expect(run.out.length, 'the reviewer produced nothing at all').toBeGreaterThan(0);
  });

  it('it got far enough to build and send a prompt', () => {
    // This is what separates this test from the ones that missed all three defects: it proves
    // execution reached the prompt, rather than proving the prompt exists in the source.
    expect(run.prompt.length, 'no prompt was ever handed to the runner — the script died first')
      .toBeGreaterThan(200);
  });
});

describe('NO RUNTIME ERROR FROM THE SCRIPT BODY', () => {
  it('bash reported no error on any line of it', () => {
    // Catches ALL THREE 2026-08-12 defects:
    //   line 462: local: can only be used in a function
    //   line 553: the: No such file or directory
    //   line 559: name:: command not found
    const errs = run.out.split('\n').filter((l) => /team-lead-review\.sh: line \d+:/.test(l));
    expect(errs, `the reviewer hit runtime errors:\n${errs.join('\n')}`).toEqual([]);
  });

  it('nothing in it was mistaken for a command', () => {
    expect(run.out).not.toMatch(/command not found/);
  });

  it('nothing in it was mistaken for a redirection', () => {
    expect(run.out).not.toMatch(/No such file or directory/);
  });
});

describe('THE PROMPT ARRIVES AS WRITTEN — prose is not executed', () => {
  it('the scan_secrets example survives with its quotes intact', () => {
    // Line 553. A raw " here closes the shell string and the text is lost.
    expect(run.prompt, 'the scan_secrets tool example did not reach the model intact')
      .toMatch(/scan_secrets\(diff=/);
    expect(run.prompt).toMatch(/GIT DIFF above/);
  });

  it('the backticked prose survives instead of being executed', () => {
    // Lines 559-560. Raw backticks ran `name:` and `management_token:` and substituted the
    // empty output, deleting the words from the prompt WITHOUT any error.
    expect(run.prompt, 'the `name: value` example was executed instead of sent')
      .toMatch(/name: value/);
    expect(run.prompt, 'the management_token example was executed instead of sent')
      .toMatch(/management_token/);
  });

  it('the shared policies actually rendered into it', () => {
    // These abort the script when empty, so their presence also proves the prompt library ran.
    expect(run.prompt.toLowerCase()).toMatch(/blocker/);
  });

  it('no shell fragment leaked into the prompt', () => {
    // The opposite failure: a substitution that produced shell text rather than prose.
    expect(run.prompt).not.toMatch(/command not found|No such file/);
  });
});

describe('AND IT REACHES A VERDICT', () => {
  it('a verdict is produced, not silence', () => {
    // The 701-cycle loop was driven by "no verdict". A reviewer that runs must answer.
    expect(run.out).toMatch(/APPROVED|CHANGES|approved|changes_requested/i);
  });
});
