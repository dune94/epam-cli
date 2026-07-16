/**
 * Live gap (found 2026-07-12, tier3-travel-app run): SKY-001B's
 * technicalNotes.files declared `node_modules/` as a required deliverable.
 * verify_story_deliverables() correctly checks existence (`-e`, which
 * handles directories fine) — the real problem is TIMING: node_modules
 * doesn't exist yet at the point this check runs; it's created later by
 * run_dependency_check()'s npm install. The check fails once, the story
 * retries, dependency install runs, the check passes on the next attempt --
 * one wasted retry per occurrence, every time a story's spec-pass
 * elaboration declares a vendor/build-output directory as if it were an
 * agent-authored file.
 *
 * Root cause of the DECLARATION itself lives further upstream (the LLM
 * spec-pass elaboration, not a deterministic bug) and isn't reliably
 * fixable here. But this pipeline already has a generic, project-supplied
 * mechanism for "what counts as a vendored/installed directory, never an
 * agent deliverable": .epam/dependency-check.json's "vendorDirs" key (see
 * _get_vendor_dirs(), already used by run_dependency_check/_vendor_lock/
 * run_vendor_integrity_check). No new hardcoded directory list -- reuse
 * that SAME config-driven source. A declared file under a configured
 * vendor dir is never something the agent itself would write, so
 * verify_story_deliverables() should never flag it as a "missing
 * deliverable" regardless of whether it exists yet.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

function run(opts: {
  declaredFiles: string[];
  vendorDirs?: string[];
  createFiles?: string[]; // relative paths to actually create in the project root
}): { rc: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'verify-deliverables-'));
  try {
    const prdPath = join(dir, 'prd.json');
    writeFileSync(
      prdPath,
      JSON.stringify({
        stories: [{ id: 'SKY-TEST', technicalNotes: { files: opts.declaredFiles.map((f) => `${dir}/${f}`) } }],
      }),
    );
    if (opts.vendorDirs) {
      mkdirSync(join(dir, '.epam'), { recursive: true });
      writeFileSync(join(dir, '.epam', 'dependency-check.json'), JSON.stringify({ vendorDirs: opts.vendorDirs }));
    }
    for (const f of opts.createFiles ?? []) {
      const full = join(dir, f);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, 'content');
    }
    const fnBody = extractFunctionBody('verify_story_deliverables');
    const vendorDirsFn = extractFunctionBody('_get_vendor_dirs');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(
      scriptPath,
      [
        '#!/usr/bin/env bash',
        `PROJECT_ROOT=${JSON.stringify(dir)}`,
        `PRD_FILE=${JSON.stringify(prdPath)}`,
        `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
        'error() { echo "ERROR: $*" >&2; }',
        'success() { echo "SUCCESS: $*" >&2; }',
        vendorDirsFn,
        fnBody,
        'verify_story_deliverables "SKY-TEST"',
        'echo "RC=$?"',
      ].join('\n'),
    );
    const stderrPath = join(dir, 'stderr.log');
    const wrapperPath = join(dir, 'run-wrapper.sh');
    writeFileSync(wrapperPath, `bash ${JSON.stringify(scriptPath)} 2> ${JSON.stringify(stderrPath)}`);
    let stdout = '';
    try {
      stdout = execFileSync('bash', [wrapperPath], { encoding: 'utf8' });
    } catch (e: any) {
      stdout = (e.stdout ?? '').toString();
    }
    const combined = stdout + readFileSync(stderrPath, 'utf8');
    const rc = parseInt(combined.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
    return { rc, output: combined };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('verify_story_deliverables — vendor-dir skip (REAL execution)', () => {
  it('REPRODUCES the live gap: a declared vendor dir that does not exist yet is flagged as a missing deliverable when no vendorDirs config exists', () => {
    const { rc, output } = run({ declaredFiles: ['node_modules/'] });
    // Today (bug): no .epam/dependency-check.json means _get_vendor_dirs
    // has nothing to report, so this behaves exactly like the live gap --
    // confirms the reproduction, not the fix.
    expect(rc).toBe(1);
    expect(output).toMatch(/missing 1 declared deliverable/);
  });

  it('a declared vendor dir configured in .epam/dependency-check.json is NEVER flagged as missing, even when it does not exist', () => {
    const { rc, output } = run({
      declaredFiles: ['node_modules/'],
      vendorDirs: ['node_modules'],
    });
    expect(rc).toBe(0);
    expect(output).not.toMatch(/missing/);
  });

  it('is generic: works for an arbitrary configured vendor dir name, not hardcoded to node_modules', () => {
    const { rc } = run({
      declaredFiles: ['vendor/'],
      vendorDirs: ['vendor'],
    });
    expect(rc).toBe(0);
  });

  it('a genuinely missing NON-vendor file is still correctly flagged (no regression)', () => {
    const { rc, output } = run({
      declaredFiles: ['src/index.ts'],
      vendorDirs: ['node_modules'],
    });
    expect(rc).toBe(1);
    expect(output).toMatch(/missing 1 declared deliverable/);
    expect(output).toMatch(/src\/index\.ts/);
  });

  it('a vendor dir that DOES exist still passes (no change to the happy path)', () => {
    const { rc } = run({
      declaredFiles: ['node_modules/'],
      vendorDirs: ['node_modules'],
      createFiles: ['node_modules/.keep'],
    });
    expect(rc).toBe(0);
  });

  it('a file nested INSIDE a configured vendor dir is also skipped, not just the bare directory path', () => {
    const { rc } = run({
      declaredFiles: ['node_modules/some-pkg/index.js'],
      vendorDirs: ['node_modules'],
    });
    expect(rc).toBe(0);
  });
});

describe('verify_story_deliverables — 0-byte file check (REAL execution)', () => {
  // Root cause of SKY-003-impl empty cli.ts (found live 2026-07-15, run #2):
  // The old check used -e (file exists) — a 0-byte file satisfied it. tsc
  // also passes on an empty .ts file. The story was marked completed with no
  // implementation written at all. Fix: -s (exists AND non-empty) so an
  // empty declared deliverable is treated the same as a missing one.
  function runWithEmptyFile(opts: { declaredFiles: string[]; createEmptyFiles?: string[]; createNonEmptyFiles?: string[] }): { rc: number; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'verify-empty-'));
    try {
      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({ stories: [{ id: 'SKY-TEST', technicalNotes: { files: opts.declaredFiles.map((f) => `${dir}/${f}`) } }] }),
      );
      for (const f of opts.createEmptyFiles ?? []) {
        const full = join(dir, f);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, '');
      }
      for (const f of opts.createNonEmptyFiles ?? []) {
        const full = join(dir, f);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, 'content');
      }
      const fnBody = extractFunctionBody('verify_story_deliverables');
      const vendorDirsFn = extractFunctionBody('_get_vendor_dirs');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        ['#!/usr/bin/env bash', `PROJECT_ROOT=${JSON.stringify(dir)}`, `PRD_FILE=${JSON.stringify(prdPath)}`, `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`, 'error() { echo "ERROR: $*" >&2; }', 'success() { echo "SUCCESS: $*" >&2; }', vendorDirsFn, fnBody, 'verify_story_deliverables "SKY-TEST"', 'echo "RC=$?"'].join('\n'),
      );
      const stderrPath = join(dir, 'stderr.log');
      const wrapperPath = join(dir, 'run-wrapper.sh');
      writeFileSync(wrapperPath, `bash ${JSON.stringify(scriptPath)} 2> ${JSON.stringify(stderrPath)}`);
      let stdout = '';
      try { stdout = execFileSync('bash', [wrapperPath], { encoding: 'utf8' }); } catch (e: any) { stdout = (e.stdout ?? '').toString(); }
      const combined = stdout + readFileSync(stderrPath, 'utf8');
      const rc = parseInt(combined.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
      return { rc, output: combined };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the live gap: a 0-byte declared deliverable is flagged as missing', () => {
    const { rc, output } = runWithEmptyFile({ declaredFiles: ['src/cli.ts'], createEmptyFiles: ['src/cli.ts'] });
    expect(rc).toBe(1);
    expect(output).toMatch(/missing 1 declared deliverable/);
  });

  it('a non-empty declared deliverable passes (regression: existing behavior preserved)', () => {
    const { rc } = runWithEmptyFile({ declaredFiles: ['src/cli.ts'], createNonEmptyFiles: ['src/cli.ts'] });
    expect(rc).toBe(0);
  });

  it('a missing declared deliverable still fails (regression: pre-existing behavior preserved)', () => {
    const { rc, output } = runWithEmptyFile({ declaredFiles: ['src/cli.ts'] });
    expect(rc).toBe(1);
    expect(output).toMatch(/missing 1 declared deliverable/);
  });
});
