/**
 * TWO QA GATES JUDGED EVIDENCE THAT COULD NOT CONTAIN THE ANSWER.
 *
 * Live 2026-09-09, run 20260908T215555Z (AMSD-1919, a one-line brownfield defect fixed at
 * CheckoutForm.tsx:306):
 *
 *   qa-gate:runtime-boundary  "The only change is additive test cases in CheckoutForm.spec.tsx;
 *                              CheckoutForm.tsx itself is unmodified (git diff confirms no
 *                              changes)."                                      ← FALSE
 *   qa-gate:mutant-hunter     "truncated to the first 100 of 436 lines and does not include the
 *                              case-sensitivity comparison logic around line 306"   ← TRUE, and
 *                                                                                     disabling
 *
 * Both spent money and neither could reach a verdict about the change.
 *
 * CAUSE 1 — a dangling variable's fallback. The gate built its diff as
 *
 *     git -C "$PROJECT_ROOT" diff "${_rev_base:-HEAD~1}" HEAD
 *
 * and `_rev_base=` appears NOWHERE in the file, so the fallback is not a fallback — it is the
 * only behaviour. HEAD~1..HEAD is the last commit alone, and repro-test-writer always commits
 * AFTER the writer, so on every brownfield defect that window holds the test and never the fix.
 * The phase baseline was on disk the whole time (logs/phase-baseline-sha.txt) and
 * story_outputs_baseline_ref already reads it for two other consumers in the same library.
 *
 * Measured on the real run: from the phase baseline the diff carries CheckoutForm.tsx AND the
 * spec; from HEAD~1 it carries the spec only.
 *
 * CAUSE 2 — a window anchored at the top of the file. The excerpt was `head -n <window>`, so a
 * 436-line component whose fix sits at line 306 can never be in view no matter how the window is
 * tuned. A previous fix added a truncation NOTICE (the agent now knows it is blind, which is why
 * it refused honestly) without making it see. Evidence must be selected AROUND the change.
 *
 * Neither fix hardcodes: the base comes from the phase baseline the run recorded, and the window
 * size stays in config/evidence-windows.json.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/qa-gate-evidence.sh');

/** Runs a snippet with the real library sourced — never a paraphrase of it. */
function bash(script: string, env: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'qge-'));
  const f = join(d, 'run.sh');
  writeFileSync(f, `#!/usr/bin/env bash
set -uo pipefail
source "${join(ROOT, 'orchestrations/scripts/lib/evidence-windows.sh')}" 2>/dev/null || true
source "${join(ROOT, 'orchestrations/scripts/lib/story-outputs.sh')}" 2>/dev/null || true
source "${LIB}"
${script}
`);
  const r = spawnSync('bash', [f], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  rmSync(d, { recursive: true, force: true });
  return { out: r.stdout ?? '', err: r.stderr ?? '', status: r.status };
}

/**
 * The real shape of the live failure: a repo whose story branch carries the FIX first and the
 * REPRO TEST second, exactly as the pipeline commits them.
 */
function repoWithFixThenTest() {
  const d = mkdtempSync(join(tmpdir(), 'qgerepo-'));
  const repo = join(d, 'repo');
  const logs = join(d, 'logs');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(logs, { recursive: true });
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');

  // A file long enough that a top-anchored window cannot reach the change — the live file was 436.
  const before: string[] = [];
  for (let i = 1; i <= 436; i += 1) {
    before.push(i === 306 ? '  if (email && value && value !== email) {' : `  const line${i} = ${i};`);
  }
  writeFileSync(join(repo, 'src/CheckoutForm.tsx'), before.join('\n') + '\n');
  git('add', '-A'); git('commit', '-qm', 'baseline');
  const baseSha = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(logs, 'phase-baseline-sha.txt'), baseSha + '\n');

  // Commit 1: THE FIX.
  const after = [...before];
  after[305] = '  if (email && value && value.toLowerCase() !== email.toLowerCase()) {';
  writeFileSync(join(repo, 'src/CheckoutForm.tsx'), after.join('\n') + '\n');
  git('add', '-A'); git('commit', '-qm', 'AMSD-1919: story complete (1 file(s))');

  // Commit 2: THE REPRO TEST — the last commit, which is all HEAD~1 can see.
  mkdirSync(join(repo, 'src/__tests__'), { recursive: true });
  writeFileSync(join(repo, 'src/__tests__/CheckoutForm.spec.tsx'), 'test("casing", () => {});\n');
  git('add', '-A'); git('commit', '-qm', 'AMSD-1919: add bug-reproducing test');

  return { dir: d, repo, logs, baseSha, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

beforeAll(() => {
  expect(existsSync(LIB), `${LIB} does not exist`).toBe(true);
});

describe('qa_gate_diff — the diff a gate must judge is THIS PHASE, not the last commit', () => {
  it('carries the FIX, which HEAD~1 structurally cannot', () => {
    const r = repoWithFixThenTest();
    try {
      const got = bash(`qa_gate_diff "${r.repo}" "${r.logs}"`);
      expect(got.status, got.err).toBe(0);
      // The exact claim the live gate got wrong.
      expect(got.out, 'the production fix is STILL absent from the gate\'s diff')
        .toContain('CheckoutForm.tsx');
      expect(got.out).toContain('toLowerCase');
      expect(got.out).toContain('CheckoutForm.spec.tsx');
    } finally { r.cleanup(); }
  });

  it('proves the OLD window was blind — HEAD~1 sees only the test', () => {
    // Guards the test itself: if this ever stops holding, the regression above proves nothing.
    const r = repoWithFixThenTest();
    try {
      const old = spawnSync('git', ['-C', r.repo, 'diff', 'HEAD~1', 'HEAD'], { encoding: 'utf8' }).stdout;
      expect(old).toContain('CheckoutForm.spec.tsx');
      expect(old, 'the premise of this fix is wrong — HEAD~1 did see the fix').not.toContain('toLowerCase');
    } finally { r.cleanup(); }
  });

  it('REFUSES rather than silently falling back when no phase baseline was recorded', () => {
    const r = repoWithFixThenTest();
    try {
      rmSync(join(r.logs, 'phase-baseline-sha.txt'));
      const got = bash(`qa_gate_diff "${r.repo}" "${r.logs}"; echo "rc=$?"`);
      expect(got.out).toMatch(/no phase baseline/i);
      expect(got.out, 'a missing baseline must not degrade into a one-commit window')
        .toContain('rc=1');
      expect(got.out).not.toContain('diff --git');
    } finally { r.cleanup(); }
  });

  it('says so rather than emitting an empty diff when the baseline is not a commit here', () => {
    const r = repoWithFixThenTest();
    try {
      writeFileSync(join(r.logs, 'phase-baseline-sha.txt'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
      const got = bash(`qa_gate_diff "${r.repo}" "${r.logs}"; echo "rc=$?"`);
      expect(got.out).toMatch(/not a commit/i);
      expect(got.out).toContain('rc=1');
    } finally { r.cleanup(); }
  });
});

describe('qa_gate_excerpt — evidence is selected AROUND the change, never from the file head', () => {
  it('SHOWS LINE 306 — the line every top-anchored window misses', () => {
    const r = repoWithFixThenTest();
    try {
      const got = bash(
        `qa_gate_excerpt "${r.repo}" "${r.logs}" "src/CheckoutForm.tsx" mutationSourceLines`);
      expect(got.status, got.err).toBe(0);
      expect(got.out, 'the excerpt still cannot see the change it must judge')
        .toContain('value.toLowerCase() !== email.toLowerCase()');
    } finally { r.cleanup(); }
  });

  it('does NOT simply dump the file — the declared window is still respected', () => {
    const r = repoWithFixThenTest();
    try {
      const got = bash(
        `qa_gate_excerpt "${r.repo}" "${r.logs}" "src/CheckoutForm.tsx" mutationSourceLines`);
      const lines = got.out.split('\n').filter(l => l.trim().length > 0);
      // 436-line file, 100-line window: a whole-file dump would defeat the window's purpose.
      expect(lines.length).toBeLessThan(200);
      expect(lines.length).toBeGreaterThan(10);
    } finally { r.cleanup(); }
  });

  it('states WHICH lines are shown, so the agent can say what it could not see', () => {
    const r = repoWithFixThenTest();
    try {
      const got = bash(
        `qa_gate_excerpt "${r.repo}" "${r.logs}" "src/CheckoutForm.tsx" mutationSourceLines`);
      expect(got.out).toMatch(/lines \d+-\d+ of 436/i);
    } finally { r.cleanup(); }
  });

  it('returns a short file WHOLE, with no truncation claim', () => {
    const r = repoWithFixThenTest();
    try {
      const got = bash(
        `qa_gate_excerpt "${r.repo}" "${r.logs}" "src/__tests__/CheckoutForm.spec.tsx" mutationTestLines`);
      expect(got.status, got.err).toBe(0);
      expect(got.out).toContain('test("casing"');
      expect(got.out).not.toMatch(/lines \d+-\d+ of/i);
    } finally { r.cleanup(); }
  });

  it('takes its size from the DECLARED window, never a literal', () => {
    const r = repoWithFixThenTest();
    try {
      const wide = bash(
        `qa_gate_excerpt "${r.repo}" "${r.logs}" "src/CheckoutForm.tsx" mutationSourceLines`,
        { EPAM_EVIDENCE_WINDOWS_FILE: (() => {
            const f = join(r.dir, 'windows.json');
            writeFileSync(f, JSON.stringify({ windows: { mutationSourceLines: { value: 400 } } }));
            return f;
          })() });
      const narrow = bash(
        `qa_gate_excerpt "${r.repo}" "${r.logs}" "src/CheckoutForm.tsx" mutationSourceLines`,
        { EPAM_EVIDENCE_WINDOWS_FILE: (() => {
            const f = join(r.dir, 'windows2.json');
            writeFileSync(f, JSON.stringify({ windows: { mutationSourceLines: { value: 20 } } }));
            return f;
          })() });
      expect(wide.out.split('\n').length,
        'the window declaration does not actually drive the excerpt size')
        .toBeGreaterThan(narrow.out.split('\n').length);
      // Both still show the change: the window moves with it.
      expect(narrow.out).toContain('toLowerCase');
    } finally { r.cleanup(); }
  });
});
