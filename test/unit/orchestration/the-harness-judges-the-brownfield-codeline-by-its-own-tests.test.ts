/**
 * THE £0 HARNESS JUDGES THE BROWNFIELD CODELINE BY ITS OWN TESTS.
 *
 * The harness resolved the test command from `$DEST/build` — the greenfield output directory —
 * for every project, so a brownfield rehearsal (codeline = the clone the launcher built under the
 * workspace root) was judged "the codeline's ecosystem declares a test command ✗" whatever the
 * codeline declared (£0 brownfield harness run 11, 2026-09-14). The command is resolved from the
 * codeline being judged.
 *
 * Judged by executing the real harness's --assess-only against a kept install of this test's own:
 * the real scripts, a project with a seed, a recorded paused-and-resumed run, and a codeline whose
 * manifest declares a test command that passes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('the harness judges the brownfield codeline by its own tests', () => {
  it('--assess-only runs the test command the CODELINE declares, not one looked up under the greenfield output dir', () => {
    const dest = mkdtempSync(join(tmpdir(), 'bf-judge-')); dirs.push(dest);
    cpSync(join(ROOT, 'orchestrations/scripts'), join(dest, 'orchestrations/scripts'), { recursive: true });
    cpSync(join(ROOT, 'orchestrations/agents'), join(dest, 'orchestrations/agents'), { recursive: true });
    cpSync(join(ROOT, 'orchestrations/config'), join(dest, 'orchestrations/config'), { recursive: true });
    cpSync(join(ROOT, 'orchestrations/ecosystems'), join(dest, 'orchestrations/ecosystems'), { recursive: true });
    // The project: a real one that owns a seed (so the harness judges it as a brownfield rehearsal).
    const projects = join(ROOT, 'orchestrations/projects');
    const name = readdirSync(projects).find((d) => existsSync(join(projects, d, 'seed')))!;
    expect(name, 'no project owns a seed').toBeTruthy();
    cpSync(join(projects, name), join(dest, 'orchestrations/projects', name), { recursive: true, filter: (p) => !/\/runs(\/|$)/.test(p) });
    // The run the harness recorded: paused, resumed, one phase, its run id.
    const rid = '20260914T000000Z';
    writeFileSync(join(dest, 'harness.log'), [
      `[harness] ref abc1234 · set mockserver · project ${name} · install ${dest} · ceiling $5`,
      `RUN NUMBER: ${rid}`, 'STOPPED before the writer', 'resume finished (exit 0)', "Phase 'core' completed",
      '[harness] run exited 0 · spend $0', '',
    ].join('\n'));
    // The codeline: two commits, a manifest whose ecosystem declares a test command that passes.
    const ws = join(dest, 'mock1-workspace', rid, 'workspace'); const codeline = join(ws, 'codelines', 'the-codeline');
    mkdirSync(codeline, { recursive: true });
    writeFileSync(join(codeline, 'package.json'), JSON.stringify({ name: 'the-codeline', private: true, scripts: { test: 'echo the codeline tests ran' } }));
    for (const c of ['one', 'two']) { writeFileSync(join(codeline, c), c); spawnSync('git', ['-C', codeline, 'init', '-q']); spawnSync('git', ['-C', codeline, 'add', '-A']); spawnSync('git', ['-C', codeline, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', c]); }
    writeFileSync(join(ws, 'synthesized-prd.json'), JSON.stringify({ stories: [{ id: 'S-1', completed: true }] }));
    const r = spawnSync('bash', [join(ROOT, 'orchestrations/scripts/greenfield-harness.sh'), '--assess-only', dest], {
      encoding: 'utf8', timeout: 180000,
      env: { ...process.env, NODE_BIN: process.execPath, EPAM_PROVIDER_SET: 'mockserver', LANGFUSE_BASE_URL: 'http://127.0.0.1:1' },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out, 'the harness did not run the test command the codeline declares').toMatch(/✓ codeline tests green: npm test/);
    expect(out).not.toMatch(/the codeline's ecosystem declares a test command/);
  });
});
