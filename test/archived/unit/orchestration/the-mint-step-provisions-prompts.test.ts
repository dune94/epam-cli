/**
 * THE MINT STEP PROVISIONS THIS PROJECT'S PROMPTS.
 *
 * project-prompt-builder.js passing its own unit tests proves nothing about a run: what
 * matters is whether the mint step actually INVOKES it. A library that works and is wired to
 * nothing is the exact shape of the coupled-pair gate, which was committed, tested, and had
 * never once executed because it resolved a path nothing provisions.
 *
 * So this executes the REAL mint-agents-step.js — the shipped script, not a restatement of
 * it — against a sandbox, with only the MODEL stubbed. Every other thing the step does runs:
 * codeline resolution, the estate survey, minting, the roster review loop, assignment, the
 * seam cross-reference, workflow validation, and the prompt build.
 *
 * The stub answers by recognising the prompt rather than counting calls, because an
 * order-indexed stub answers the wrong question while still looking green.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const STEP = join(ROOT, 'orchestrations/scripts/mint-agents-step.js');
const STUB = join(ROOT, 'test/fixtures/mock3/stub-ai-runner.sh');
const NODE = process.execPath;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'mintstep-'));
  const codeline = join(dir, 'codelines', 'mock-one');
  const logDir = join(dir, 'logs');
  const agentsDir = join(dir, 'agents');
  const projectDir = join(dir, 'project');
  for (const d of [codeline, logDir, agentsDir, projectDir]) mkdirSync(d, { recursive: true });

  // A real git repo with real source: the estate survey reads code, and a bare directory
  // would exercise a different path than any project ever runs.
  mkdirSync(join(codeline, 'src'), { recursive: true });
  writeFileSync(join(codeline, 'src', 'greet.ts'), 'export const greet = () => "hello";\n');
  const git = (args: string) => spawnSync('bash', ['-c', `git -C ${JSON.stringify(codeline)} ${args}`], { encoding: 'utf8' });
  git('init -q -b main .'); git('config user.email t@t'); git('config user.name t');
  git('add -A'); git('commit -qm base');

  // THE ENGINE'S CANONICAL ROSTER, which is what pre-run-reset restores for every project.
  // A hand-written one-role roster failed validateWorkflow for a reason no real run has:
  // the writer requires 'verification-criteria', produced by the ac-elaboration seam, and a
  // stub roster contains no agent that resolves to it. The guard was right; the fixture lied.
  const profiles = join(agentsDir, 'profiles.json');
  const canonical = readFileSync(join(ROOT, 'orchestrations/agents/profiles.json.original'));
  writeFileSync(profiles, canonical);
  writeFileSync(join(agentsDir, 'profiles.json.original'), canonical);
  // THE ENGINE'S OWN REGISTRY, not an invented one. A stub registry with no seamPatterns
  // fails the cross-reference for reasons no real project has, and would have sent me
  // "fixing" a guard that was working correctly. Every project uses this file as shipped.
  writeFileSync(join(agentsDir, 'invocation-profiles.json'),
    readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json')));

  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    project: { name: 'sandbox', description: 'a sandbox project' },
    stories: [{
      id: 'SBX-1', jiraKey: 'SBX-1', title: 'Change the greeting',
      description: 'The greeting should say something else.',
      status: 'pending', completed: false, codelines: ['mock-one'],
      acceptanceCriteria: ['the greeting changes'],
    }],
    implementationOrder: { core: ['SBX-1'] },
  }, null, 2));

  return { dir, codeline, logDir, agentsDir, projectDir, profiles, prd };
}

function runStep(s: ReturnType<typeof sandbox>, env: Record<string, string> = {}) {
  const res = spawnSync(NODE, [
    STEP,
    '--prd', s.prd,
    '--agents-dir', s.agentsDir,
    '--profiles', s.profiles,
    '--log-dir', s.logDir,
    '--codeline-root', join(s.dir, 'codelines'),
  ], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      AI_RUNNER_CMD: STUB,
      EPAM_PROJECT_CONFIG_DIR: s.projectDir,
      JIRA_CODELINES: 'mock-one',
      JIRA_WORKTREE_MOCK_ONE: s.codeline,
      EPAM_ORCHESTRATION_PROVIDER: 'openrouter',
      // HOW THIS PROJECT PROVISIONS ITS PROMPTS. A project fact with no engine default: the
      // engine used to pick 'generate' for everyone silently, which meant a copy-mode project
      // was regenerated on every mint. The sandbox exercises generate, because that is the path
      // where the builder agent has to read a template and specialise it.
      EPAM_PROMPT_PROVISION_MODE: 'generate',
      PROJECT_ROOT: s.codeline,
      LOG_DIR: s.logDir,
      TZ: 'UTC',
      ...env,
    },
  });
  return { status: res.status, out: `${res.stdout || ''}\n${res.stderr || ''}` };
}

const installed = (s: ReturnType<typeof sandbox>) => {
  const d = join(s.projectDir, 'prompts');
  return existsSync(d) ? readdirSync(d).sort() : [];
};

describe('the mint step builds prompts as part of minting', () => {
  it('provisions the project prompts directory', () => {
    const s = sandbox();
    try {
      const r = runStep(s);
      expect(r.out).toMatch(/prompts provisioned/);
      expect(installed(s).length, `no prompts installed:\n${r.out.slice(-3000)}`).toBeGreaterThan(0);
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('copies the bootstrap prompts verbatim and generates the rest', () => {
    const s = sandbox();
    try {
      runStep(s);
      const boot = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/bootstrap.json'), 'utf8'));
      for (const id of boot.copyVerbatim) {
        // The PROMPT TEXT is verbatim; the file is not, because a project copy also records
        // which template it came from. Without that provenance a later template edit is
        // invisible — the project keeps running the older prompt while the template claims
        // otherwise — so the copy carries metadata the template does not.
        const tpl = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates', `${id}.json`), 'utf8'));
        const cp = JSON.parse(readFileSync(join(s.projectDir, 'prompts', `${id}.json`), 'utf8'));
        expect(cp.body ?? cp.bodies, `${id}: the prompt text was altered by copying`)
          .toEqual(tpl.body ?? tpl.bodies);
        expect(cp.derivedFromSha256, `${id} records no origin`).toBeTruthy();
        expect(cp.authority, `${id} is not marked project authority`).toBe('project');
      }
      for (const id of boot.generated) {
        const p = JSON.parse(readFileSync(join(s.projectDir, 'prompts', `${id}.json`), 'utf8'));
        expect(p.authority, `${id} is not project authority`).toBe('project');
        expect(p.derivedFromSha256, `${id} has no provenance`).toBeTruthy();
      }
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('every installed prompt actually RENDERS through prompt-library', () => {
    // The only test that matters at run time: a prompt that cannot render is a prompt that
    // throws at the seam that needed it, hours later.
    const s = sandbox();
    try {
      runStep(s);
      const lib = join(ROOT, 'orchestrations/scripts/lib/prompt-library.js');
      for (const file of installed(s)) {
        const id = file.replace(/\.json$/, '');
        const doc = JSON.parse(readFileSync(join(s.projectDir, 'prompts', file), 'utf8'));
        const values: Record<string, string> = {};
        for (const p of doc.placeholders || []) values[p] = `[v:${p.replace(/_/g, '').toLowerCase()}]`;
        const vf = join(s.dir, `values-${id}.json`);
        writeFileSync(vf, JSON.stringify(values));
        const res = spawnSync(NODE, [lib, 'render', id, s.projectDir, vf], { encoding: 'utf8' });
        expect(res.status, `${id} does not render: ${res.stderr}`).toBe(0);
        expect((res.stdout || '').trim().length, `${id} rendered empty`).toBeGreaterThan(0);
      }
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('FAILS the step when the project does not say HOW to provision', () => {
    // No default. Choosing for the project silently is how metrolinx -- whose prompts are meant
    // to stay the generic text -- would have had its library regenerated on its next mint,
    // with nothing in the log to say the prompts had changed.
    const s = sandbox();
    try {
      const r = runStep(s, { EPAM_PROMPT_PROVISION_MODE: '' });
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/EPAM_PROMPT_PROVISION_MODE/);
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('the builder is invoked WITH its tool grant, not merely granted one in the registry', () => {
    // The registry could declare read_file and the invocation still pass {}, which is what it
    // did: the builder inherited whatever the mint process happened to have. A grant that never
    // reaches the call is the same defect as a ladder that resolves to nothing -- it reads as
    // configuration and does nothing. The stub records the environment it was called with.
    const s = sandbox();
    try {
      runStep(s);
      // THE BUILDER'S OWN INVOCATION, not any line in a shared log. Every agent in the run
      // writes to this file and the mint itself is granted read_file, so a whole-file match
      // passed even with the wiring removed — it was reading somebody else's grant. Verified by
      // mutation: this assertion goes red when the invocation drops back to {}.
      const blocks = readFileSync(join(s.logDir, 'stub-env.txt'), 'utf8')
        .split(/(?=AGENT=)/)
        .filter((b) => /^AGENT=prompt-builder\b/.test(b.trim()));
      expect(blocks.length, 'the prompt-builder never ran, so its grant is untested').toBeGreaterThan(0);
      const own = blocks.join('\n');
      expect(own, 'the prompt-builder was invoked with no tool grant').toMatch(/EPAM_ALLOWED_TOOLS=[^\n]*read_file/);
      expect(own, 'the tool channel was never opened, so the grant is inert').toMatch(/AI_GATE_ALLOW_TOOLS=1/);
      expect(own, 'the builder has a read grant but was never told where the templates are')
        .toMatch(/EPAM_PROMPT_TEMPLATES_DIR=\S/);
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('links every minted agent to the prompt it will run on', () => {
    // The step the operator asked for: provisioning and minting used to know nothing about each
    // other, so whether a minted agent's seam had a prompt in THIS project was discovered at
    // that agent's first invocation, hours into the run.
    const s = sandbox();
    try {
      const r = runStep(s);
      expect(r.out, `prompts were never linked:\n${r.out.slice(-2000)}`).toMatch(/prompts linked/);
      const link = JSON.parse(readFileSync(join(s.projectDir, 'prompt-agent-link.json'), 'utf8'));
      const agents = Object.keys(link.agents);
      expect(agents.length, 'nothing was linked').toBeGreaterThan(0);
      for (const a of agents) {
        expect(link.agents[a].seam, `${a} linked to no seam`).toBeTruthy();
        expect(link.agents[a].prompts.length, `${a} enters at a seam with no prompt`).toBeGreaterThan(0);
      }
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('FAILS the step when there is nowhere to install them', () => {
    // No project dir means no project authority, and the template is never executed. Guessing
    // a location would provision a project nobody asked for.
    const s = sandbox();
    try {
      const r = runStep(s, { EPAM_PROJECT_CONFIG_DIR: '' });
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/EPAM_PROJECT_CONFIG_DIR/);
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });
});
