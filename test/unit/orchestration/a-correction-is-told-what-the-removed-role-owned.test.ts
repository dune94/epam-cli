/**
 * A ROSTER CORRECTION IS TOLD WHAT THE REMOVED ROLE OWNED.
 *
 * Run 20260916T233216Z (skyscanner, claude set): the mint proposed ONE implementer owning
 * SKY-001..004. The review indicted it for a single sentence (the brief did not name a vitest
 * setting). The correction removed the whole role and asked for a replacement, telling the
 * proposer the defect and the survivors — never what the removed role had been for. The
 * replacement was a client engineer scoped to SKY-002; the next review found three tickets with
 * no implementer; the cycle budget (a literal 2) was spent; the run refused the roster.
 *
 * Driven through the real mintProjectAgents with a stub model that records the prompt it is
 * sent: the correction names each removed role, its kind, and the reason it was proposed, and
 * demands the replacement cover all of it. The cycle budget is asserted as the seam's own retry
 * budget, read from the same variables every other seam retries on.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
const CANONICAL = join(ROOT, 'orchestrations/agents/profiles.json');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function recorder() {
  const dir = mkdtempSync(join(tmpdir(), 'mint-replaced-')); dirs.push(dir);
  const capture = join(dir, 'prompts');
  const stub = join(dir, 'stub.sh');
  const reply = { proposedAgents: [{ name: 'a-replacement', kind: 'implementer', codeline: '*', systemPrompt: 'You implement.', rationale: 'r' }] };
  writeFileSync(stub, ['#!/usr/bin/env bash', `printf '<<<P>>>' >> "${capture}"`, `cat >> "${capture}"`, "cat <<'J'", JSON.stringify(reply), 'J', ''].join('\n'), { mode: 0o755 });
  return { dir, promptExec: { cmd: stub, args: [] }, prompts: () => (existsSync(capture) ? readFileSync(capture, 'utf8').split('<<<P>>>').filter((x) => x.trim()) : []) };
}

async function mint(extra: Record<string, unknown>) {
  const r = recorder();
  const profilesPath = join(r.dir, 'profiles.json');
  writeFileSync(profilesPath, readFileSync(CANONICAL, 'utf8'));
  const prev = process.env.EPAM_PROJECT_CONFIG_DIR; delete process.env.EPAM_PROJECT_CONFIG_DIR;
  try {
    await spec.mintProjectAgents({
      promptExec: r.promptExec,
      tickets: [{ jiraKey: 'SKY-001', title: 'scaffold' }, { jiraKey: 'SKY-002', title: 'client' }],
      referencedDocs: [], declaredDependencies: [], codelines: [{ name: 'app', path: r.dir }],
      toolGrant: 'read-only', profilesPath, agentsDir: r.dir, logDir: r.dir, repoPath: r.dir, ...extra,
    });
  } catch { /* the merge may refuse; the PROMPT is what is asserted */ }
  finally { if (prev !== undefined) process.env.EPAM_PROJECT_CONFIG_DIR = prev; }
  expect(r.prompts().length, 'the mint was never invoked').toBeGreaterThan(0);
  return r.prompts().join('\n');
}

const finding = { agent: 'skyscanner-node-engineer', severity: 'blocking', claim: 'vitest must exit 0 with no tests', checked: 'known-fixes', found: 'passWithNoTests absent', remedy: 'add passWithNoTests' };
const removed = { name: 'skyscanner-node-engineer', kind: 'implementer', codeline: '', rationale: 'a single implementer must write the scaffold, client, CLI and server across SKY-001 through SKY-004' };

describe('a correction is told what the removed role owned', () => {
  it("RUN 7's SHAPE: the removed role, its kind and why it was proposed reach the correction, with the demand to cover all of it", async () => {
    const prompt = await mint({ correctiveFindings: [finding], retainedAgents: [], replacedAgents: [removed] });
    expect(prompt).toContain('WERE REMOVED FOR THE DEFECTS ABOVE');
    expect(prompt).toContain(`- ${removed.name} [implementer]`);
    expect(prompt).toContain(removed.rationale);
    expect(prompt.replace(/\s+/g, ' ')).toMatch(/must cover EVERYTHING the removed role covered — every ticket, every codeline/);
  });

  it('the defect and the survivors are still there — the new block adds, it does not displace', async () => {
    const prompt = await mint({ correctiveFindings: [finding], retainedAgents: [{ name: 'kept-detective', codeline: 'app', rationale: 'reads' }], replacedAgents: [removed] });
    expect(prompt).toContain(finding.found);
    expect(prompt).toContain('kept-detective');
    expect(prompt.indexOf('WAS REVIEWED AND REJECTED')).toBeLessThan(prompt.indexOf('WERE REMOVED FOR THE DEFECTS'));
    expect(prompt.indexOf('WERE REMOVED FOR THE DEFECTS')).toBeLessThan(prompt.indexOf('ARE BEING KEPT'));
  });

  it('a first mint (nothing removed) carries no such block — the negative assertion', async () => {
    const prompt = await mint({});
    expect(prompt).not.toContain('WERE REMOVED FOR THE DEFECTS');
    expect(prompt).not.toContain('WAS REVIEWED AND REJECTED');
  });

  it('a correction that names no removed role (only gaps) carries no such block', async () => {
    const prompt = await mint({ correctiveFindings: [{ ...finding, agent: '' }], retainedAgents: [removed], replacedAgents: [] });
    expect(prompt).not.toContain('WERE REMOVED FOR THE DEFECTS');
    expect(prompt).toContain('ARE BEING KEPT');
  });
});

describe('the correction budget is the seam retry budget, not a literal', () => {
  const src = readFileSync(join(ROOT, 'orchestrations/scripts/mint-agents-step.js'), 'utf8');
  it('cycles derive from SEAM_MAX_RETRIES / SPEC_AGENT_MAX_RETRIES like every other seam', () => {
    // The step's own line, executed: the expression that sets maxCycles, evaluated under each env.
    const m = src.match(/const _seamRetries = ([^;]+);\s*\n\s*const maxCycles = ([^;]+);/);
    expect(m, 'the budget expression was not found').toBeTruthy();
    const evalCycles = (env: Record<string, string>) => {
      const saved = { ...process.env };
      for (const k of ['SEAM_MAX_RETRIES', 'SPEC_AGENT_MAX_RETRIES', 'EPAM_ROSTER_REVIEW_CYCLES']) delete process.env[k];
      Object.assign(process.env, env);
      try { return new Function(`const _seamRetries = ${m![1]}; return ${m![2]};`)(); }
      finally { for (const k of ['SEAM_MAX_RETRIES', 'SPEC_AGENT_MAX_RETRIES', 'EPAM_ROSTER_REVIEW_CYCLES']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
    };
    expect(evalCycles({})).toBe(4);
    expect(evalCycles({ SPEC_AGENT_MAX_RETRIES: '1' })).toBe(2);
    expect(evalCycles({ SEAM_MAX_RETRIES: '5' })).toBe(6);
    expect(evalCycles({ EPAM_ROSTER_REVIEW_CYCLES: '2' }), 'an explicit operator value still wins').toBe(2);
  });
});
