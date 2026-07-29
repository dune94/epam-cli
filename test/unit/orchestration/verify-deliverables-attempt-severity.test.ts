/**
 * verify_story_deliverables() — a RETRYABLE verdict must not look terminal.
 *
 * Live metrolinx 2026-07-25. MiniMax-M3 returned success on attempt 1 having
 * written nothing at all (out=1156 tokens, 0.28min, zero file writes). The
 * zero-declared-files fallback correctly refused to trust that empty
 * deliverable list and forced a retry; attempt 2 then produced the exact
 * prescribed fix and committed it at 22:49:35. The pipeline worked.
 *
 * What did not work is how it SAID so. The verdict was emitted via error()
 * with terminal-sounding wording ("treating as incomplete"), carrying no
 * attempt number and no indication a retry was coming — while the caller
 * logged the very same event via warning(). One event, two severities, and
 * the louder one is the misleading one.
 *
 * Consequence: a healthy run was read as a failing one and killed by hand
 * mid-QA, discarding a correct, committed fix. That is a real cost, and it is
 * the observability class of defect — the mechanism was right and its report
 * was wrong. Severity is a contract with the reader in exactly the way an
 * exit status is a contract with the caller.
 *
 * So: the per-attempt verdict is a WARNING that names the attempt and says a
 * retry follows. The return code is unchanged — this test pins the reporting,
 * and the blocking behaviour it reports on stays exactly as strict.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(claudeSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Bare "origin" + working clone, one pre-existing tracked file. */
function makeBrownfieldFixture(): { clone: string } {
  const root = mkdtempSync(join(tmpdir(), 'verify-severity-'));
  cleanupDirs.push(root);

  const bareOrigin = join(root, 'origin.git');
  mkdirSync(bareOrigin, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=develop', '--quiet'], { cwd: bareOrigin });

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });
  writeFileSync(join(seed, 'src/existing.ts'), 'export const original = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: seed });
  execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: seed });
  execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: seed });
  execFileSync('git', ['push', 'origin', 'develop', '--quiet'], { cwd: seed });

  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '--quiet', bareOrigin, clone]);
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: clone });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: clone });

  return { clone };
}

/**
 * Runs the real function body with the retry-loop variables the live call site
 * has in scope (`retry_count`, `MAX_RETRIES` — see claude.sh's
 * `while [ $retry_count -le $MAX_RETRIES ]`). Severity is captured by tagging
 * the two stubs distinctly, exactly as the live logger distinguishes them.
 */
function run(opts: {
  projectRoot: string;
  declaredFiles: string[];
  retryCount?: number;
  maxRetries?: number;
}): { rc: number; output: string } {
  const { projectRoot } = opts;
  const prdPath = join(projectRoot, '..', 'prd.json');
  writeFileSync(
    prdPath,
    JSON.stringify({ stories: [{ id: 'SKY-TEST', technicalNotes: { files: opts.declaredFiles } }] }),
  );
  const scriptPath = join(projectRoot, '..', 'run.sh');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      `PROJECT_ROOT=${JSON.stringify(projectRoot)}`,
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
      'EPAM_BROWNFIELD=1',
      'JIRA_BASELINE_BRANCH="develop"',
      ...(opts.retryCount === undefined ? [] : [`retry_count=${opts.retryCount}`]),
      ...(opts.maxRetries === undefined ? [] : [`MAX_RETRIES=${opts.maxRetries}`]),
      'error() { echo "ERROR: $*" >&2; }',
      'success() { echo "SUCCESS: $*" >&2; }',
      'warning() { echo "WARNING: $*" >&2; }',
      '_get_vendor_dirs() { :; }',
      // Collaborator, unit-tested separately in
      // prescribed-helper-must-be-used.test.ts. Stubbed so this file keeps
      // testing verify_story_deliverables in isolation.
      'verify_prescribed_helper_used() { return 0; }',
      'record_story_outputs() { return 0; }',
      [
    // verify_story_deliverables now delegates path resolution to this helper
    // (a declared deliverable may be an extensionless module specifier), so
    // extracting the function alone would leave it undefined and every
    // deliverable would read as missing.
    extractFunctionBody('_resolve_deliverable_path'),
    extractFunctionBody('verify_story_deliverables'),
  ].join('\n'),
      'verify_story_deliverables "SKY-TEST"',
      'echo "RC=$?"',
    ].join('\n'),
  );
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  const m = (result.stdout || '').match(/RC=(\d+)/);
  return { rc: m ? parseInt(m[1], 10) : -1, output: (result.stdout || '') + (result.stderr || '') };
}

/** The line carrying the zero-declared-files verdict, whatever its severity. */
function verdictLine(output: string): string {
  return output.split('\n').find(l => /declared NO technicalNotes\.files/.test(l)) ?? '';
}

describe('the zero-declared-files verdict is reported as retryable, not terminal', () => {
  it('emits at WARNING severity — an ERROR here reads as a dead run and got one killed by hand', () => {
    const { clone } = makeBrownfieldFixture();
    const { output } = run({ projectRoot: clone, declaredFiles: [], retryCount: 0, maxRetries: 7 });
    const line = verdictLine(output);
    expect(line, 'the verdict was not emitted at all').toBeTruthy();
    expect(line,
      'a per-attempt verdict that triggers a retry is still logged as ERROR — ' +
      'indistinguishable from a terminal failure, which is exactly what caused ' +
      'a healthy metrolinx run to be killed mid-QA')
      .toMatch(/^WARNING:/);
  });

  it('names the attempt, so a reader can see it is 1 of 8 rather than the end', () => {
    const { clone } = makeBrownfieldFixture();
    const { output } = run({ projectRoot: clone, declaredFiles: [], retryCount: 0, maxRetries: 7 });
    expect(verdictLine(output),
      'the verdict carries no attempt number — nothing distinguishes the first ' +
      'attempt of eight from the last')
      .toMatch(/attempt 1\/8/);
  });

  it('says a retry follows while the ladder still has attempts left', () => {
    const { clone } = makeBrownfieldFixture();
    const { output } = run({ projectRoot: clone, declaredFiles: [], retryCount: 2, maxRetries: 7 });
    const line = verdictLine(output);
    expect(line).toMatch(/attempt 3\/8/);
    expect(line, 'nothing tells the reader the pipeline is about to retry').toMatch(/will retry/i);
  });

  it('does NOT promise a retry on the final attempt', () => {
    const { clone } = makeBrownfieldFixture();
    const { output } = run({ projectRoot: clone, declaredFiles: [], retryCount: 7, maxRetries: 7 });
    const line = verdictLine(output);
    expect(line).toMatch(/attempt 8\/8/);
    expect(line, 'the last attempt still claims a retry is coming').not.toMatch(/will retry/i);
    expect(line, 'the final attempt should say the ladder is spent').toMatch(/no retries remain/i);
  });

  it('degrades cleanly when the retry variables are not in scope at all', () => {
    const { clone } = makeBrownfieldFixture();
    const { rc, output } = run({ projectRoot: clone, declaredFiles: [] });
    expect(rc, 'the guard stopped blocking without retry context').toBe(1);
    expect(verdictLine(output),
      'an unbounded-context call emitted a nonsense attempt count like "attempt 1/1"')
      .not.toMatch(/attempt\s*\/|attempt 0\//);
  });
});

describe('the DECLARED-files verdict is retryable too', () => {
  // d2a7c1b fixed the zero-declared branch and left its sibling untouched.
  // Live metrolinx 2026-07-26, attempts 3 and 4 of 8:
  //
  //   [ERROR] Story AMSD-1820: all 6 declared deliverable(s) exist but are
  //           UNCHANGED since baseline — no real work done anywhere in the
  //           declared set:
  //
  // Same retryable meaning, same terminal-sounding ERROR, same missing attempt
  // number — the exact reading trap that got a healthy run killed by hand, one
  // branch over. The story went on to succeed on a later attempt, as this
  // verdict always allows.
  const declaredUnchanged = (retryCount?: number, maxRetries?: number) => {
    const { clone } = makeBrownfieldFixture();
    return run({ projectRoot: clone, declaredFiles: ['src/existing.ts'], retryCount, maxRetries });
  };
  const line = (output: string) =>
    output.split('\n').find(l => /declared deliverable\(s\) exist but are UNCHANGED/.test(l)) ?? '';

  it('emits at WARNING severity, like its sibling', () => {
    const { output } = declaredUnchanged(0, 7);
    expect(line(output), 'the verdict was not emitted').toBeTruthy();
    expect(line(output),
      'a per-attempt verdict still logs as ERROR — indistinguishable from a dead run')
      .toMatch(/^WARNING:/);
  });

  it('names the attempt and says a retry follows', () => {
    const { output } = declaredUnchanged(2, 7);
    expect(line(output)).toMatch(/attempt 3\/8/);
    expect(line(output)).toMatch(/will retry/i);
  });

  it('does not promise a retry on the final attempt', () => {
    const { output } = declaredUnchanged(7, 7);
    expect(line(output)).toMatch(/attempt 8\/8/);
    expect(line(output)).not.toMatch(/will retry/i);
    expect(line(output)).toMatch(/no retries remain/i);
  });

  it('still returns 1 — the guard is unchanged', () => {
    const { rc } = declaredUnchanged(0, 7);
    expect(rc, 'softening the severity also softened the guard').toBe(1);
  });
});

describe('reporting changed, blocking did not', () => {
  it('still returns 1 when only incidental pipeline paths changed', () => {
    const { clone } = makeBrownfieldFixture();
    mkdirSync(join(clone, '.codegraph'), { recursive: true });
    writeFileSync(join(clone, '.codegraph/codegraph.db'), 'index\n');
    mkdirSync(join(clone, '.epam'), { recursive: true });
    writeFileSync(join(clone, '.epam/dependency-check.json'), '{}');
    execFileSync('git', ['add', '-A'], { cwd: clone });
    execFileSync('git', ['commit', '-m', 'noise only', '--quiet'], { cwd: clone });

    const { rc, output } = run({ projectRoot: clone, declaredFiles: [], retryCount: 0, maxRetries: 7 });
    expect(rc, 'softening the severity also softened the guard — a no-op agent turn now passes').toBe(1);
    expect(verdictLine(output)).toMatch(/^WARNING:/);
  });

  it('still returns 0 when a real change exists — the metrolinx attempt-2 shape', () => {
    const { clone } = makeBrownfieldFixture();
    writeFileSync(join(clone, 'src/existing.ts'), 'export const original = 1;\nexport const fixed = true;\n');
    const { rc } = run({ projectRoot: clone, declaredFiles: [], retryCount: 1, maxRetries: 7 });
    expect(rc, 'a genuine fix was rejected').toBe(0);
  });
});
