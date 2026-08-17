/**
 * THE READINESS AUDIT MEASURED A FILE, NOT THE RUN — AND NOTHING CALLED IT.
 *
 * agent-readiness.js answers "can every agent this run will invoke actually deliver?" — seam,
 * ladder, project prompt, required inputs, tools, skills. Two defects made that answer worthless:
 *
 * 1. IT AUDITED THE WRONG SET. It read agents/profiles.json unconditionally. That file is the
 *    canonical roster, restored to a base state at the start of every run; the agents a run MINTS
 *    live in the project store until they are merged in. So the audit could report every agent
 *    ready while the four agents the run had just created were not in the set at all. Live
 *    2026-08-17, mock3: it audited 57 canonical agents and never saw transit-fare-engineer,
 *    transit-schedule-engineer, mocka-investigator or mockb-investigator.
 *
 * 2. NOTHING INVOKED IT. It was written, committed, and never wired to a call site — so it took
 *    162 gaps to 0 in a shell I ran by hand, and zero in the pipeline.
 *
 * Both are the same failure the audit exists to catch: a check that reports success because it had
 * nothing to examine. Hence the third property here — an empty roster is exit 2, never "ready".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const HANDLER = join(SCRIPTS, 'lib/handlers/agent-readiness.js');
const REAL_AGENTS = join(ROOT, 'orchestrations/agents');
const NODE = process.execPath;

let work: string;
let agentsDir: string;
let projectDir: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'readiness-'));
  agentsDir = join(work, 'agents');
  projectDir = join(work, 'project');
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(join(projectDir, 'prompts'), { recursive: true });
  // The real registry — the seam declarations are what the audit resolves against.
  cpSync(join(REAL_AGENTS, 'invocation-profiles.json'), join(agentsDir, 'invocation-profiles.json'));
});
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function run(rosterFile: string) {
  const r = spawnSync(NODE, [HANDLER, projectDir, agentsDir, rosterFile], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: projectDir },
  });
  let json: any = null;
  try { json = JSON.parse(r.stdout); } catch { /* exit 2 writes no report */ }
  return { rc: r.status, err: r.stderr, json };
}

function writeRoster(file: string, names: string[]) {
  const o: Record<string, unknown> = {};
  for (const n of names) o[n] = { brief: `${n} brief` };
  writeFileSync(file, JSON.stringify(o));
}

describe('readiness audited a file, not the run', () => {
  it('an agent this run MINTED is audited even when the roster file lacks it', () => {
    // The exact live case: the canonical roster is restored, the minted agents are in the project
    // store, and the audit must not report on a set that excludes them.
    const roster = join(agentsDir, 'profiles.json');
    writeRoster(roster, ['team-lead-review']);
    writeFileSync(join(projectDir, 'agent-profiles.json'), JSON.stringify({
      runId: 'TEST', profiles: { 'transit-fare-engineer': { brief: 'x' } },
    }));

    const { json } = run(roster);
    const names = (json.agents || []).map((a: any) => a.agent);
    expect(names, 'a minted agent was left outside the audit').toContain('transit-fare-engineer');
    expect(json.minted, 'the report does not say which agents came from the mint')
      .toContain('transit-fare-engineer');
    expect(json.agents.find((a: any) => a.agent === 'transit-fare-engineer').minted).toBe(true);
  });

  it('AN EMPTY ROSTER IS NOT A PASS', () => {
    // Zero agents produce zero gaps, and "ready: true" would be the audit reporting success on
    // nothing — the precise shape it exists to catch.
    const roster = join(agentsDir, 'profiles.json');
    writeFileSync(roster, JSON.stringify({}));

    const { rc, err, json } = run(roster);
    expect(rc, 'an empty roster passed the readiness audit').toBe(2);
    expect(json?.ready, 'an empty roster reported ready').not.toBe(true);
    expect(err, 'the operator is not told the audit had nothing to look at')
      .toMatch(/nothing to audit/i);
  });

  it('the roster file is chosen by the caller, not fixed in the handler', () => {
    // The whole first defect was a hardcoded path. A roster somewhere else must be auditable.
    const elsewhere = join(work, 'this-runs-roster.json');
    writeRoster(elsewhere, ['team-lead-review']);
    writeFileSync(join(agentsDir, 'profiles.json'), JSON.stringify({}));

    const { rc, json } = run(elsewhere);
    expect(rc, 'the handler fell back to the empty default roster').not.toBe(2);
    expect(json.roster, 'the report does not record which roster was audited').toBe(elsewhere);
    expect(json.agents.map((a: any) => a.agent)).toContain('team-lead-review');
  });

  it('the mint step invokes it — a handler nothing calls audits nothing', () => {
    const mint = readFileSync(join(SCRIPTS, 'mint-agents-step.js'), 'utf8');
    expect(mint, 'nothing in the pipeline runs the readiness audit')
      .toMatch(/handlers['"],\s*['"]agent-readiness\.js/);
    const i = mint.indexOf('agent-readiness.js');
    const block = mint.slice(i, i + 2600);
    expect(block, 'the audit is invoked against the default roster, not this run\'s')
      .toMatch(/PROFILES_PATH/);
    expect(block, 'a failed audit does not stop the run').toMatch(/throw new Error/);
    expect(block, 'the report is not persisted for the operator').toMatch(/writeFileSync\(outFile/);
  });
});
