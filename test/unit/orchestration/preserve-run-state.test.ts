import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * AN UPDATE MUST NEVER DESTROY RUN EVIDENCE — even though `git archive <ref>` overwrites every
 * tracked file in the ref unconditionally. Found 2026-09-03: orchestrations/logs/ alone carries
 * 5,268 tracked files (agent-mint.json, .rejection-AMSD-1919, ...) that are genuinely shaped like
 * real run evidence, not app code. Re-packaging a newer ref into an EXISTING install would
 * silently overwrite a colleague's real run history with whatever the ref's git history held at
 * the same path.
 *
 * run_state_exclude_args() turns the declared run-state-paths.json into `tar --exclude=` flags,
 * so the packaging step in install.sh can extract everything EXCEPT those paths — proven at the
 * tar level directly, the same mechanism install.sh actually uses, not a reimplementation of it.
 */
const LIB = path.resolve(__dirname, '../../../orchestrations-installer/lib/preserve-run-state.sh');
const NODE_BIN = process.execPath;

function excludeArgs(pathsJson: unknown): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preserve-run-state-'));
  const file = path.join(dir, 'run-state-paths.json');
  fs.writeFileSync(file, JSON.stringify(pathsJson));
  const out = execFileSync('bash', ['-c',
    `NODE_BIN=${JSON.stringify(NODE_BIN)}; . ${JSON.stringify(LIB)}; run_state_exclude_args "$1"`,
    '--', file], { encoding: 'utf8' });
  return out.trim().split('\n').filter(Boolean);
}

describe('run_state_exclude_args', () => {
  it('emits an --exclude for the path itself AND its contents', () => {
    const args = excludeArgs({ paths: ['orchestrations/logs'] });
    expect(args).toContain('--exclude=orchestrations/logs');
    expect(args).toContain('--exclude=orchestrations/logs/*');
  });

  it('covers every declared path, in order', () => {
    const args = excludeArgs({ paths: ['a/b', 'c/d'] });
    expect(args.filter((a) => a.includes('a/b')).length).toBe(2);
    expect(args.filter((a) => a.includes('c/d')).length).toBe(2);
  });

  it('an empty declaration produces no excludes, not an error', () => {
    const args = excludeArgs({ paths: [] });
    expect(args).toEqual([]);
  });
});

/**
 * THE REAL PROOF: run git archive | tar -x with these exact flags against a REAL repo and a REAL
 * pre-existing "live run" file at the same path a committed fixture also occupies — the exact
 * collision this whole mechanism exists to prevent.
 */
function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('the extraction actually protects live run state, end to end', () => {
  it('a committed fixture at a run-state path is EXCLUDED; live data at that path SURVIVES untouched', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'preserve-repo-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    fs.mkdirSync(path.join(repo, 'orchestrations/logs'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'orchestrations/logs/committed-fixture.json'), 'from the ref');
    fs.writeFileSync(path.join(repo, 'src/app.ts'), 'export const x = 1;');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'preserve-dest-'));
    fs.mkdirSync(path.join(dest, 'orchestrations/logs'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'orchestrations/logs/live-run-evidence.json'), 'REAL DATA — must survive');
    // A file at the SAME NAME as the committed fixture, but it is THIS install's own live data —
    // proves the exclude wins even on a direct name collision, not just "different files present".
    fs.writeFileSync(path.join(dest, 'orchestrations/logs/committed-fixture.json'), 'THIS INSTALL\'S OWN DATA — must NOT be overwritten');

    const excludes = excludeArgs({ paths: ['orchestrations/logs'] });
    execFileSync('bash', ['-c',
      `git -C "$1" archive HEAD | tar -x -C "$2" "${excludes.join('" "')}"`,
      '--', repo, dest], { encoding: 'utf8' });

    expect(fs.readFileSync(path.join(dest, 'orchestrations/logs/live-run-evidence.json'), 'utf8'))
      .toBe('REAL DATA — must survive');
    expect(fs.readFileSync(path.join(dest, 'orchestrations/logs/committed-fixture.json'), 'utf8'),
      'the ref\'s committed content overwrote this install\'s own live data')
      .toBe('THIS INSTALL\'S OWN DATA — must NOT be overwritten');
    // App code OUTSIDE the run-state path still updates normally.
    expect(fs.readFileSync(path.join(dest, 'src/app.ts'), 'utf8')).toContain('export const x = 1;');
  });
});
