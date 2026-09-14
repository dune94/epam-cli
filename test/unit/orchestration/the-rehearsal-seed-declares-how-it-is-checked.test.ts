/**
 * THE REHEARSAL SEED DECLARES HOW IT IS CHECKED.
 *
 * The seed's package.json was a heredoc inside mock1-paused-run.sh declaring one devDependency and
 * no scripts, so the verification plugin detected neither a typecheck nor a test command for the
 * codeline: every writer attempt ended "the project declares no typecheck command — the check
 * could not run" and the harness could run no tests (£0 brownfield harness run 11, 2026-09-14).
 * A seed is a project fact: its manifest lives with the seed, declares the seed's own checks, and
 * the launcher's workspace carries it unchanged.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const PROJECTS = join(ROOT, 'orchestrations/projects');
const seeded = readdirSync(PROJECTS).filter((d) => existsSync(join(PROJECTS, d, 'seed')));
const plugin = require(join(ROOT, 'orchestrations/plugins/verification-plugin.js'));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('the rehearsal seed declares how it is checked', () => {
  it('a project owns a seed — otherwise nothing below is tested', () => { expect(seeded.length).toBeGreaterThan(0); });
  it.each(seeded)('%s: the verification plugin detects a typecheck AND a test command on the seed itself', (name) => {
    const seed = join(PROJECTS, name, 'seed');
    const v = plugin.detectVerification(seed); const t = plugin.detectTests(seed);
    expect(v && v.typecheck && v.typecheck.command, `${name}/seed declares no typecheck`).toBeTruthy();
    expect(t && t.test && t.test.command, `${name}/seed declares no test command`).toBeTruthy();
  });
  it.each(seeded)('%s: the launcher builds its workspace from the seed unchanged — the clone carries the seed manifest', (name) => {
    const ws = mkdtempSync(join(tmpdir(), 'seed-ws-')); dirs.push(ws);
    // The real launcher's workspace builder, executed: it lays out origin, seed and clone under the
    // run's workspace root, with the project's seed copied in.
    const r = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      `REPO_ROOT="${ROOT}"; PROJECT_CONFIG_DIR="${join(PROJECTS, name)}"; RUN_DIR="${ws}"; WORKSPACE="${ws}/workspace"; CODELINE_ROOT="${ws}/workspace/codelines"; CLONE="$CODELINE_ROOT/the-clone"`,
      `eval "$(sed -n '/^build_workspace() {/,/^}/p' "${join(ROOT, 'orchestrations/scripts/mock1-paused-run.sh')}")"`,
      'build_workspace',
    ].join('\n')], { encoding: 'utf8', timeout: 120000 });
    expect(r.status, r.stderr).toBe(0);
    const clone = join(ws, 'workspace/codelines/the-clone');
    for (const f of readdirSync(join(PROJECTS, name, 'seed'))) {
      if (f === 'src') continue;
      expect(readFileSync(join(clone, f), 'utf8'), `${f} in the clone differs from the seed's`).toBe(readFileSync(join(PROJECTS, name, 'seed', f), 'utf8'));
    }
    const v = plugin.detectVerification(clone); const t = plugin.detectTests(clone);
    expect(v && v.typecheck && v.typecheck.command, 'the clone declares no typecheck').toBeTruthy();
    expect(t && t.test && t.test.command, 'the clone declares no test command').toBeTruthy();
  });
});
