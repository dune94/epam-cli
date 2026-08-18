/**
 * THE WRITE PERIMETER LOCKED THE REPOS FOR ONE PROJECT AND NO OTHER.
 *
 * lib/codeline-write-perimeter.sh is the ONLY thing that stops a non-writer agent from editing a
 * codeline. specAgentEnv says so in as many words: "Writes are NOT prevented here. They are
 * prevented at the filesystem by the perimeter." Six agents hold `bash` against these repos.
 *
 * THE TWO HALVES WERE SPLIT. Releasing became generic — an EXIT trap in
 * run-agent-orchestration.sh, the engine every launcher runs — after two paused runs on
 * 2026-08-06 left 23 of the operator's repositories read-only with nothing said. Sealing stayed
 * where the bug was first seen: an inline loop over the subdirectories of $JIRA_CODELINE_ROOT in
 * tier3-metrolinx-run.sh. Of eight launchers, one sealed.
 *
 * THE ASYMMETRY WAS SILENT. Releasing a repo that was never locked is a no-op that logs nothing,
 * so seven projects ran with no perimeter and no message saying so.
 *
 * WHAT IT COST. The defect the perimeter was written for happened again, to a project it did not
 * cover. Live 2026-08-17 run 20260817T231306Z, mock-a: src/fares.ts and test/fares.test.ts were
 * rewritten at 20:03:50 — inside the Step 1 spec pass, before the writer stage was reached. The
 * seeded bug was fixed and two boundary tests added by a diagnosing-stage agent, so Step 5's
 * "Regression guard PASSED — baseline tests green" tested already-fixed code. The original commit
 * had recorded the same thing on the client: "~1050 lines across five files were rewritten during
 * the SPEC PASS, before the writer had run at all."
 *
 * THE FIX IS A MIRROR, NOT A COPY. perimeter_seal_all() sits beside perimeter_release_all() and
 * takes the same root, so the engine seals and releases through one pair of functions and every
 * launcher gets both. Copying metrolinx's loop into seven launchers would leave the eighth.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/codeline-write-perimeter.sh');
const ENGINE = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

/** Run a snippet with the perimeter library sourced. */
function sh(script: string) {
  return spawnSync('bash', ['-c', `. "${LIB}"\n${script}`], { encoding: 'utf8' });
}

const writable = (p: string) => (statSync(p).mode & 0o200) !== 0;

let estate: string;
let repoA: string;
let repoB: string;

beforeAll(() => {
  // A real estate: two real git repos under one root, plus a directory that is not a repo.
  estate = mkdtempSync(join(tmpdir(), 'perimeter-estate-'));
  const mk = (name: string) => {
    const dir = join(estate, name);
    mkdirSync(dir);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/app.ts'), 'export const x = 1;\n');
    mkdirSync(join(dir, '.epam'));
    writeFileSync(join(dir, '.epam/state.json'), '{}\n');
    for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']]) {
      spawnSync('git', ['-C', dir, ...a]);
    }
    return dir;
  };
  repoA = mk('codeline-a');
  repoB = mk('codeline-b');
  mkdirSync(join(estate, 'not-a-repo'));
  writeFileSync(join(estate, 'not-a-repo/loose.txt'), 'x\n');
});

afterAll(() => {
  // Unlock before removing, or rmSync trips over read-only files.
  sh(`perimeter_release_all "${estate}"`);
  rmSync(estate, { recursive: true, force: true });
});

describe('the write perimeter locked the repos for one project and no other', () => {
  it('SEALS EVERY REPOSITORY UNDER THE ROOT — not just the one a launcher named', () => {
    const r = sh(`perimeter_seal_all "${estate}"`);
    expect(r.status, `perimeter_seal_all failed: ${r.stderr}`).toBe(0);
    expect(writable(join(repoA, 'src/app.ts')), 'codeline-a stayed writable during the spec pass').toBe(false);
    expect(writable(join(repoB, 'src/app.ts')), 'codeline-b stayed writable during the spec pass').toBe(false);
    expect(r.stdout, 'sealing said nothing, so an unsealed estate looks the same').toMatch(/LOCKED/);
  });

  it('leaves the engine its own state directory — .epam is written mid-run by design', () => {
    expect(writable(join(repoA, '.epam/state.json')), 'the engine can no longer write its own state').toBe(true);
  });

  it('RELEASING GIVES THEM BACK — the pair round-trips', () => {
    const r = sh(`perimeter_release_all "${estate}"`);
    expect(r.status).toBe(0);
    expect(writable(join(repoA, 'src/app.ts')), 'the operator did not get codeline-a back').toBe(true);
    expect(writable(join(repoB, 'src/app.ts')), 'the operator did not get codeline-b back').toBe(true);
  });

  it('a directory that is not a repository is not ours to touch', () => {
    sh(`perimeter_seal_all "${estate}"`);
    expect(writable(join(estate, 'not-a-repo/loose.txt')), 'a non-repo directory was locked').toBe(true);
    sh(`perimeter_release_all "${estate}"`);
  });

  it('an empty or missing root is a no-op, never an error', () => {
    expect(sh('perimeter_seal_all ""').status, 'an unset root failed the caller').toBe(0);
    expect(sh(`perimeter_seal_all "${join(estate, 'nope')}"`).status, 'a missing root failed the caller').toBe(0);
  });

  it('THE ENGINE SEALS, SO EVERY LAUNCHER DOES — not one of eight', () => {
    // The REAL engine, not an extracted copy of one of its functions: this is the single script
    // every launcher runs, so proving it seals proves all eight do. It exits on the usage path in
    // ~0.1s, long after the perimeter is engaged at the top of the file.
    const r = spawnSync('bash', [ENGINE, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, JIRA_CODELINE_ROOT: estate },
      timeout: 30000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    expect(out, 'the engine never sealed — the perimeter is still per-launcher')
      .toMatch(/\[write-perimeter\] sealed \d+ codeline/);
    expect(out, 'the engine sealed a repository it was not given').toContain(estate);
  });

  it('AND GIVES THEM BACK ON EXIT — sealing without the trap strands the operator', () => {
    // Two paused runs left 23 repositories read-only. The seal is only safe because the release
    // trap covers every exit path, including the usage path exercised above.
    spawnSync('bash', [ENGINE, '--help'], {
      encoding: 'utf8', env: { ...process.env, JIRA_CODELINE_ROOT: estate }, timeout: 30000,
    });
    expect(writable(join(repoA, 'src/app.ts')),
      'the engine exited leaving the operator locked out of their own repository').toBe(true);
  });
});
