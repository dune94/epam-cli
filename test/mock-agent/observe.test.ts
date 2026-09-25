/**
 * OBSERVE: EVERY GREENFIELD PROJECT OF AN INSTALL, RUN AT £0 AGAINST THE MOCKING AGENT.
 *
 * MOCK_AGENT_INSTALL names the install whose projects and current configuration are used (default:
 * this repository). No project, set or stack is named here. The agent answers every seam from the
 * request and its declared contract; the journal holds every exchange for inspection, and the
 * project's real codeline is proven untouched.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { ROOT } from '../integration/lib/fixture-install';
import { startProjectRun, launch } from './harness';
import { correct } from './seams';
import { withScenario, type Rule } from './negatives';

const SRC = process.env.MOCK_AGENT_INSTALL || ROOT;
const JOURNALS = process.env.MOCK_AGENT_JOURNAL || join(ROOT, 'test-results/mock-agent');
const only = process.env.MOCK_AGENT_PROJECT || '';
/** Negative rules for this run (JSON array of {seam, story?, attempts?, negative}); none = every seam correct. */
const SCENARIO: Rule[] = process.env.MOCK_AGENT_SCENARIO ? JSON.parse(process.env.MOCK_AGENT_SCENARIO) : [];

const greenfield = readdirSync(join(SRC, 'orchestrations/projects')).filter((p) => {
  const f = join(SRC, 'orchestrations/projects', p, 'config.env');
  return existsSync(f) && /^EPAM_BROWNFIELD=0\s*$/m.test(readFileSync(f, 'utf8')) && (!only || p === only);
});

const dirs: string[] = []; const children: ChildProcess[] = [];
afterAll(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A fingerprint of a directory tree that exists on the host: what the run must not change. */
function fingerprint(dir: string): string {
  if (!dir || !existsSync(dir)) return 'absent';
  try { return execFileSync('bash', ['-c', `cd ${JSON.stringify(dir)} && git status --porcelain 2>/dev/null; git rev-parse HEAD 2>/dev/null; find . -path ./.git -prune -o -type f -printf '%P %s %T@\\n' 2>/dev/null | sort | md5sum`], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return `unreadable ${statSync(dir).mtimeMs}`; }
}

describe('the mocking agent drives a real project at £0', () => {
  it('the install declares at least one greenfield project', () => expect(greenfield.length).toBeGreaterThan(0));

  for (const project of greenfield) {
    it(`${project}: runs on the install's current configuration, every model call answered by the agent`, async () => {
      const journal = join(JOURNALS, `${project}-${new Date().toISOString().replace(/[:.]/g, '')}`);
      mkdirSync(journal, { recursive: true });
      const r = await startProjectRun({ src: SRC, project, dirs, children, journal });
      const before = fingerprint(r.realOut);

      // Every seam answered as a model that does its job correctly would answer it.
      r.agent.on('*', withScenario(correct(r.world, r.install), SCENARIO));
      if (SCENARIO.length) writeFileSync(join(journal, 'scenario.json'), JSON.stringify(SCENARIO, null, 1));

      const res = await launch(r);
      const log = `${res.stdout}\n${res.stderr}`;
      writeFileSync(join(journal, 'run.log'), log);
      // WHAT THE RUN LEFT BEHIND is kept with the journal before the fixture is removed: the run's
      // logs and its codeline are the evidence a failure is diagnosed from.
      for (const [from, to] of [[join(r.install, 'orchestrations/logs'), 'logs'], [r.out, 'codeline']] as const) {
        try { execFileSync('cp', ['-a', from, join(journal, to)]); } catch { /* absent */ }
      }
      const seams = [...new Set(r.agent.calls.map((c) => c.seam))];
      console.log(`[mock-agent] ${project}: exit ${res.status}; ${r.agent.calls.length} model call(s), ${seams.length} seam(s): ${seams.join(', ')}\n  journal: ${journal}`);

      writeFileSync(join(journal, 'conflicts.json'), JSON.stringify([...r.agent.conflicts.values()], null, 1));
      for (const c of r.agent.conflicts.values()) console.log(`[mock-agent] CONTRACT CONFLICT ${c.seam} (${c.template}): ${c.reasons.join('; ')}`);
      expect(fingerprint(r.realOut), `the run changed the project's REAL codeline ${r.realOut}`).toBe(before);
      expect(r.agent.stale, `the agent generated answers the current code cannot accommodate`).toEqual([]);
      // THE CLAIM ITSELF: with every seam answering correctly, the project completes — every phase it
      // declares reaches its gate's GO. This test passed on a run that exited 1 before it said so.
      const cfg = readFileSync(join(r.install, 'orchestrations/projects', project, 'config.env'), 'utf8');
      const phases = ((cfg.match(/^EPAM_PHASES="?([^"\n]*)"?/m) || [, ''])[1] || '').trim().split(/\s+/).filter(Boolean);
      const tail = log.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-40).join('\n');
      expect(res.status, `with every seam answering correctly the pipeline did not complete — log tail:\n${tail}`).toBe(0);
      for (const ph of phases) expect(log, `phase '${ph}' did not complete`).toMatch(new RegExp(`Phase '${ph}' completed`));
      expect(r.agent.calls.length, `no model call reached the agent — log tail:\n${log.split('\n').slice(-40).join('\n')}`).toBeGreaterThan(0);
    }, 70 * 60_000);
  }
});
