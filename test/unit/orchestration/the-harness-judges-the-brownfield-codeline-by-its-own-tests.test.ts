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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, readdirSync, existsSync, readFileSync } from 'node:fs';
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
      `RUN NUMBER: ${rid}`, 'STOPPED before the writer', 'resume finished (exit 0)',
      '[harness] run exited 0 · spend $0', '',
    ].join('\n'));
    // The phase gate's own record: GO for the phase — what every launcher's orchestration writes.
    mkdirSync(join(dest, 'orchestrations/logs'), { recursive: true });
    writeFileSync(join(dest, 'orchestrations/logs/phase-gates.jsonl'), JSON.stringify({ phase_id: 'core', decision: 'go', decision_maker: 'check-phase-gate.sh' }) + '\n');
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
    expect(out, 'the phase is judged by its gate record, not a log phrase').toMatch(/✓ phase 'core' completed/);

    // THE RATCHET. A fix that makes the next run worse is not permitted (operator, 2026-09-14: run
    // 15 went from 35/40 to 27/40 on a "fix"). Judged again against the previous run's verdict, a
    // seam that executed then and not now, or a check that passed then and fails now, is RED on
    // its own — whatever else was gained.
    const verdict = JSON.parse(readFileSync(join(dest, 'harness-verdict.json'), 'utf8'));
    expect(Array.isArray(verdict.seamsExecutedList), 'the verdict does not record which seams executed').toBe(true);
    expect(Array.isArray(verdict.failureKeys), 'the verdict does not record its failures as comparable keys').toBe(true);
    const baseline = join(dest, 'previous-verdict.json');
    const gained = verdict.seamsNotExecuted[0];   // something this run did NOT execute
    expect(gained, 'this install executed every seam — nothing to ratchet on').toBeTruthy();
    writeFileSync(baseline, JSON.stringify({ ...verdict, sha: 'prev1234', seamsExecutedList: [...verdict.seamsExecutedList, gained], failureKeys: [] }));
    const r2 = spawnSync('bash', [join(ROOT, 'orchestrations/scripts/greenfield-harness.sh'), '--assess-only', dest, '--ratchet', baseline], {
      encoding: 'utf8', timeout: 180000,
      env: { ...process.env, NODE_BIN: process.execPath, EPAM_PROVIDER_SET: 'mockserver', LANGFUSE_BASE_URL: 'http://127.0.0.1:1' },
    });
    const out2 = `${r2.stdout}\n${r2.stderr}`;
    expect(out2, 'a seam that executed on the previous run and not on this one did not fail the ratchet').toMatch(new RegExp(`✗ ratchet: ${gained.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} executed on prev1234 and not on this run`));
    expect(out2).toMatch(/VERDICT RED/);
    // A seam the registry now declares inapplicable to this project is not ratcheted: it is
    // excluded with its stated reason, not lost. (topology-router on a one-story project, run 19.)
    const notExpected = (out.match(/- (\S+) — not expected:/) || [])[1];
    expect(notExpected, 'no seam is excluded by declaration on this project').toBeTruthy();
    writeFileSync(baseline, JSON.stringify({ ...verdict, sha: 'prev1234', seamsExecutedList: [notExpected], failureKeys: verdict.failureKeys }));
    const r4 = spawnSync('bash', [join(ROOT, 'orchestrations/scripts/greenfield-harness.sh'), '--assess-only', dest, '--ratchet', baseline], {
      encoding: 'utf8', timeout: 180000,
      env: { ...process.env, NODE_BIN: process.execPath, EPAM_PROVIDER_SET: 'mockserver', LANGFUSE_BASE_URL: 'http://127.0.0.1:1' },
    });
    const out4 = `${r4.stdout}\n${r4.stderr}`;
    expect(out4, 'a seam declared inapplicable was ratcheted').not.toMatch(/✗ ratchet/);
    expect(out4).toMatch(new RegExp(`ratchet: ${notExpected} executed on prev1234 and is not expected here`));
    // And a previous run that was strictly worse ratchets nothing.
    writeFileSync(baseline, JSON.stringify({ ...verdict, sha: 'prev1234', seamsExecutedList: [], failureKeys: verdict.failureKeys }));
    const r3 = spawnSync('bash', [join(ROOT, 'orchestrations/scripts/greenfield-harness.sh'), '--assess-only', dest, '--ratchet', baseline], {
      encoding: 'utf8', timeout: 180000,
      env: { ...process.env, NODE_BIN: process.execPath, EPAM_PROVIDER_SET: 'mockserver', LANGFUSE_BASE_URL: 'http://127.0.0.1:1' },
    });
    expect(`${r3.stdout}\n${r3.stderr}`).not.toMatch(/✗ ratchet/);
  });
});
