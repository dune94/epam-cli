/**
 * Every place that writes profiles.json or a PRD file must use an
 * atomic write-then-rename pattern (write to a temp file in the same
 * directory, then os.replace/fs.renameSync into place) — never a bare
 * `open(path, 'w')` / `fs.writeFileSync(path, ...)` directly on the target.
 *
 * Root cause this fixes (found live, 2026-07-11, tier3-travel-app run,
 * raised directly by the user: "version management is weak... very fragile
 * and brittle and poorly designed"): a direct write truncates the target
 * file BEFORE writing new content. If the process is killed at any point
 * between those two steps — which happens routinely in this pipeline
 * (watchdog force-kills, manual kill-tier3-run.sh, a SIGKILL mid-write) —
 * the file is left empty or half-written, i.e. corrupted invalid JSON. Two
 * confirmed live incidents this exact session: (1) orchestrations/agents/
 * profiles.json silently reverted to stale, pre-fix content after a killed
 * run (2) orchestrations/travel-app-prd.json contained a raw unescaped
 * control character and a "[truncated — showing X of Y]" marker, crashing
 * every test that read it with "Bad control character in string literal"
 * instead of a normal test failure. An atomic write-then-rename makes the
 * target file always either the OLD content or the FULLY-NEW content, never
 * a partial write, regardless of when the process dies.
 *
 * This test enumerates every known JSON-write call site for profiles.json/
 * PRD files across the codebase and asserts each one uses the atomic
 * pattern, plus a real-execution proof that the pattern actually survives an
 * interrupted write.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');

function src(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

describe('atomic JSON writes — profiles.json / PRD write sites (static)', () => {
  it('claude.sh: all 4 PRD-write sites (AC/TC patch application) use os.replace, not a bare open(path, "w")', () => {
    const text = src('orchestrations/scripts/claude.sh');
    const bareWrites = (text.match(/with open\(prd_path, 'w'\) as f:\n\s*json\.dump\(prd, f, indent=2\)\n(?!os\.replace)/g) || []).length;
    expect(bareWrites).toBe(0);
    const atomicWrites = (text.match(/_tmp_prd_path = prd_path \+ '\.tmp'/g) || []).length;
    expect(atomicWrites).toBeGreaterThanOrEqual(4);
  });

  // WRITE REPLACED 2026-08-07 (ARCH-5): the skill note is no longer a read-modify-write of
  // profiles.json (that file is now SET after the mint and wiped by pre-run-reset) — it is an
  // append to the codeline KB. Atomicity is therefore no longer tmp+os.replace but a locked
  // O_APPEND write, which is the correct primitive for an append and is not torn by
  // concurrent lanes. The concern is identical: three lanes write this store in parallel and
  // neither a partial file nor a lost entry is acceptable.
  it('claude.sh: the skill-note persistence append to the codeline KB is lock-guarded', () => {
    const text = src('orchestrations/scripts/claude.sh');
    const idx = text.indexOf('>> "$_skill_kb_file"');
    expect(idx, 'the skill-note persistence write is gone entirely').toBeGreaterThan(-1);
    const block = text.slice(Math.max(0, idx - 400), idx + 100);
    expect(block).toMatch(/flock -w 10 201/);
    expect(block).toMatch(/201>"\$\{_skill_kb_file\}\.lock"|201>/);
  });

  it('claude.sh: no read-modify-write of profiles.json survives anywhere', () => {
    // profiles.json is written once, by the mint. A read-modify-write here would both race
    // the parallel lanes and persist into a file the next run erases.
    const text = src('orchestrations/scripts/claude.sh');
    expect(text).not.toMatch(/profiles\[role\]\s*=\s*existing/);
    expect(text).not.toMatch(/os\.replace\(_tmp_profiles_path, profiles_path\)/);
  });

  it('run-agent-orchestration.sh: PRD model coordinator fallback write uses os.replace', () => {
    const text = src('orchestrations/scripts/run-agent-orchestration.sh');
    const idx = text.indexOf('MC_FALLBACK_PY');
    const block = text.slice(idx, idx + 900);
    expect(block).toMatch(/_tmp_prd_path = prd_path \+ '\.tmp'/);
    expect(block).toMatch(/os\.replace\(_tmp_prd_path, prd_path\)/);
  });

  it('run-agent-orchestration.sh: skills-coordinator dedup write to profiles.json uses os.replace', () => {
    const text = src('orchestrations/scripts/run-agent-orchestration.sh');
    const idx = text.indexOf('duplicates_removed > 0');
    const block = text.slice(idx, idx + 300);
    expect(block).toMatch(/_tmp_path = path \+ '\.tmp'/);
    expect(block).toMatch(/os\.replace\(_tmp_path, path\)/);
  });

  it('run-agent-orchestration.sh: lint-gate AC-apply write uses os.replace', () => {
    const text = src('orchestrations/scripts/run-agent-orchestration.sh');
    const startIdx = text.indexOf("<<'LINT_AC_PY'");
    const endIdx = text.indexOf('LINT_AC_PY', startIdx + 10);
    const block = text.slice(startIdx, endIdx);
    expect(block).toMatch(/_tmp_prd_path=prd_path\+'\.tmp'/);
    expect(block).toMatch(/os\.replace\(_tmp_prd_path, prd_path\)/);
  });

  it('run-agent-orchestration.sh: story-ac-remediator AC-apply write uses os.replace', () => {
    const text = src('orchestrations/scripts/run-agent-orchestration.sh');
    const startIdx = text.indexOf("<<'AC_APPLY_PY'");
    const endIdx = text.indexOf('AC_APPLY_PY', startIdx + 10);
    const block = text.slice(startIdx, endIdx);
    expect(block).toMatch(/_tmp_prd_path = prd_path \+ '\.tmp'/);
    expect(block).toMatch(/os\.replace\(_tmp_prd_path, prd_path\)/);
  });

  it('post-impl-tc-writer.sh: TC application write uses os.replace', () => {
    const text = src('orchestrations/scripts/post-impl-tc-writer.sh');
    expect(text).toMatch(/_tmp_prd_file = prd_file \+ '\.tmp'/);
    expect(text).toMatch(/os\.replace\(_tmp_prd_file, prd_file\)/);
  });

  it('tier2-free-run.sh: model-patch write uses os.replace', () => {
    const text = src('orchestrations/scripts/tier2-free-run.sh');
    expect(text).toMatch(/_tmp_prd_path = '\$PRD_FILE' \+ '\.tmp'/);
    expect(text).toMatch(/os\.replace\(_tmp_prd_path, '\$PRD_FILE'\)/);
  });

  it('_prd_remediate_impl.py: the final PRD write-back uses os.replace', () => {
    const text = src('orchestrations/scripts/_prd_remediate_impl.py');
    expect(text).toMatch(/_tmp_prd_file = PRD_FILE \+ '\.tmp'/);
    expect(text).toMatch(/os\.replace\(_tmp_prd_file, PRD_FILE\)/);
  });

  it('spec-mode-runner.js: all 3 PRD write sites (run(), validateMidExecutionSplits(), splitTestStoryCli()) use fs.renameSync', () => {
    // 2026-07-15: splitTestStoryCli() (--split-test-story CLI dispatch, the
    // TC-fact-density split mandate's shell entry point) is a THIRD PRD
    // write site, added alongside run()'s and validateMidExecutionSplits()'
    // pre-existing ones — same atomic tmp-write-then-rename pattern.
    const text = src('orchestrations/scripts/spec-mode-runner.js');
    const tmpWrites = (text.match(/fs\.writeFileSync\(_tmpPrd(Path|File),/g) || []).length;
    const renames = (text.match(/fs\.renameSync\(_tmpPrd(Path|File), prd(Path|File)\)/g) || []).length;
    expect(tmpWrites).toBe(3);
    expect(renames).toBe(3);
  });
});

describe('atomic JSON writes — REAL execution proof', () => {
  it('a Python write-to-temp-then-os.replace sequence never leaves the target truncated even if interrupted between the write and the rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
    try {
      const targetPath = join(dir, 'profiles.json');
      writeFileSync(targetPath, JSON.stringify({ role: 'ORIGINAL CONTENT' }));

      // Simulate the write half of the atomic sequence WITHOUT the rename
      // (as if the process died right after the temp write, before the
      // rename) — the target must still hold the ORIGINAL content.
      const script = [
        'import json',
        `path = ${JSON.stringify(targetPath)}`,
        "tmp_path = path + '.tmp'",
        "with open(tmp_path, 'w') as f:",
        "    json.dump({'role': 'NEW CONTENT'}, f)",
        '# process "dies" here — no os.replace call',
      ].join('\n');
      execFileSync('python3', ['-c', script], { encoding: 'utf8' });

      const targetContent = JSON.parse(readFileSync(targetPath, 'utf8'));
      expect(targetContent.role).toBe('ORIGINAL CONTENT'); // untouched — the whole point
      expect(existsSync(`${targetPath}.tmp`)).toBe(true); // the temp file exists, harmlessly
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REPRODUCES the exact live failure mode being fixed: a bare open(path,"w") truncates the target immediately, before any content is written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'non-atomic-write-'));
    try {
      const targetPath = join(dir, 'profiles.json');
      writeFileSync(targetPath, JSON.stringify({ role: 'ORIGINAL CONTENT' }));

      // The OLD (unfixed) pattern: open(path, 'w') truncates on open, before
      // a single byte of new content is written. Kill the process (SIGKILL)
      // right after truncation happens but before json.dump can run, using a
      // deliberate blocking read on stdin that never arrives — proves the
      // target is left empty, not "either old or new content."
      const script = [
        'import sys',
        `path = ${JSON.stringify(targetPath)}`,
        "f = open(path, 'w')",  // truncates immediately
        "print('TRUNCATED', flush=True)",
        'sys.stdin.read()',  // blocks forever waiting for input that never comes
      ].join('\n');

      const proc = spawnSync('python3', ['-c', script], {
        encoding: 'utf8',
        timeout: 2000,
        killSignal: 'SIGKILL',
      });
      // spawnSync with a timeout sends killSignal once the timeout elapses —
      // the process is dead; check the file state now.
      expect(proc.stdout).toContain('TRUNCATED');
      const content = readFileSync(targetPath, 'utf8');
      expect(content).toBe(''); // corrupted: truncated with nothing written
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
