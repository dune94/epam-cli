/**
 * AN AGENT THAT DIAGNOSES CODE MUST BE ABLE TO READ IT.
 *
 * WRITTEN BEFORE THE FIX.
 *
 * agent-invoke.sh grants tools only when the profile names them:
 *
 *     [ -n "$_tools" ] && _env+=("EPAM_ALLOWED_TOOLS=$_tools" "AI_GATE_ALLOW_TOOLS=1")
 *
 * Empty allowedTools therefore means NO TOOLS AT ALL — no bash, no read_file, no search. Three
 * profiles ran that way:
 *
 *     agent-failure-analyst   diagnoses a failed/no-output agent attempt
 *     impl-failure-analyst    diagnoses why an implementation attempt failed
 *     code-review-cycle       reviews the code produced in an iteration
 *
 * The first two are the SELF-HEAL path. They are asked "why did this fail and what should
 * change", given the story's acceptance criteria and a verification-failure string, and they
 * cannot open the file, run the failing command, or search the repository. Live 2026-08-12 an
 * analyst answered "Target=none — Transient import slip; lint message is self-explanatory for
 * retry": a reasonable guess from text, and useless as guidance. Their output drives MODEL
 * ESCALATION, so a blind diagnosis spends the writer's ladder.
 *
 * The reviewer profile that DOES have tools (team-lead-review) is the one that produces usable
 * verdicts. That is the comparison this fix rests on.
 *
 * THE TEST IS ON THE RECEIVER. Asserting the JSON contains a string proves nothing about
 * whether the runner is granted anything — the grant happens in agent-invoke.sh, from a
 * non-empty check, into the child's environment. So this runs the REAL invoke path with a stub
 * runner that records the environment it was handed.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const INVOKE = join(ROOT, 'orchestrations/scripts/lib/agent-invoke.sh');
const PROFILES = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Invoke the REAL agent-invoke path for a role; return the env the runner actually received. */
function invokeAndCaptureEnv(role: string): Record<string, string> {
  const d = mkdtempSync(join(tmpdir(), 'agent-tools-')); dirs.push(d);
  const envDump = join(d, 'env.txt');
  const runner = join(d, 'ai-run.sh');
  // NOT `env`: this machine's PATH carries a ~/.local/bin/env shim that exits 0 and runs
  // nothing — the exact hazard agent-invoke.sh documents at its exec site. `export -p` is a
  // bash builtin and cannot be shadowed.
  writeFileSync(runner, ['#!/usr/bin/env bash', `export -p > ${JSON.stringify(envDump)}`, 'echo "{}"'].join('\n'));
  chmodSync(runner, 0o755);

  const r = spawnSync('bash', ['-c', [
    'set -e',
    'log() { :; }; info() { :; }; warning() { :; }; error() { :; }; success() { :; }',
    `export AGENT_PROFILES_REGISTRY=${JSON.stringify(PROFILES)}`,
    `export AI_RUNNER_CMD=${JSON.stringify(runner)}`,
    `. ${JSON.stringify(INVOKE)}`,
    `printf 'a prompt' | invoke_agent ${JSON.stringify(role)} --runner ${JSON.stringify(runner)} >/dev/null 2>&1 || true`,
  ].join('\n')], { encoding: 'utf8', timeout: 60000 });

  if (!existsSync(envDump)) return { __NOT_INVOKED__: r.stderr || 'runner never ran' };
  const out: Record<string, string> = {};
  for (const line of readFileSync(envDump, 'utf8').split('\n')) {
    // `export -p` emits: declare -x NAME="value"
    const m = line.match(/^declare -x ([A-Za-z_][A-Za-z0-9_]*)="?(.*?)"?$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** The profile registry as data — for asserting declarations, not behaviour. */
const profiles = () => JSON.parse(readFileSync(PROFILES, 'utf8')).profiles;

const DIAGNOSTICIANS = ['agent-failure-analyst', 'impl-failure-analyst'];
const REVIEWERS = ['team-lead-review', 'code-review-cycle'];

describe('the harness reaches the real runner', () => {
  it('a profile that already has tools proves the path works', () => {
    // team-lead-review has always declared tools. If THIS does not show them, the harness is
    // broken and every assertion below would be vacuously true.
    const env = invokeAndCaptureEnv('team-lead-review');
    expect(env.__NOT_INVOKED__, `the runner was never invoked: ${env.__NOT_INVOKED__}`).toBeUndefined();
    expect(env.EPAM_ALLOWED_TOOLS, 'the known-good profile granted no tools — harness fault').toBeTruthy();
  });
});

describe('THE DEFECT: THE SELF-HEAL ANALYSTS CANNOT LOOK AT ANYTHING', () => {
  for (const role of DIAGNOSTICIANS) {
    it(`${role} is granted tools`, () => {
      const env = invokeAndCaptureEnv(role);
      expect(env.EPAM_ALLOWED_TOOLS,
        `${role} diagnoses failures with no ability to read the code, run the failing command, or search`)
        .toBeTruthy();
    });

    it(`${role} has the tool gate actually opened`, () => {
      // Both are needed: the list names them, the gate permits them. agent-invoke sets the two
      // together, so a profile with a list but no gate would still be blind.
      expect(invokeAndCaptureEnv(role).AI_GATE_ALLOW_TOOLS).toBe('1');
    });

    it(`${role} can at least READ and SEARCH`, () => {
      const tools = String(invokeAndCaptureEnv(role).EPAM_ALLOWED_TOOLS || '');
      expect(tools, `${role} cannot read a file`).toMatch(/read_file/);
      expect(tools, `${role} cannot search the repository`).toMatch(/search/);
    });
  }
});

describe('REVIEWERS TOO', () => {
  for (const role of REVIEWERS) {
    it(`${role} is granted tools`, () => {
      expect(invokeAndCaptureEnv(role).EPAM_ALLOWED_TOOLS,
        `${role} judges code it cannot open`).toBeTruthy();
    });
  }
});


/** The rungs a tier declares, from whichever provider set declares that tier. */
function ladderRungs(tier: string): any[] {
  const dir = join(process.cwd(), 'orchestrations/config');
  for (const f of readdirSync(dir).filter((x) => /^llm-defaults\..*\.json$/.test(x))) {
    const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const t = (c.ladders || {})[tier];
    if (t && Array.isArray(t.rungs) && t.rungs.length) return t.rungs;
  }
  return [];
}

/** The strongest tier the project declares — last in its own declared order. */
function strongestTier(): string {
  const dir = join(process.cwd(), 'orchestrations/config');
  for (const f of readdirSync(dir).filter((x) => /^llm-defaults\..*\.json$/.test(x))) {
    const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const order = Array.isArray(c.ladderTierOrder) ? c.ladderTierOrder : Object.keys(c.ladders || {});
    if (order.length) return String(order[order.length - 1]).toLowerCase();
  }
  return '';
}

describe('NO LOW OR MEDIUM INFERENCE ON THESE SEAMS', () => {
  // Operator, 2026-08-12: writer, reviewer and self-heal get the highest ladder, and medium is
  // a waste on seams whose output decides whether work is accepted or a model is escalated.
  for (const role of [...DIAGNOSTICIANS, ...REVIEWERS]) {
    it(`${role} runs at high or max effort — asked of the LADDER, which owns it`, () => {
      // THE SEAM NO LONGER DECLARES AN EFFORT, and must not: commit fb16b266 made the ladder own
      // reasoningEffort, because a flat per-seam value overrode the rung's own level and made the
      // cheap entry rung cost the same as the ceiling. This test asserted p.reasoningEffort and so
      // broke with that change — I shipped fb16b266 reporting it clean, having run 22 files that
      // did not include this one.
      //
      // The REQUIREMENT is unchanged and still worth guarding: a seam that decides whether work is
      // accepted, or whether a model escalates, must not run cheap. It is now a property of the
      // ladder that seam climbs, so that is what is asked.
      const p = profiles()[role];
      expect(p, `${role} is not in the registry`).toBeTruthy();
      expect(p.reasoningEffort,
        `${role} declares its own reasoningEffort again — the ladder owns it`).toBeUndefined();

      const rungs = ladderRungs(p.ladder);
      expect(rungs.length, `${role} climbs '${p.ladder}', which declares no rungs`).toBeGreaterThan(0);
      const top = rungs[rungs.length - 1];
      expect(['high', 'max', 'xhigh'],
        `${role} tops out at '${top.reasoningEffort}' on the '${p.ladder}' ladder`)
        .toContain(top.reasoningEffort);
    });

    it(`${role} climbs the project's strongest ladder`, () => {
      // WAS `.toBe('top')` — a POSITION, while the registry declares TIER NAMES. Every one of these
      // seams says 'highest', so this assertion was already failing before today; it is not part of
      // the effort change. The intent is what matters: the strongest tier the project declares,
      // whatever that project calls it. Resolved from the declaration, never a literal.
      const strongest = strongestTier();
      expect(strongest, 'no provider set declares a ladder tier order').toBeTruthy();
      expect(String(profiles()[role].ladder || '').toLowerCase(),
        `${role} is on '${profiles()[role].ladder}', not the strongest declared tier '${strongest}'`)
        .toBe(strongest);
    });
  }
});
