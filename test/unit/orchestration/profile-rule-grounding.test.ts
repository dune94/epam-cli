/**
 * A profile rule that asserts something false about the codebase must not be
 * written into persistent agent behaviour.
 *
 * Live metrolinx 2026-07-26, run 2. mutant-hunter scored 0 (because of a
 * manifest bug — it had been shown no tests), the gate-remediation pipeline
 * treated that as a real finding, and profile-augmentor appended a rule to
 * typescript-engineer containing:
 *
 *     test_file="${file%.ts}.test.ts"; [ -f "$test_file" ] && ...
 *
 * Every test in that repository is named `.spec.ts`. The rule hardcodes the
 * exact naming assumption that had blinded mutant-hunter in the first place, so
 * the remediation encoded the defect as guidance. It was reviewed — the run
 * logged "(reviewer approved)".
 *
 * The reviewer could not have caught it. It is handed the last 500 characters
 * of profiles.json before and after, with no tools and no access to the repo
 * under work, and asked for a verdict. `.test.ts` is entirely plausible in
 * isolation; it is wrong only against a codebase the reviewer cannot see.
 *
 * That is the same shape as the detective's ungrounded diagnosis, and it takes
 * the same answer: check the claim against the code rather than asking a model
 * to judge plausibility harder. A file-convention claim is verifiable — either
 * files matching it exist, or they do not.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const HELPER = join(__dirname, '../../../orchestrations/scripts/lib/profile_rule_grounding.py');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepo(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'profile-grounding-'));
  cleanupDirs.push(root);
  for (const rel of files) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '// x\n');
  }
  return root;
}

/** Exit 0 = grounded (allow), 1 = unfounded claim (reject). */
function check(before: string, after: string, repo: string) {
  const dir = mkdtempSync(join(tmpdir(), 'profile-check-'));
  cleanupDirs.push(dir);
  const b = join(dir, 'before.json');
  const a = join(dir, 'after.json');
  writeFileSync(b, JSON.stringify({ 'typescript-engineer': before }));
  writeFileSync(a, JSON.stringify({ 'typescript-engineer': after }));
  const r = spawnSync('python3', [HELPER, b, a, repo], { encoding: 'utf8', timeout: 20000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const BASE = 'You are a TypeScript engineer. Write minimal fixes.';

describe('a rule must not assert a file convention the repo does not use', () => {
  it('rejects the live rule — .test.ts on a .spec.ts codebase', () => {
    const repo = makeRepo([
      'src/services/apply-report-discounts.service.ts',
      'src/services/apply-report-discounts.service.spec.ts',
    ]);
    const rule = BASE + '\n\nGrep to verify coverage: test_file="${file%.ts}.test.ts"; [ -f "$test_file" ] || echo MISSING';
    const { status, out } = check(BASE, rule, repo);

    expect(status,
      'the rule hardcodes .test.ts on a repo where every test is .spec.ts — this is ' +
      'the defect being encoded as permanent guidance')
      .toBe(1);
    expect(out).toMatch(/\.test\.ts/);
  });

  it('allows the same rule when the repo really does use .test.ts', () => {
    const repo = makeRepo(['src/a.ts', 'src/a.test.ts']);
    const rule = BASE + '\n\nCheck test_file="${file%.ts}.test.ts" exists.';
    expect(check(BASE, rule, repo).status,
      'a correct convention claim was rejected — the guard would block real guidance')
      .toBe(0);
  });

  it('allows a rule that makes no file-convention claim at all', () => {
    const repo = makeRepo(['src/a.ts', 'src/a.spec.ts']);
    const rule = BASE + '\n\nPrefer reusing an existing helper over writing new logic.';
    expect(check(BASE, rule, repo).status).toBe(0);
  });

  it('only judges what the change ADDED, not pre-existing profile text', () => {
    // The profile may already carry historical wording; remediation must be
    // judged on its own contribution.
    const repo = makeRepo(['src/a.ts', 'src/a.spec.ts']);
    const before = BASE + '\n\nLegacy note mentioning .test.ts from an older project.';
    const after = before + '\n\nPrefer minimal diffs.';
    expect(check(before, after, repo).status,
      'pre-existing text was re-judged, so unrelated remediations get blocked forever')
      .toBe(0);
  });

  it('checks every claim, not just the first', () => {
    const repo = makeRepo(['src/a.ts', 'src/a.spec.ts']);
    const rule = BASE + '\n\nLook at *.spec.ts and also __tests__/*.test.tsx files.';
    expect(check(BASE, rule, repo).status,
      'a later unfounded claim slipped through because an earlier one was valid')
      .toBe(1);
  });

  it('skips the check when the repo has no source to verify against', () => {
    // Greenfield: nothing to contradict, so a convention claim is not yet false.
    const repo = makeRepo([]);
    const rule = BASE + '\n\nUse ${file%.ts}.test.ts for tests.';
    expect(check(BASE, rule, repo).status,
      'a scaffolded project with no files yet had its guidance rejected')
      .toBe(0);
  });

  it('ignores node_modules when deciding what conventions exist', () => {
    const repo = makeRepo(['src/a.ts', 'src/a.spec.ts', 'node_modules/dep/x.test.ts']);
    const rule = BASE + '\n\nUse ${file%.ts}.test.ts for tests.';
    expect(check(BASE, rule, repo).status,
      'a vendored dependency was taken as evidence of the project convention')
      .toBe(1);
  });

  it('fails open when the repo path is unusable — never blocks on its own error', () => {
    // This guard must not become a new way for remediation to die silently.
    const rule = BASE + '\n\nUse ${file%.ts}.test.ts for tests.';
    expect(check(BASE, rule, '/nonexistent/repo').status).toBe(0);
  });
});

describe('the check runs before the profile is trusted', () => {
  const orchSrc = require('node:fs').readFileSync(
    join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

  it('profile-augmentor consults the grounding check', () => {
    expect(orchSrc, 'nothing verifies a proposed rule against the codebase it describes')
      .toMatch(/profile_rule_grounding/);
  });

  it('the check\'s exit status is not swallowed by a pipe', () => {
    // `if ! python3 ... | tee log; then` evaluates TEE's status, not python's,
    // so the rejection can never fire — the check would log a block while
    // enforcing nothing. That is the same pipe-masking defect that made the
    // repro-gate and review-escalation fail open, and source-shaped assertions
    // about "the check is wired in" pass happily while it is present.
    const i = orchSrc.indexOf('profile_rule_grounding');
    const stanza = orchSrc.slice(i, i + 1200);
    expect(stanza,
      'the grounding check is piped into tee, so its verdict is discarded')
      .not.toMatch(/python3 "\$_pa_ground_lib"[^\n]*\|\s*tee/);
  });

  it('an unfounded rule reverts profiles.json', () => {
    const i = orchSrc.indexOf('profile_rule_grounding');
    expect(i).toBeGreaterThan(-1);
    expect(orchSrc.slice(i, i + 1200),
      'the check runs but its verdict does not revert the write')
      .toMatch(/_profiles_before|REJECT|revert/i);
  });
});
