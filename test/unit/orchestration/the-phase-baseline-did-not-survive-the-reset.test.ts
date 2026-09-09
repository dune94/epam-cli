/**
 * THE GATES WERE FIXED AND STILL SAW THE WRONG DIFF, BECAUSE THE BASELINE WAS ALREADY WRONG.
 *
 * Live 2026-09-09, run 20260908T215555Z resumed a second time. qa_gate_diff was in place and
 * runtime-boundary STILL reported "Change is confined to a Jest/RTL spec file". Measured:
 *
 *   recorded phase baseline : f6c789d4   ← the PREVIOUS leg's repro-test commit
 *   branch after the reset  : 9349d864 (fix), af2ef7b3 (test)
 *   baseline-sha.txt written: 02:02:53   (leg start)
 *   fix commit authored     : 02:23:39
 *
 * run-agent-orchestration.sh captures `rev-parse HEAD` before the story loop, and
 * ensure_story_branch then hard-resets the story branch onto origin/<baseline> — orphaning the
 * commit just recorded. Diffing from an orphan is not empty, it is a CROSS-BRANCH comparison:
 * here it showed 8 insertions and 11 deletions in the spec file, the delta between the old repro
 * test and the new one, and nothing of the source fix at all.
 *
 * It is invisible on a first run — HEAD is already the base there — and wrong on every resume.
 * The mutant hunter reads the same baseline, which is why it proposed 0 mutations and then
 * scored 100% against them.
 *
 * Two defects, and the second is the reason the first was not caught: a baseline that cannot be
 * an ancestor of HEAD must be REFUSED, not diffed. "Nothing changed" and "I cannot tell what
 * changed" are opposite findings and this file exists to keep them apart.
 *
 * The baseline is derived, never guessed: the merge-base of HEAD and the branch the story is
 * built on gives the same answer before and after a reset.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/qa-gate-evidence.sh');

function bash(script: string) {
  const d = mkdtempSync(join(tmpdir(), 'pbs-'));
  const f = join(d, 'run.sh');
  writeFileSync(f, `#!/usr/bin/env bash
set -uo pipefail
source "${join(ROOT, 'orchestrations/scripts/lib/evidence-windows.sh')}" 2>/dev/null || true
source "${join(ROOT, 'orchestrations/scripts/lib/story-outputs.sh')}" 2>/dev/null || true
source "${LIB}"
${script}
`);
  const r = spawnSync('bash', [f], { encoding: 'utf8', timeout: 30_000 });
  rmSync(d, { recursive: true, force: true });
  return { out: r.stdout ?? '', err: r.stderr ?? '', status: r.status };
}

/**
 * A repo shaped like the live one: a `develop` base, a story branch carrying a PREVIOUS leg's
 * commits, which the writer is about to hard-reset away.
 */
function repoMidResume() {
  const d = mkdtempSync(join(tmpdir(), 'pbsrepo-'));
  const repo = join(d, 'repo');
  const logs = join(d, 'logs');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(logs, { recursive: true });
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'develop');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'src/CheckoutForm.tsx'), 'const a = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'develop base');
  const developSha = git('rev-parse', 'HEAD').stdout.trim();

  // The PREVIOUS leg's story branch, two commits ahead.
  git('checkout', '-q', '-b', 'bugfix/AI-AMSD-1919');
  writeFileSync(join(repo, 'src/CheckoutForm.tsx'), 'const a = 2;\n');
  git('add', '-A'); git('commit', '-qm', 'prev leg: story complete');
  writeFileSync(join(repo, 'src/old.spec.tsx'), 'test("old", () => {});\n');
  git('add', '-A'); git('commit', '-qm', 'prev leg: add bug-reproducing test');
  const prevTip = git('rev-parse', 'HEAD').stdout.trim();

  return { dir: d, repo, logs, developSha, prevTip, git,
           cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

/** What ensure_story_branch does at Step 8: hard-reset onto the base, then re-do the work. */
function resetAndRedo(r: ReturnType<typeof repoMidResume>) {
  r.git('reset', '-q', '--hard', 'develop');
  r.git('clean', '-qfd');
  writeFileSync(join(r.repo, 'src/CheckoutForm.tsx'), 'const a = 3;\n');
  r.git('add', '-A'); r.git('commit', '-qm', 'AMSD-1919: story complete (1 file(s))');
  writeFileSync(join(r.repo, 'src/new.spec.tsx'), 'test("new", () => {});\n');
  r.git('add', '-A'); r.git('commit', '-qm', 'AMSD-1919: add bug-reproducing test');
}

beforeAll(() => { expect(existsSync(LIB)).toBe(true); });

describe('qa_gate_diff refuses a baseline that cannot describe HEAD', () => {
  it('REFUSES an orphaned baseline instead of emitting a cross-branch diff', () => {
    const r = repoMidResume();
    try {
      writeFileSync(join(r.logs, 'phase-baseline-sha.txt'), r.prevTip + '\n');
      resetAndRedo(r);
      // Prove the premise: that sha is a real commit, and NOT an ancestor of HEAD.
      const isCommit = spawnSync('git', ['-C', r.repo, 'rev-parse', '--verify', '--quiet',
                                         `${r.prevTip}^{commit}`], { encoding: 'utf8' }).status;
      expect(isCommit, 'the orphan is not a commit — the test proves nothing').toBe(0);
      const anc = spawnSync('git', ['-C', r.repo, 'merge-base', '--is-ancestor',
                                    r.prevTip, 'HEAD'], { encoding: 'utf8' }).status;
      expect(anc, 'the orphan IS an ancestor — the premise is wrong').not.toBe(0);

      const got = bash(`qa_gate_diff "${r.repo}" "${r.logs}"; echo "rc=$?"`);
      expect(got.out, 'a baseline that cannot describe HEAD was diffed anyway')
        .toMatch(/not an ancestor|does not describe/i);
      expect(got.out).toContain('rc=1');
      expect(got.out).not.toContain('diff --git');
    } finally { r.cleanup(); }
  });

  it('still works normally when the baseline IS an ancestor', () => {
    const r = repoMidResume();
    try {
      writeFileSync(join(r.logs, 'phase-baseline-sha.txt'), r.developSha + '\n');
      resetAndRedo(r);
      const got = bash(`qa_gate_diff "${r.repo}" "${r.logs}"`);
      expect(got.status, got.err).toBe(0);
      expect(got.out).toContain('CheckoutForm.tsx');
      expect(got.out).toContain('new.spec.tsx');
    } finally { r.cleanup(); }
  });
});

describe('qa_phase_baseline_sha — a baseline that survives the branch reset', () => {
  it('records the DIVERGENCE POINT, not the previous leg\'s tip', () => {
    const r = repoMidResume();
    try {
      const got = bash(`qa_phase_baseline_sha "${r.repo}" develop`);
      expect(got.status, got.err).toBe(0);
      expect(got.out.trim(), 'it recorded the commit the reset is about to orphan')
        .not.toBe(r.prevTip);
      expect(got.out.trim()).toBe(r.developSha);
    } finally { r.cleanup(); }
  });

  it('gives the SAME answer after the reset — that is what makes it stable', () => {
    const r = repoMidResume();
    try {
      const before = bash(`qa_phase_baseline_sha "${r.repo}" develop`).out.trim();
      resetAndRedo(r);
      const after = bash(`qa_phase_baseline_sha "${r.repo}" develop`).out.trim();
      expect(after).toBe(before);
      expect(after).toBe(r.developSha);
    } finally { r.cleanup(); }
  });

  it('and the diff taken from it carries the SOURCE FIX, which is the whole point', () => {
    const r = repoMidResume();
    try {
      const base = bash(`qa_phase_baseline_sha "${r.repo}" develop`).out.trim();
      resetAndRedo(r);
      writeFileSync(join(r.logs, 'phase-baseline-sha.txt'), base + '\n');
      const got = bash(`qa_gate_diff "${r.repo}" "${r.logs}"`);
      expect(got.out).toContain('CheckoutForm.tsx');
      expect(got.out).toContain('const a = 3');
    } finally { r.cleanup(); }
  });

  it('falls back to HEAD when the base branch does not resolve, and never invents one', () => {
    const r = repoMidResume();
    try {
      const got = bash(`qa_phase_baseline_sha "${r.repo}" no-such-branch`);
      expect(got.status).toBe(0);
      expect(got.out.trim()).toBe(r.prevTip); // HEAD — the old behaviour, unchanged
    } finally { r.cleanup(); }
  });
});
