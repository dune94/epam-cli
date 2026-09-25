/**
 * A RUN TOUCHES ONLY ITS OWN INSTALL FOLDER (and the codeline its project declares).
 *
 * Operator, 2026-09-25: "All runs in another folder must only touch the install folder", and never
 * the main project. Found when a £0 rehearsal's install re-pointed the machine-wide `epam` shim, and
 * every pipeline script called the model through `EPAM_CLI="${EPAM_CLI:-epam}"` — PATH, so whichever
 * install ran last decided what every run executed.
 *
 * One real run of an install's greenfield project in a fixture folder, every model call at the
 * mocking agent, with three traps:
 *   - a DECOY `epam` first on PATH, which records any call: the run must use its own CLI;
 *   - an EMPTY sandbox HOME: anything the run leaves there was written outside the install;
 *   - this repository, fingerprinted before and after: the run must not change it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { ROOT } from '../integration/lib/fixture-install';
import { startProjectRun, launch } from './harness';
import { correct } from './seams';

const SRC = process.env.MOCK_AGENT_INSTALL || ROOT;
const PROJECT = process.env.MOCK_AGENT_PROJECT || readdirSync(join(SRC, 'orchestrations/projects')).find((p) => {
  const f = join(SRC, 'orchestrations/projects', p, 'config.env');
  return existsSync(f) && /^EPAM_BROWNFIELD=0\s*$/m.test(readFileSync(f, 'utf8'));
})!;
const JOURNALS = process.env.MOCK_AGENT_JOURNAL || join(ROOT, 'test-results/mock-agent');

const dirs: string[] = []; const children: ChildProcess[] = [];
afterAll(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The main project's state: every tracked file's status and content hash. */
function repoFingerprint(): string {
  return execFileSync('bash', ['-c', 'git status --porcelain --untracked-files=no && git diff | md5sum'], { cwd: ROOT, encoding: 'utf8' });
}

/** Everything under a directory, as relative paths. */
function listAll(dir: string): string[] {
  return execFileSync('bash', ['-c', `cd ${JSON.stringify(dir)} && find . -mindepth 1 | sort`], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

describe('a run touches only its own install folder', () => {
  it(`${PROJECT}: no call to a machine-wide epam, nothing written to HOME, the main project unchanged`, async () => {
    const journal = join(JOURNALS, `${PROJECT}-autonomy-${new Date().toISOString().replace(/[:.]/g, '')}`);
    mkdirSync(journal, { recursive: true });
    const trap = mkdtempSync(join(tmpdir(), 'autonomy-trap-')); dirs.push(trap);
    const home = join(trap, 'home'); mkdirSync(home);
    const decoyBin = join(trap, 'decoy-bin'); mkdirSync(decoyBin);
    const decoyLog = join(trap, 'decoy-calls.log');
    writeFileSync(join(decoyBin, 'epam'), `#!/usr/bin/env bash\necho "$PWD :: $*" >> ${JSON.stringify(decoyLog)}\nexit 97\n`);
    chmodSync(join(decoyBin, 'epam'), 0o755);
    const repoBefore = repoFingerprint();

    const r = await startProjectRun({ src: SRC, project: PROJECT, dirs, children, journal });
    r.agent.on('*', correct(r.world, r.install));
    // The decoy goes FIRST on the PATH the launcher would otherwise build (its docker stub included).
    const path = `${decoyBin}:${join(r.install, '.edge-bin')}:${join(ROOT, 'node_modules/.bin')}:${process.env.PATH}`;
    const res = await launch(r, { HOME: home, PATH: path });
    const log = `${res.stdout}\n${res.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    writeFileSync(join(journal, 'run.log'), log);

    const decoyCalls = existsSync(decoyLog) ? readFileSync(decoyLog, 'utf8').split('\n').filter(Boolean) : [];
    expect(decoyCalls, 'the run called a machine-wide `epam` from PATH instead of its own install\'s CLI').toEqual([]);
    expect(r.agent.calls.length, 'no model call reached the agent — the run proves nothing').toBeGreaterThan(0);
    expect(listAll(home), 'the run wrote into HOME — outside its install folder').toEqual([]);
    expect(repoFingerprint(), 'the run changed the main project').toBe(repoBefore);
  }, 70 * 60_000);
});
