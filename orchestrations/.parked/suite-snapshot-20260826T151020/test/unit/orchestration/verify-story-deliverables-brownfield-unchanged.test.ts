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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
    // AND THE BASELINE RESOLVER. verify_story_deliverables gained a call to
    // _resolved_baseline_ref in 2f2bb37. Undefined here, the `git rev-parse --verify`
    // guard failed, the whole unchanged-detection block was skipped, and every case
    // passed — so this suite reported "10/10 incorrectly passed" while the GATE was
    // correct and the HARNESS was the thing failing open.
    //
    // A test that extracts a function must extract everything that function calls, or it
    // proves the absence of a helper rather than the behaviour of the code.
    extractFunctionBody('_resolved_baseline_ref'),
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

  // NO ORIGIN IS NOT "NO BASELINE".
  //
  // This expected existence-only with no remote configured, assuming that without `origin/`
  // there is nothing to diff against. _resolved_baseline_ref falls back to the LOCAL branch, so
  // a baseline still resolves and an unchanged file is still caught — which is better, and
  // keeping the old expectation would have re-opened the hole this file exists to close.
  it('no origin still has a baseline — the local branch — so an unchanged file is still caught', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-deliverables-noorigin-'));
    cleanupDirs.push(root);
    execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/f.ts'), 'content\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: root });
    // No 'origin' remote — but 'develop' resolves locally, so the diff is still possible.
    const { rc, output } = run({ projectRoot: root, declaredFiles: ['src/f.ts'] });
    expect(rc, output).toBe(1);
  });

  // AN UNRESOLVABLE BASELINE IS NOT A PASS FOR DOING NOTHING.
  //
  // The original case expected existence-only whenever the baseline could not be resolved. A
  // second, stronger rule now outranks it: if NO real change exists anywhere in the tree —
  // ignoring .codegraph/ and .epam/ noise — the story fails with STORY_REJECTION_KEY
  // "no-tree-change", per attempt, and goes back through the retry ladder. That rule caught a
  // live case where a model reported success having written nothing.
  //
  // So the baseline being unresolvable buys a story nothing on its own; it still has to have
  // done work. The fixture below changes NOTHING, so it is failed for that, and asserting a
  // pass here would re-open exactly the hole this file exists to close.
  it('an unresolvable baseline (detached HEAD) still fails when NO work landed anywhere', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-deliverables-detached-'));
    cleanupDirs.push(root);
    execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/f.ts'), 'content\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: root });
    // Detached HEAD: `rev-parse --abbrev-ref HEAD` returns "HEAD", which the resolver treats as
    // no branch — the one state where there is genuinely nothing to diff against.
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '--quiet', sha], { cwd: root });
    const { rc, output } = run({ projectRoot: root, declaredFiles: ['src/f.ts'] });
    expect(rc, output).toBe(1);
    expect(output, 'the refusal must name WHICH rule rejected it, or the next attempt cannot act')
      .toMatch(/no real change|no-tree-change|UNCHANGED/i);
  });

  it('an unresolvable baseline DOES pass once real work exists — the fallback still works', () => {
    // The other half: with the baseline unresolvable, a story that genuinely changed the tree is
    // let through on existence, because there is nothing to diff it against. Without this case
    // the rule above could be satisfied by a guard that simply always refuses.
    const root = mkdtempSync(join(tmpdir(), 'verify-deliverables-detached-work-'));
    cleanupDirs.push(root);
    execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/f.ts'), 'content\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: root });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '--quiet', sha], { cwd: root });
    // real work, uncommitted — the shape an agent leaves behind mid-story
    writeFileSync(join(root, 'src/f.ts'), 'content\nthe agent actually changed this\n');
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
    execFileSync('git', ['commit', '-m', 'SKY-TEST: story complete (2 file(s))', '--quiet'], { cwd: clone });

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

/**
 * A GITIGNORED DECLARED FILE CAN NEVER APPEAR AT BASELINE — so it can never be evidence of work.
 *
 * Live 2026-08-09, twice. The writer explored for 161 tool calls, produced a paragraph of prose
 * about SSG versus client rendering, called WriteFile zero times, changed nothing — and the run
 * reported:
 *
 *     Commit step complete for AMSD-2041
 *     Implemented: 1, Failed: 0, Skipped: 0
 *
 * The gate that exists to catch exactly this — "all declared deliverables exist but are
 * UNCHANGED since baseline, no real work done anywhere" — has a hard `return 1`, and it never
 * fired. It logged "11/12 declared candidate file(s) were unchanged (real work landed in the
 * others)", which was false: nothing landed anywhere.
 *
 * The 12th file was `.env.local`. It is GITIGNORED, so it exists on disk and is absent from
 * origin/develop. The brownfield rule reads that as "a genuinely NEW file, proven by exists +
 * non-empty, no diff required" and counts it as satisfied. One such path in the declared list
 * moves the tally from 12/12-unchanged to 11/12 — one below the threshold — and permanently
 * disables the only check that catches a story doing nothing. For every story, on every run.
 *
 * THE TEST SUITE ABOVE HAS 25 CASES: partial-change matrices, all-unchanged, truly-missing
 * files, zero-declared-files, 10x determinism loops. Not one of them declared a gitignored file.
 * It reads as exhaustive, which is worse than reading as thin — the gap is invisible precisely
 * because the surrounding coverage looks complete.
 */
describe('verify_story_deliverables — a gitignored declared file is not evidence of work', () => {
  /** Adds a gitignored file that exists on disk, exactly like .env.local in the live codeline. */
  function withIgnoredFile(clone: string, name = '.env.local') {
    writeFileSync(join(clone, '.gitignore'), `${name}\n`);
    execFileSync('git', ['add', '.gitignore'], { cwd: clone });
    execFileSync('git', ['commit', '-m', 'ignore', '--quiet'], { cwd: clone });
    writeFileSync(join(clone, name), 'SECRET=1\n');
    return name;
  }

  it('the fixture reproduces the live shape: on disk, absent at baseline, ignored', () => {
    const { clone } = makeBrownfieldFixture();
    const ignored = withIgnoredFile(clone);
    expect(existsSync(join(clone, ignored))).toBe(true);
    const atBaseline = spawnSync('git', ['cat-file', '-e', `origin/develop:${ignored}`], { cwd: clone });
    expect(atBaseline.status, 'the file is present at baseline — fixture is wrong').not.toBe(0);
    const isIgnored = spawnSync('git', ['check-ignore', '-q', ignored], { cwd: clone });
    expect(isIgnored.status, 'the file is not actually gitignored — fixture is wrong').toBe(0);
  });

  it('THE DEFECT: an unchanged pre-existing file plus a gitignored one still FAILS', () => {
    // This is the live tally in miniature: one real declared file that nobody touched, plus
    // .env.local. Before the fix the ignored file counted as work and the story "passed".
    const { clone } = makeBrownfieldFixture();
    const ignored = withIgnoredFile(clone);
    const { rc, output } = run({ projectRoot: clone, declaredFiles: ['src/existing.ts', ignored] });
    expect(
      rc,
      'a story that changed nothing was reported as delivered, because one gitignored path ' +
      'counted as a genuinely new file',
    ).not.toBe(0);
    expect(output).toMatch(/unchanged/i);
  });

  it('a gitignored file alone cannot satisfy the gate', () => {
    const { clone } = makeBrownfieldFixture();
    const ignored = withIgnoredFile(clone);
    expect(run({ projectRoot: clone, declaredFiles: [ignored] }).rc).not.toBe(0);
  });

  it('a REAL new file (not ignored) still passes on existence alone', () => {
    // The rule being narrowed must survive: a genuinely new tracked file has no baseline to
    // diff against and existence is the correct proof.
    const { clone } = makeBrownfieldFixture();
    writeFileSync(join(clone, 'src/brand-new.ts'), 'export const n = 1;\n');
    expect(run({ projectRoot: clone, declaredFiles: ['src/brand-new.ts'] }).rc).toBe(0);
  });

  it('a gitignored file alongside a genuinely CHANGED file still passes', () => {
    // The fix must not fail a story that did real work merely because .env.local was declared.
    const { clone } = makeBrownfieldFixture();
    const ignored = withIgnoredFile(clone);
    writeFileSync(join(clone, 'src/existing.ts'), 'export const original = 2;\n');
    expect(run({ projectRoot: clone, declaredFiles: ['src/existing.ts', ignored] }).rc).toBe(0);
  });

  it('run 10x — deterministically fails, never a false pass', () => {
    for (let i = 0; i < 10; i++) {
      const { clone } = makeBrownfieldFixture();
      const ignored = withIgnoredFile(clone);
      expect(run({ projectRoot: clone, declaredFiles: ['src/existing.ts', ignored] }).rc).not.toBe(0);
    }
  });
});
