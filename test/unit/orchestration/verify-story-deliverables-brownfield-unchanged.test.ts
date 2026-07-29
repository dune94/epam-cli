/**
 * verify_story_deliverables() — brownfield "exists but unchanged" gap.
 *
 * Live bug (2026-07-22): the check only verified a declared file exists and
 * is non-empty (`[ ! -s "$check_path" ]`). For a NEW file the agent was
 * supposed to create, that's a real signal. For a brownfield bugfix, the
 * declared files are pre-existing application code — the check is
 * trivially true whether or not the agent touched them. Three separate live
 * story attempts ran out of turn budget mid-exploration, never called
 * WriteFile/Edit on the real target files, and this check still passed
 * every time — the pipeline marked the story "completed" and committed
 * whatever incidental pipeline noise (CodeGraph index, .epam manifests)
 * happened to be dirty instead, since those were the only things that
 * actually changed.
 *
 * Fix: for brownfield, a declared file that already existed at the story's
 * baseline (origin/<baseline branch>) must show a real `git diff` against
 * that baseline — mere existence no longer satisfies the check for files
 * that predate the story.
 *
 * Real git repos throughout (bare "origin" + working clone), no mocking.
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

/** A bare "origin" + a working clone, with one pre-existing tracked file. */
function makeBrownfieldFixture(): { clone: string } {
  const root = mkdtempSync(join(tmpdir(), 'verify-deliverables-bf-'));
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

function run(opts: {
  projectRoot: string;
  declaredFiles: string[]; // relative to projectRoot
  brownfield?: boolean;
  baselineBranch?: string;
}): { rc: number; output: string } {
  const { projectRoot } = opts;
  const prdPath = join(projectRoot, '..', 'prd.json');
  writeFileSync(
    prdPath,
    JSON.stringify({
      stories: [{ id: 'SKY-TEST', technicalNotes: { files: opts.declaredFiles } }],
    }),
  );
  const fnBody = [
    // verify_story_deliverables now delegates path resolution to this helper
    // (a declared deliverable may be an extensionless module specifier), so
    // extracting the function alone would leave it undefined and every
    // deliverable would read as missing.
    extractFunctionBody('_resolve_deliverable_path'),
    extractFunctionBody('verify_story_deliverables'),
  ].join('\n');
  const scriptPath = join(projectRoot, '..', 'run.sh');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      `PROJECT_ROOT=${JSON.stringify(projectRoot)}`,
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
      `EPAM_BROWNFIELD=${opts.brownfield === false ? '0' : '1'}`,
      `JIRA_BASELINE_BRANCH=${JSON.stringify(opts.baselineBranch ?? 'develop')}`,
      'error() { echo "ERROR: $*" >&2; }',
      'success() { echo "SUCCESS: $*" >&2; }',
      'warning() { echo "WARNING: $*" >&2; }',
      '_get_vendor_dirs() { :; }',
      // Collaborator, unit-tested separately in
      // prescribed-helper-must-be-used.test.ts. Stubbed so this file keeps
      // testing verify_story_deliverables in isolation.
      'verify_prescribed_helper_used() { return 0; }',
      'record_story_outputs() { return 0; }',
      fnBody,
      'verify_story_deliverables "SKY-TEST"',
      'echo "RC=$?"',
    ].join('\n'),
  );
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  return { rc: (result.stdout.match(/RC=(\d+)/) || [])[1] ? parseInt(RegExp.$1, 10) : -1, output: (result.stdout || '') + (result.stderr || '') };
}

describe('verify_story_deliverables — brownfield: pre-existing file must show a real diff, not just exist', () => {
  it('reproduces the exact live bug: a pre-existing brownfield file left byte-identical to baseline FAILS verification', () => {
    const { clone } = makeBrownfieldFixture();
    // Agent's turn ran dry — never touched src/existing.ts at all.
    const { rc, output } = run({ projectRoot: clone, declaredFiles: ['src/existing.ts'] });
    expect(rc).not.toBe(0);
    expect(output).toMatch(/all 1 declared deliverable\(s\) exist but are UNCHANGED/);
  });

  it('passes verification when the pre-existing file was genuinely modified', () => {
    const { clone } = makeBrownfieldFixture();
    writeFileSync(join(clone, 'src/existing.ts'), 'export const original = 1;\nexport const fixed = true;\n');
    const { rc, output } = run({ projectRoot: clone, declaredFiles: ['src/existing.ts'] });
    expect(rc, output).toBe(0);
    expect(output).toMatch(/Verified 1 declared deliverable/);
  });

  it('passes verification for a genuinely NEW file that did not exist at baseline (no diff check applies, existence suffices)', () => {
    const { clone } = makeBrownfieldFixture();
    mkdirSync(join(clone, 'src/new'), { recursive: true });
    writeFileSync(join(clone, 'src/new/created.ts'), 'export const brandNew = true;\n');
    const { rc, output } = run({ projectRoot: clone, declaredFiles: ['src/new/created.ts'] });
    expect(rc, output).toBe(0);
  });

  it('is unaffected when EPAM_BROWNFIELD is not set (greenfield) — existence alone still suffices, even unchanged', () => {
    const { clone } = makeBrownfieldFixture();
    // File exists (from the seed commit) and is unmodified — greenfield mode
    // never applies the diff check, so this must still pass.
    const { rc, output } = run({ projectRoot: clone, declaredFiles: ['src/existing.ts'], brownfield: false });
    expect(rc, output).toBe(0);
  });

  it('is a safe fallback (existence-only) when the project has no git repo at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-deliverables-nogit-'));
    cleanupDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/f.ts'), 'content\n');
    const { rc, output } = run({ projectRoot: dir, declaredFiles: ['src/f.ts'] });
    expect(rc, output).toBe(0);
  });

  it('is a safe fallback (existence-only) when the baseline branch ref cannot be resolved (e.g. no network/no origin)', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-deliverables-noorigin-'));
    cleanupDirs.push(root);
    execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/f.ts'), 'content\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: root });
    // No 'origin' remote configured at all.
    const { rc, output } = run({ projectRoot: root, declaredFiles: ['src/f.ts'] });
    expect(rc, output).toBe(0);
  });

  it('multiple declared files, ALL unchanged: fails overall — no real work happened anywhere in the declared set', () => {
    const { clone } = makeBrownfieldFixture();
    writeFileSync(join(clone, 'src/other.ts'), 'export const other = true;\n');
    execFileSync('git', ['add', '-A'], { cwd: clone });
    execFileSync('git', ['commit', '-m', 'seed second file', '--quiet'], { cwd: clone });
    execFileSync('git', ['push', 'origin', 'develop', '--quiet'], { cwd: clone });
    // Neither declared file was ever touched by the "agent".
    const { rc, output } = run({ projectRoot: clone, declaredFiles: ['src/existing.ts', 'src/other.ts'] });
    expect(rc).not.toBe(0);
    expect(output).toMatch(/all 2 declared deliverable\(s\) exist but are UNCHANGED/);
  });

  it('run 10x in a row with an unchanged pre-existing file — deterministically fails every time, never a false pass', () => {
    const RUNS = 10;
    const outcomes: { rc: number }[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { clone } = makeBrownfieldFixture();
      const { rc } = run({ projectRoot: clone, declaredFiles: ['src/existing.ts'] });
      outcomes.push({ rc });
    }
    const falsePasses = outcomes.filter(o => o.rc === 0);
    expect(falsePasses, `${falsePasses.length}/${RUNS} incorrectly passed`).toHaveLength(0);
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────
// Exhaustive matrix: N declared files x how many are actually changed.
//
// Live bug (2026-07-23, AMSD-1820): technicalNotes.files populated from
// spec-mode-runner.js's locationHint is a set of CANDIDATE fix sites (the
// model's best guesses), not a mandatory edit list — a real fix routinely
// only needs a subset of them. The pre-fix behavior demanded EVERY declared
// file show a real diff, so openspec correctly naming 3 candidates and the
// agent correctly editing 2 of them still failed the whole story over the
// one untouched candidate. This describe block is the exhaustive test that
// should have existed BEFORE that live run — a source-text or single-case
// test cannot catch a boundary condition like "how many of N must change";
// only a real matrix across N and change-count does.
// ─────────────────────────────────────────────────────────────────────────
describe('verify_story_deliverables — N declared files, partial-change matrix (real fix for the AMSD-1820 class of bug)', () => {
  function makeFixtureWithFiles(fileNames: string[]): { clone: string } {
    const { clone } = makeBrownfieldFixture();
    for (const name of fileNames) {
      writeFileSync(join(clone, name), `export const seed_${name.replace(/\W/g, '_')} = 1;\n`);
    }
    if (fileNames.length) {
      execFileSync('git', ['add', '-A'], { cwd: clone });
      execFileSync('git', ['commit', '-m', 'seed additional files', '--quiet'], { cwd: clone });
      // Must reach origin/develop — the diff check compares against the
      // PUSHED baseline, not local history. A file only committed locally
      // (never pushed) doesn't exist at "origin/develop:<path>", so
      // cat-file -e fails and the code treats it as a brand-new file
      // (trivially passes on existence alone) instead of a genuine
      // pre-existing candidate that needs a real diff — exactly the gap
      // that made the first version of this fixture silently test nothing.
      execFileSync('git', ['push', 'origin', 'develop', '--quiet'], { cwd: clone });
    }
    return { clone };
  }

  function changeFile(clone: string, name: string): void {
    writeFileSync(join(clone, name), `export const changed_${name.replace(/\W/g, '_')} = true;\n`);
  }

  it('2 declared, 1 changed + 1 unchanged: PASSES (real work landed, unchanged one was just an unneeded candidate)', () => {
    const { clone } = makeFixtureWithFiles(['src/candidate-b.ts']);
    changeFile(clone, 'src/existing.ts'); // real edit
    // src/candidate-b.ts declared but genuinely not needed — left as-is.
    const { rc, output } = run({ projectRoot: clone, declaredFiles: ['src/existing.ts', 'src/candidate-b.ts'] });
    expect(rc, output).toBe(0);
    expect(output).toMatch(/1\/2 declared candidate file\(s\) were unchanged/);
  });

  it('3 declared, 2 changed + 1 unchanged: PASSES — exact AMSD-1820 shape (openspec named 3, agent correctly edited 2)', () => {
    const { clone } = makeFixtureWithFiles(['src/candidate-b.ts', 'src/candidate-c.ts']);
    changeFile(clone, 'src/existing.ts');
    changeFile(clone, 'src/candidate-b.ts');
    // src/candidate-c.ts declared but not touched.
    const { rc, output } = run({
      projectRoot: clone,
      declaredFiles: ['src/existing.ts', 'src/candidate-b.ts', 'src/candidate-c.ts'],
    });
    expect(rc, output).toBe(0);
    expect(output).toMatch(/1\/3 declared candidate file\(s\) were unchanged/);
  });

  it('3 declared, only 1 changed + 2 unchanged: still PASSES — one real change is sufficient, not a majority requirement', () => {
    const { clone } = makeFixtureWithFiles(['src/candidate-b.ts', 'src/candidate-c.ts']);
    changeFile(clone, 'src/existing.ts');
    const { rc, output } = run({
      projectRoot: clone,
      declaredFiles: ['src/existing.ts', 'src/candidate-b.ts', 'src/candidate-c.ts'],
    });
    expect(rc, output).toBe(0);
    expect(output).toMatch(/2\/3 declared candidate file\(s\) were unchanged/);
  });

  it('2 declared, 0 changed (both unchanged): FAILS — this is the genuine "nothing happened" case', () => {
    const { clone } = makeFixtureWithFiles(['src/candidate-b.ts']);
    const { rc, output } = run({ projectRoot: clone, declaredFiles: ['src/existing.ts', 'src/candidate-b.ts'] });
    expect(rc).not.toBe(0);
    expect(output).toMatch(/all 2 declared deliverable\(s\) exist but are UNCHANGED/);
  });

  it('4 declared, all 4 changed: PASSES cleanly with no "unchanged" warning at all', () => {
    const { clone } = makeFixtureWithFiles(['src/b.ts', 'src/c.ts', 'src/d.ts']);
    changeFile(clone, 'src/existing.ts');
    changeFile(clone, 'src/b.ts');
    changeFile(clone, 'src/c.ts');
    changeFile(clone, 'src/d.ts');
    const { rc, output } = run({ projectRoot: clone, declaredFiles: ['src/existing.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] });
    expect(rc, output).toBe(0);
    expect(output).not.toMatch(/were unchanged/);
    expect(output).toMatch(/Verified 4 declared deliverable/);
  });

  it('mixed: one declared file TRULY MISSING (never created) + one changed real file — FAILS via the hard missing[] path regardless of the other real change', () => {
    const { clone } = makeBrownfieldFixture();
    changeFile(clone, 'src/existing.ts'); // real change to the pre-existing file
    // src/brand-new.ts was supposed to be CREATED and never was — this stays
    // a hard requirement unaffected by the soft "unchanged" relaxation,
    // since a missing NEW file is unambiguous (not a candidate-vs-required
    // question at all).
    const { rc, output } = run({ projectRoot: clone, declaredFiles: ['src/existing.ts', 'src/brand-new.ts'] });
    expect(rc).not.toBe(0);
    expect(output).toMatch(/missing 1 declared deliverable/);
    expect(output).toMatch(/src\/brand-new\.ts/);
  });

  it('mixed: one truly missing + one unchanged (zero real work, zero real creation) — FAILS via missing[], not the softer unchanged path', () => {
    const { clone } = makeFixtureWithFiles(['src/candidate-b.ts']);
    // Neither src/existing.ts (unchanged) nor src/brand-new.ts (never created) has real work.
    const { rc, output } = run({
      projectRoot: clone,
      declaredFiles: ['src/existing.ts', 'src/candidate-b.ts', 'src/brand-new.ts'],
    });
    expect(rc).not.toBe(0);
    expect(output).toMatch(/missing 1 declared deliverable/);
  });

  it('run 10x in a row for the 3-declared/2-changed shape — deterministically passes every time, never a false fail', () => {
    const RUNS = 10;
    const outcomes: { rc: number }[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { clone } = makeFixtureWithFiles(['src/candidate-b.ts', 'src/candidate-c.ts']);
      changeFile(clone, 'src/existing.ts');
      changeFile(clone, 'src/candidate-b.ts');
      const { rc } = run({
        projectRoot: clone,
        declaredFiles: ['src/existing.ts', 'src/candidate-b.ts', 'src/candidate-c.ts'],
      });
      outcomes.push({ rc });
    }
    const falseFails = outcomes.filter(o => o.rc !== 0);
    expect(falseFails, `${falseFails.length}/${RUNS} incorrectly failed`).toHaveLength(0);
  }, 30000);
});

describe('verify_story_deliverables — brownfield: ZERO declared files must still require a real whole-tree change', () => {
  // Live bug (2026-07-22, run14): technicalNotes.files was empty entirely
  // (locationHint propagation into it is itself non-deterministic — the
  // same spec-pass prompt returned it populated on one attempt, empty on
  // the next). With zero declared files, the per-file loop above has
  // nothing to check and trivially passes — even though the agent's turn
  // produced no real change at all, and the only thing that had actually
  // changed was CodeGraph's own incidental index write.
  it('reproduces the exact live bug: zero declared files + only incidental pipeline noise (.codegraph/, .epam/) changed -> FAILS', () => {
    const { clone } = makeBrownfieldFixture();
    mkdirSync(join(clone, '.codegraph'), { recursive: true });
    writeFileSync(join(clone, '.codegraph/codegraph.db'), 'binary-ish index data\n');
    mkdirSync(join(clone, '.epam'), { recursive: true });
    writeFileSync(join(clone, '.epam/dependency-check.json'), '{}');
    execFileSync('git', ['add', '-A'], { cwd: clone });
    execFileSync('git', ['commit', '-m', 'story: complete SKY-TEST (2 file(s))', '--quiet'], { cwd: clone });

    const { rc, output } = run({ projectRoot: clone, declaredFiles: [] });
    expect(rc).not.toBe(0);
    expect(output).toMatch(/declared NO technicalNotes\.files.*no real change/);
  });

  it('passes when zero files are declared but the tree genuinely shows a real change elsewhere', () => {
    const { clone } = makeBrownfieldFixture();
    writeFileSync(join(clone, 'src/real-fix.ts'), 'export const actuallyFixed = true;\n');
    execFileSync('git', ['add', '-A'], { cwd: clone });
    execFileSync('git', ['commit', '-m', 'real fix', '--quiet'], { cwd: clone });

    const { rc } = run({ projectRoot: clone, declaredFiles: [] });
    expect(rc).toBe(0);
  });

  it('FAILS when zero files are declared and the tree is fully unchanged from baseline (not even noise) — the most extreme case of "no real work done"', () => {
    const { clone } = makeBrownfieldFixture();
    const { rc, output } = run({ projectRoot: clone, declaredFiles: [] });
    expect(rc).not.toBe(0);
    expect(output).toMatch(/declared NO technicalNotes\.files.*no real change/);
  });

  it('is unaffected when EPAM_BROWNFIELD is not set (greenfield) — zero declared files always passes', () => {
    const { clone } = makeBrownfieldFixture();
    mkdirSync(join(clone, '.codegraph'), { recursive: true });
    writeFileSync(join(clone, '.codegraph/codegraph.db'), 'noise\n');
    execFileSync('git', ['add', '-A'], { cwd: clone });
    execFileSync('git', ['commit', '-m', 'noise only', '--quiet'], { cwd: clone });

    const { rc } = run({ projectRoot: clone, declaredFiles: [], brownfield: false });
    expect(rc).toBe(0);
  });

  it('does not apply this whole-tree fallback at all when files ARE declared (even just one) — the per-file check already covers that case', () => {
    const { clone } = makeBrownfieldFixture();
    // Only incidental noise changed, AND one declared file is genuinely unchanged —
    // must fail via the PER-FILE message, not the whole-tree one.
    mkdirSync(join(clone, '.codegraph'), { recursive: true });
    writeFileSync(join(clone, '.codegraph/codegraph.db'), 'noise\n');
    execFileSync('git', ['add', '-A'], { cwd: clone });
    execFileSync('git', ['commit', '-m', 'noise only', '--quiet'], { cwd: clone });

    const { rc, output } = run({ projectRoot: clone, declaredFiles: ['src/existing.ts'] });
    expect(rc).not.toBe(0);
    expect(output).toMatch(/all 1 declared deliverable\(s\) exist but are UNCHANGED/);
    expect(output).toMatch(/existing\.ts/);
    expect(output).not.toMatch(/declared NO technicalNotes\.files/);
  });

  it('run 10x in a row with only incidental noise changed — deterministically fails every time', () => {
    const RUNS = 10;
    const outcomes: { rc: number }[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { clone } = makeBrownfieldFixture();
      mkdirSync(join(clone, '.epam'), { recursive: true });
      writeFileSync(join(clone, '.epam/known-fixes.json'), '{}');
      execFileSync('git', ['add', '-A'], { cwd: clone });
      execFileSync('git', ['commit', '-m', 'noise', '--quiet'], { cwd: clone });
      const { rc } = run({ projectRoot: clone, declaredFiles: [] });
      outcomes.push({ rc });
    }
    const falsePasses = outcomes.filter(o => o.rc === 0);
    expect(falsePasses, `${falsePasses.length}/${RUNS} incorrectly passed`).toHaveLength(0);
  }, 30000);
});
