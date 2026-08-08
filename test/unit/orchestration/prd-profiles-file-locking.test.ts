/**
 * File locking (flock) for profiles.json/PRD writes — prevents a LOST
 * UPDATE when two processes (e.g. two parallel worktree stories) both
 * read-modify-write the same file around the same time.
 *
 * Root cause this fixes (found live, 2026-07-11, tier3-travel-app run, in
 * response to the user's question "why is file locking still open?" after
 * the atomic-write-then-rename fix earlier the same day): atomicity alone
 * only guarantees a file is never left CORRUPTED/half-written — it does
 * NOT guarantee that two concurrent writers don't clobber each other's
 * change. If process A reads profiles.json, appends note A, and writes;
 * and process B reads profiles.json (before A's write lands), appends note
 * B, and writes — whichever finishes last wins, silently discarding the
 * other's note. This pipeline explicitly runs stories in parallel worktree
 * lanes (Step 2/3a), each a separate claude.sh process, so this is a real
 * risk, not theoretical.
 *
 * Fix: wrap each read-modify-write step (already made atomic earlier) in a
 * bash `flock -x` (claude.sh, run-agent-orchestration.sh) or an equivalent
 * exclusive-file-creation lock (spec-mode-runner.js, which has no built-in
 * flock) — held only around the FAST read-apply-write step, never around
 * the slow LLM call that precedes it, so parallel stories don't stall on
 * each other's model latency.
 *
 * Known remaining gap (documented in a code comment at the profile-
 * augmentor call site): that agent still writes profiles.json via its own
 * Bash/WriteFile tool access mid-LLM-call, which can't be flock-wrapped the
 * same way — out of scope for this pass.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, statSync, utimesSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const SPEC_RUNNER_JS = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const orchSrc = readFileSync(ORCH_SH, 'utf8');
const specRunnerSrc = readFileSync(SPEC_RUNNER_JS, 'utf8');

describe('file locking — wiring (static)', () => {
  it('claude.sh: all 4 AC/TC patch-apply sites acquire flock before writing', () => {
    const count = (claudeSrc.match(/flock -w 10 200 \|\| \{ error "  \[FailureAnalyst\] Could not acquire lock on \$prd_target"; return 1; \}/g) || []).length;
    expect(count).toBe(4);
  });

  // TARGET CHANGED 2026-08-07 (ARCH-5): the skill note is appended to the codeline KB, not
  // written into profiles.json, so the lock that matters is the one on the KB file. Same
  // concern, new file: parallel lanes append to this store concurrently.
  it('claude.sh: the skill-note persistence append acquires flock on the KB file', () => {
    expect(claudeSrc).toMatch(/flock -w 10 201 \|\| \{ error "  \[FailureAnalyst\] Could not acquire lock on \$_skill_kb_file"; return 1; \}/);
  });

  it('run-agent-orchestration.sh: PRD model coordinator fallback write acquires flock', () => {
    expect(orchSrc).toMatch(/flock -w 10 200 \|\| \{ error "  \[prd-model-coordinator\] Could not acquire lock on \$_mc_prd_target"; exit 1; \}/);
  });

  it('run-agent-orchestration.sh: skills-coordinator dedup write acquires flock', () => {
    expect(orchSrc).toMatch(/flock -w 10 200 \|\| \{ error "  \[SkillsAudit\] Could not acquire lock on \$profiles_file"; return 1; \}/);
  });

  it('run-agent-orchestration.sh: lint-gate AC-apply write acquires flock', () => {
    expect(orchSrc).toMatch(/flock -w 10 200 \|\| \{ error "  \[lint-gate:remediator\] Could not acquire lock/);
  });

  it('run-agent-orchestration.sh: story-ac-remediator AC-apply write acquires flock', () => {
    expect(orchSrc).toMatch(/flock -w 10 200 \|\| \{ error "  \[story-ac-remediator\] Could not acquire lock/);
  });

  it('run-agent-orchestration.sh: the profile-augmentor gap is explicitly documented (not silently unaddressed)', () => {
    const idx = orchSrc.indexOf('# ── Agent 3: profile-augmentor ─');
    const block = orchSrc.slice(idx, idx + 1200);
    expect(block).toMatch(/KNOWN GAP/);
    expect(block.replace(/\n\s*#\s?/g, ' ')).toMatch(/can't be wrapped in a shell-level flock/);
  });

  it('spec-mode-runner.js: all 3 PRD write sites acquire/release the JS-side lock', () => {
    // 2026-07-15: splitTestStoryCli() (--split-test-story) is a third PRD
    // write site — reuses the SAME _prdLockPath variable name as run()'s
    // (they're in different, non-overlapping functions), hence the plain
    // (no "2" suffix) match also picking it up.
    expect(specRunnerSrc).toMatch(/function acquireFileLock/);
    expect(specRunnerSrc).toMatch(/function releaseFileLock/);
    const acquireCalls = (specRunnerSrc.match(/acquireFileLock\(_prdLockPath2?\)/g) || []).length;
    const releaseCalls = (specRunnerSrc.match(/releaseFileLock\(_prdLockPath2?\)/g) || []).length;
    expect(acquireCalls).toBe(3);
    expect(releaseCalls).toBe(3);
  });
});

describe('file locking — REAL execution: bash flock actually serializes concurrent writers', () => {
  it('REPRODUCES the exact live risk and proves the fix: two processes racing to append to the SAME profiles.json role are serialized — BOTH notes survive (no lost update)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flock-race-'));
    const profilesPath = join(dir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({ 'test-engineer': 'original' }));
    const lockPath = `${profilesPath}.lock`;

    // Minimal reproduction of the real pattern: acquire flock, read the
    // CURRENT file fresh, append a note, atomic-write, release. Both
    // "writers" sleep briefly WHILE HOLDING THE LOCK to widen the race
    // window — without the lock, this virtually guarantees a lost update;
    // with it, both notes must survive because writer B is forced to wait
    // for writer A's fresh read+write to complete first.
    function makeWriterScript(note: string): string {
      return [
        '#!/usr/bin/env bash',
        `( flock -x 200`,
        `  python3 -c "` +
          `import json, time; ` +
          `p = json.load(open('${profilesPath}')); ` +
          `time.sleep(0.3); ` +  // widen the race window while holding the lock
          `p['test-engineer'] = p.get('test-engineer', '') + ' ${note}'; ` +
          `tmp = '${profilesPath}' + '.tmp'; ` +
          `json.dump(p, open(tmp, 'w')); ` +
          `import os; os.replace(tmp, '${profilesPath}')` +
          `"`,
        `) 200>"${lockPath}"`,
      ].join('\n');
    }

    const scriptA = join(dir, 'writerA.sh');
    const scriptB = join(dir, 'writerB.sh');
    writeFileSync(scriptA, makeWriterScript('NOTE_A'));
    writeFileSync(scriptB, makeWriterScript('NOTE_B'));

    // Launch both concurrently (not sequentially) to actually race.
    const procA = spawn('bash', [scriptA]);
    const procB = spawn('bash', [scriptB]);
    const wait = (proc: typeof procA) =>
      new Promise<void>((resolve) => proc.on('close', () => resolve()));

    return Promise.all([wait(procA), wait(procB)])
      .then(() => {
        const final = JSON.parse(readFileSync(profilesPath, 'utf8'));
        expect(final['test-engineer']).toContain('NOTE_A');
        expect(final['test-engineer']).toContain('NOTE_B');
      })
      .finally(() => {
        rmSync(dir, { recursive: true, force: true });
      });
  });

  it('a lock held by one flock invocation genuinely blocks a second invocation until released (direct proof of mutual exclusion)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flock-mutex-'));
    const lockPath = join(dir, 'test.lock');
    const orderFile = join(dir, 'order.log');
    writeFileSync(orderFile, '');

    const holderScript = join(dir, 'holder.sh');
    writeFileSync(
      holderScript,
      [
        '#!/usr/bin/env bash',
        `( flock -x 200`,
        `  echo "holder-acquired" >> "${orderFile}"`,
        `  sleep 0.4`,
        `  echo "holder-released" >> "${orderFile}"`,
        `) 200>"${lockPath}"`,
      ].join('\n'),
    );
    const waiterScript = join(dir, 'waiter.sh');
    writeFileSync(
      waiterScript,
      [
        '#!/usr/bin/env bash',
        'sleep 0.1', // ensure holder acquires first
        `( flock -x 200`,
        `  echo "waiter-acquired" >> "${orderFile}"`,
        `) 200>"${lockPath}"`,
      ].join('\n'),
    );

    const procHolder = spawn('bash', [holderScript]);
    const procWaiter = spawn('bash', [waiterScript]);
    const wait = (proc: typeof procHolder) =>
      new Promise<void>((resolve) => proc.on('close', () => resolve()));

    return Promise.all([wait(procHolder), wait(procWaiter)])
      .then(() => {
        const lines = readFileSync(orderFile, 'utf8').trim().split('\n');
        // The waiter must NOT acquire before the holder releases — proves
        // the second flock invocation genuinely blocked, not just "usually
        // finished later by coincidence."
        const releaseIdx = lines.indexOf('holder-released');
        const waiterIdx = lines.indexOf('waiter-acquired');
        expect(releaseIdx).toBeGreaterThan(-1);
        expect(waiterIdx).toBeGreaterThan(-1);
        expect(waiterIdx).toBeGreaterThan(releaseIdx);
      })
      .finally(() => {
        rmSync(dir, { recursive: true, force: true });
      });
  });
});

describe('spec-mode-runner.js acquireFileLock/releaseFileLock — REAL execution', () => {
  function extractLockHelpers(): string {
    const start = specRunnerSrc.indexOf('function acquireFileLock');
    const end = specRunnerSrc.indexOf('\nfunction releaseFileLock');
    const releaseEnd = specRunnerSrc.indexOf('\n}', end) + 2;
    return specRunnerSrc.slice(start, releaseEnd);
  }

  it('a second acquireFileLock call blocks until the first releases (direct proof of mutual exclusion)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'js-lock-mutex-'));
    const lockPath = join(dir, 'test.lock');
    const orderFile = join(dir, 'order.log');
    writeFileSync(orderFile, '');
    const helpers = extractLockHelpers();

    const holderScript = join(dir, 'holder.js');
    writeFileSync(
      holderScript,
      [
        `const fs = require('node:fs');`,
        `const { execSync } = require('node:child_process');`,
        helpers,
        `acquireFileLock(${JSON.stringify(lockPath)});`,
        `fs.appendFileSync(${JSON.stringify(orderFile)}, 'holder-acquired\\n');`,
        `execSync('sleep 0.4');`,
        `fs.appendFileSync(${JSON.stringify(orderFile)}, 'holder-released\\n');`,
        `releaseFileLock(${JSON.stringify(lockPath)});`,
      ].join('\n'),
    );
    const waiterScript = join(dir, 'waiter.js');
    writeFileSync(
      waiterScript,
      [
        `const fs = require('node:fs');`,
        `const { execSync } = require('node:child_process');`,
        helpers,
        `execSync('sleep 0.1');`,
        `acquireFileLock(${JSON.stringify(lockPath)});`,
        `fs.appendFileSync(${JSON.stringify(orderFile)}, 'waiter-acquired\\n');`,
        `releaseFileLock(${JSON.stringify(lockPath)});`,
      ].join('\n'),
    );

    const nodeBin = process.execPath;
    const procHolder = spawn(nodeBin, [holderScript]);
    const procWaiter = spawn(nodeBin, [waiterScript]);
    const wait = (proc: typeof procHolder) =>
      new Promise<void>((resolve) => proc.on('close', () => resolve()));

    return Promise.all([wait(procHolder), wait(procWaiter)])
      .then(() => {
        const lines = readFileSync(orderFile, 'utf8').trim().split('\n');
        const releaseIdx = lines.indexOf('holder-released');
        const waiterIdx = lines.indexOf('waiter-acquired');
        expect(releaseIdx).toBeGreaterThan(-1);
        expect(waiterIdx).toBeGreaterThan(-1);
        expect(waiterIdx).toBeGreaterThan(releaseIdx);
      })
      .finally(() => {
        rmSync(dir, { recursive: true, force: true });
      });
  });

  it('a stale lock file (older than the timeout) is stolen instead of blocking forever', () => {
    const dir = mkdtempSync(join(tmpdir(), 'js-lock-stale-'));
    try {
      const lockPath = join(dir, 'test.lock');
      writeFileSync(lockPath, '99999'); // simulate an abandoned lock from a killed process
      const oldTime = new Date(Date.now() - 60_000); // 60s ago
      utimesSync(lockPath, oldTime, oldTime);

      const helpers = extractLockHelpers();
      const scriptPath = join(dir, 'steal.js');
      writeFileSync(
        scriptPath,
        [
          `const fs = require('node:fs');`,
          `const { execSync } = require('node:child_process');`,
          helpers,
          `acquireFileLock(${JSON.stringify(lockPath)}, 1000);`, // 1s stale-timeout for a fast test
          `console.log('ACQUIRED');`,
        ].join('\n'),
      );
      const output = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8', timeout: 5000 });
      expect(output).toMatch(/ACQUIRED/);
      expect(existsSync(lockPath)).toBe(true); // re-created by the successful acquire
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('acquireFileLock throws if the lock cannot be acquired within the timeout (held by a live, non-stale lock)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'js-lock-timeout-'));
    try {
      const lockPath = join(dir, 'test.lock');
      writeFileSync(lockPath, String(process.pid)); // fresh (non-stale) lock, never released
      const helpers = extractLockHelpers();
      const scriptPath = join(dir, 'timeout.js');
      writeFileSync(
        scriptPath,
        [
          `const fs = require('node:fs');`,
          `const { execSync } = require('node:child_process');`,
          helpers,
          `try {`,
          `  acquireFileLock(${JSON.stringify(lockPath)}, 300);`, // short timeout for a fast test
          `  console.log('ACQUIRED');`,
          `} catch (e) {`,
          `  console.log('TIMED_OUT: ' + e.message);`,
          `}`,
        ].join('\n'),
      );
      const output = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8', timeout: 5000 });
      expect(output).toMatch(/TIMED_OUT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * LOCK SCOPE — the intent documented at the top of this file was never asserted.
 *
 * The lock must wrap ONLY the disk write, never the slow agent call that precedes it.
 * Widen it by a few lines and correctness tests all still pass — mutual exclusion still
 * holds, no writes interleave — while every parallel lane silently queues behind whichever
 * lane is mid-LLM-call. A 3-lane spec pass then costs 3× its wall time and looks, from
 * every existing assertion, entirely healthy.
 *
 * This is the shape that cost a 48-minute spec pass to diagnose by hand (2026-08-03).
 * The lock turned out NOT to be the cause there — it is correctly scoped today — but
 * nothing was stopping it from becoming the cause tomorrow.
 */
describe('lock SCOPE — never held across an agent call', () => {
  const specSrc = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('every acquireFileLock/releaseFileLock region contains no agent invocation', () => {
    const offenders: string[] = [];
    // Slow operations that must never sit inside a held lock.
    const SLOW = /\b(await\s+run(Claude|AgentForJson|SpecAgent)|runCodeGraphDetective|regenerateVcViaOpenspec|reviewVcViaSpeckit|execSync\(\s*['"`][^'"`]*epam)/;
    let idx = specSrc.indexOf('acquireFileLock(');
    while (idx > -1) {
      const release = specSrc.indexOf('releaseFileLock(', idx);
      if (release > -1) {
        const region = specSrc.slice(idx, release);
        const hit = SLOW.exec(region);
        if (hit) {
          const line = specSrc.slice(0, idx).split('\n').length;
          offenders.push(`  spec-mode-runner.js:${line} holds the lock across '${hit[1]}'`);
        }
      }
      idx = specSrc.indexOf('acquireFileLock(', idx + 1);
    }
    expect(
      offenders,
      'A lock held across an agent call serialises every parallel lane while every ' +
        'correctness assertion still passes — the failure is invisible except as wall time:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

});
