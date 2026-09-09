/**
 * THREE BLOCKING GUARDS SHIPPED THAT NO TEST HAD EVER RUN.
 *
 * preflight-static.sh ratchets `uncalibratedGuards` — shell functions that can stop a run (they
 * return non-zero, exit, or raise DETERMINISTIC_CHECK_FAILURE) and whose name appears nowhere
 * under test/. The baseline was re-derived at 31 on 2026-09-05 by CORRECTING the scanner rather
 * than waiving guards. On 2026-09-08 it read 34, and pre-flight refused the run:
 *
 *     guard calibration   FAIL  34 > baseline 31 — 3 new
 *
 * All three post-date that baseline, and all three came out of this session's own work:
 *
 *     pre-run-reset.sh:280  _obs_runtime_name      (2026-09-08)
 *     pre-run-reset.sh:290  _obs_compose           (2026-09-08)
 *     lib/git-ops.sh:467    record_story_changes   (2026-09-07)
 *
 * The scanner exists because on 2026-08-20 three guards were confirmed INERT in production while
 * the suite was green. So these are calibrated the way that finding demands — by executing each
 * one against the case it is supposed to catch — never by raising the baseline to match reality.
 *
 * The two reset guards run as their real bodies extracted from the real script (pre-run-reset.sh
 * does work at load, so it cannot simply be sourced), against the REAL installer library they
 * resolve. record_story_changes is driven by a real git repository with a real commit.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const RESET_SH = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const GIT_OPS = join(ROOT, 'orchestrations/scripts/lib/git-ops.sh');
const RUNTIME_LIB = join(ROOT, 'orchestrations-installer/lib/container-runtime.sh');

/** The real body, lifted from the real file — never a paraphrase of it. */
function fnText(file: string, name: string): string {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() not found in ${file}`);
  const end = src.indexOf('\n}', start);
  if (end === -1) throw new Error(`${name}() has no close in ${file}`);
  return src.slice(start, end + 2);
}

function bash(script: string, env: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'guard-'));
  const f = join(d, 'run.sh');
  writeFileSync(f, `#!/usr/bin/env bash\nset -uo pipefail\n${script}\n`);
  const r = spawnSync('bash', [f], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
  });
  rmSync(d, { recursive: true, force: true });
  return { out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), status: r.status };
}

// The two reset guards depend on _obs_runtime_lib, so it travels with them.
const OBS_FNS = [
  fnText(RESET_SH, '_obs_runtime_lib'),
  fnText(RESET_SH, '_obs_runtime_name'),
  fnText(RESET_SH, '_obs_compose'),
].join('\n');

describe('_obs_runtime_name — the guard that decides whether observability is reachable', () => {
  it('BLOCKS with "none" and rc 1 when no container-runtime library can be resolved', () => {
    // INSTALLER_LIB empty, REPO_ROOT pointed at a directory that holds no such library, and
    // BASH_SOURCE resolving under the temp script — so all three candidates genuinely miss.
    const r = bash(`${OBS_FNS}\n_obs_runtime_name; echo "rc=$?"`,
      { INSTALLER_LIB: '', REPO_ROOT: tmpdir() });
    expect(r.out).toContain('none');
    expect(r.out, 'a guard that cannot find its library must report failure, not silence')
      .toContain('rc=1');
  });

  it('resolves through the REAL installer library when one is reachable', () => {
    expect(existsSync(RUNTIME_LIB), 'the installer library this guard sources is missing').toBe(true);
    const r = bash(`${OBS_FNS}\n_obs_runtime_name; echo " rc=$?"`,
      { INSTALLER_LIB: RUNTIME_LIB });
    // Whether a runtime exists on this machine is not the point; that the guard reached the
    // library and answered from it, rather than failing to resolve, is.
    expect(r.out.length).toBeGreaterThan(0);
    expect(r.out).not.toContain('rc=1');
  });
});

describe('_obs_compose — the guard that refuses to run compose it cannot resolve', () => {
  it('BLOCKS with rc 1 rather than shelling out blind when the library is missing', () => {
    const r = bash(`${OBS_FNS}\n_obs_compose ps; echo "rc=$?"`,
      { INSTALLER_LIB: '', REPO_ROOT: tmpdir() });
    expect(r.out).toContain('rc=1');
  });

  it('DELEGATES to container_compose — it never reimplements the resolution', () => {
    // A stub library standing in for the installer's, proving the call actually arrives with the
    // caller's arguments intact. The second copy of this resolution is the drift it was written
    // to prevent, so what matters is that it hands over rather than deciding for itself.
    const d = mkdtempSync(join(tmpdir(), 'obslib-'));
    const lib = join(d, 'container-runtime.sh');
    writeFileSync(lib, 'container_compose() { echo "COMPOSE_GOT:$*"; }\n');
    try {
      const r = bash(`${OBS_FNS}\n_obs_compose up -d observability`, { INSTALLER_LIB: lib });
      expect(r.out).toBe('COMPOSE_GOT:up -d observability');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('record_story_changes — the guard that must never fail the story it records', () => {
  const preamble = `warning() { echo "WARN: $*"; }\ninfo() { :; }\n${fnText(GIT_OPS, 'record_story_changes')}`;

  it('BLOCKS with rc 1 and says so LOUDLY when LOG_DIR is unset', () => {
    const r = bash(`${preamble}\nunset LOG_DIR\nrecord_story_changes S-1 . ; echo "rc=$?"`);
    expect(r.out).toMatch(/LOG_DIR unset/);
    expect(r.out).toContain('rc=1');
  });

  it('records the real commit — sha, subject and changed file — from a REAL repository', () => {
    const d = mkdtempSync(join(tmpdir(), 'rsc-'));
    const repo = join(d, 'repo');
    const logs = join(d, 'logs');
    mkdirSync(repo, { recursive: true });
    mkdirSync(logs, { recursive: true });
    try {
      const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
      git('init', '-q');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      git('add', '-A');
      git('commit', '-qm', 'first commit');
      writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
      git('add', '-A');
      git('commit', '-qm', 'the story commit');

      const r = bash(`${preamble}\nrecord_story_changes AMSD-1919 "${repo}"; echo "rc=$?"`,
        { LOG_DIR: logs });
      const f = join(logs, 'story-changes.jsonl');
      expect(existsSync(f), 'the guard recorded nothing at all').toBe(true);
      const rec = JSON.parse(readFileSync(f, 'utf8').trim().split('\n').pop() as string);
      // Assert the ARTEFACT, not that the function ran.
      expect(rec.sha).toMatch(/^[0-9a-f]{7,40}$/);
      expect(rec.subject).toBe('the story commit');
      expect(JSON.stringify(rec)).toContain('a.txt');
      expect(r.out).toContain('rc=0');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
