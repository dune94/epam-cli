/**
 * THE LIVE SCENARIO, AT £0: an installed project's paused run, upgraded by the installer to the ref
 * under test, resumed — before any live token is spent on it.
 *
 * MOCK_AGENT_STATE_INSTALL names the install (required; skipped otherwise); MOCK_AGENT_PROJECT
 * picks one of its greenfield projects (default: the first); MOCK_AGENT_REF is the ref installed
 * (default HEAD). The real install and its codeline are only ever read.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { ROOT } from '../integration/lib/fixture-install';
import { launch } from './harness';
import { correct } from './seams';
import { startStateRun, realFingerprint } from './state-rehearsal';

const SRC = process.env.MOCK_AGENT_STATE_INSTALL || '';
const REF = process.env.MOCK_AGENT_REF || 'HEAD';
const JOURNALS = process.env.MOCK_AGENT_JOURNAL || join(ROOT, 'test-results/mock-agent');
const PROJECT = SRC && existsSync(join(SRC, 'orchestrations/projects')) ? (process.env.MOCK_AGENT_PROJECT || readdirSync(join(SRC, 'orchestrations/projects')).find((p) => {
  const f = join(SRC, 'orchestrations/projects', p, 'config.env');
  return existsSync(f) && /^EPAM_BROWNFIELD=0\s*$/m.test(readFileSync(f, 'utf8'));
})) : undefined;

const dirs: string[] = []; const children: ChildProcess[] = [];
afterAll(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!SRC || !PROJECT)(`an installed run, upgraded to ${REF} and resumed at £0`, () => {
  it(`${PROJECT}: the paused run resumes on the new engine and completes, every model call answered by the agent`, async () => {
    const journal = join(JOURNALS, `${PROJECT}-state-resume-${new Date().toISOString().replace(/[:.]/g, '')}`);
    mkdirSync(journal, { recursive: true });
    const realOut = (readFileSync(join(SRC, 'orchestrations/projects', PROJECT!, 'config.env'), 'utf8').match(/^OUTPUT_DIR=(.*)$/m) || [, ''])[1].trim();
    const before = realFingerprint(SRC, PROJECT!, realOut);
    const r = await startStateRun({ src: SRC, project: PROJECT!, ref: REF, dirs, children, journal });
    expect(r.runId, 'the install holds no checkpoint to resume').toMatch(/^\d{8}T\d{6}Z$/);
    r.agent.on('*', correct(r.world, r.install));
    const res = await launch(r, { EPAM_RESUME_RUN: r.runId }, 90 * 60_000);
    const log = `${res.stdout}\n${res.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    writeFileSync(join(journal, 'run.log'), log);
    for (const [from, to] of [[join(r.install, 'orchestrations/logs'), 'logs'], [r.out, 'codeline']] as const) {
      try { execFileSync('cp', ['-a', from, join(journal, to)]); } catch { /* absent */ }
    }
    writeFileSync(join(journal, 'conflicts.json'), JSON.stringify([...r.agent.conflicts.values()], null, 1));
    const seams = [...new Set(r.agent.calls.map((c) => c.seam))];
    console.log(`[state-rehearsal] ${PROJECT} resumed ${r.runId}: exit ${res.status}; ${r.agent.calls.length} call(s), seams: ${seams.join(', ')}\n  journal: ${journal}`);

    expect(realFingerprint(SRC, PROJECT!, realOut), 'the REAL install or codeline changed').toBe(before);
    expect(r.agent.stale, 'the agent served answers the current code cannot accommodate').toEqual([]);
    expect(log, 'the resume was not a resume of the installed run').toMatch(new RegExp(`RESUMED run ${r.runId}`));
    const tail = log.split('\n').slice(-50).join('\n');
    expect(res.status, `the resumed run did not complete — log tail:\n${tail}`).toBe(0);
  }, 120 * 60_000);
});
