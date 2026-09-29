/**
 * THE POST-PHASE ASSESSMENT IS ITS OWN SEAM — NO TOOLS, ITS OWN AUTHORED INSTRUCTIONS.
 *
 * Found by the £0 greenfield rehearsal on codemie-web, 2026-09-29: lib/phase-assessment.sh called the
 * post-phase assessment as "team-lead-agent", which the registry resolves to the estimator's seam —
 * so the skill assessor ran on the estimator's grant and ladder, and its CodeMie assistant was
 * handed the estimator's instructions ("Produces the cost/effort estimate for a story"). Operator
 * decision: the post-phase judgment gets a seam of its own with NO tools — it judges pre-computed
 * evidence and the engine applies its answer — rather than borrowing phase-assessment, whose grant
 * writes files.
 *
 * Executed: the REAL run_phase_assessment (lib/phase-assessment.sh) over a fixture phase, its prompt
 * rendered by the real engine; its model call goes through the real llm-handler.sh on the
 * codemie-web set against CodeMie stood in for, after the real si-author/si-review CLI has authored
 * the instructions. Nothing about the seam is named here: it is the seam the post-phase template
 * declares, and the call is judged by what CodeMie stored and what the model was handed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockAgent } from '../../mock-agent/agent';
import { MockCodeMie } from '../../mock-agent/codemie';
import { builtPythonEnv } from '../../mock-agent/python-env';
import { World } from '../../mock-agent/world';
import { correct } from '../../mock-agent/seams';
import { engineSource } from '../../lib/engine-source';
import { mintProjectPrompts, cleanupProjectPrompts } from '../../helpers/project-prompts';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const AGENTS = join(ROOT, 'orchestrations/agents');
const CLI = join(SCRIPTS, 'lib/assistant-instructions.js');
const HANDLER = join(SCRIPTS, 'llm-handler.sh');
const CODEMIE = (() => { try { return execSync('command -v codemie', { encoding: 'utf8', shell: '/bin/bash' }).trim(); } catch { return ''; } })();
const reg = JSON.parse(readFileSync(join(AGENTS, 'invocation-profiles.json'), 'utf8'));
const byProduce = (k: string) => Object.keys(reg.profiles).find((s) => reg.profiles[s].produces === k)!;
const AUTHOR = byProduce('assistant-instructions');
const REVIEW = byProduce('instructions-review');
/** The template the post-phase call renders — read from the call site's own function. */
const FN = (() => {
  const lines = engineSource(join(SCRIPTS, 'lib/phase-assessment.sh')).split('\n');
  const start = lines.findIndex((l) => l === 'run_phase_assessment() {');
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return lines.slice(start, end + 1).join('\n');
})();
const TEMPLATE = (FN.match(/render_engine_prompt ([a-z0-9-]+) "\$_cp_vals"/) || [])[1] || '';
const DECLARED: string[] = TEMPLATE ? JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates', `${TEMPLATE}.json`), 'utf8')).seams || [] : [];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveSeam, registryPath } = require(join(SCRIPTS, 'lib/seam-invocation.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toolGrantFor } = require(join(SCRIPTS, 'lib/agent-tools.js'));
const ladderModels = () => JSON.parse(execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(join(SCRIPTS, 'lib/handlers/ladder-models.js'))}`, { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: 'codemie-web' } }));

let dir = ''; let agents = ''; let project = ''; let codeline = ''; let venv = ''; let agent: MockAgent; let cm: MockCodeMie;
let calledAs = ''; let calledSeam = ''; let run: { status: number | null; out: string };

const env = () => ({
  ...process.env as Record<string, string>, EPAM_PROVIDER_SET: 'codemie-web', NODE_BIN: process.execPath,
  EPAM_CODEMIE_WEB_URL: agent.url, EPAM_CODEMIE_PLUGIN_ENGINE_URI: cm.engineUri, EPAM_CODEMIE_WEB_HOME: join(dir, 'home'),
  EPAM_CODEMIE_PLUGINS_VENV: venv, EPAM_AGENTS_DIR: agents, EPAM_PROJECT_CONFIG_DIR: project, PROJECT_NAME: 'post-phase',
  EPAM_BROWNFIELD: '0', OUTPUT_DIR: codeline, PROJECT_ROOT: codeline, LOG_DIR: join(dir, 'logs'), EPAM_CODELINE: 'cl',
  EPAM_ORCHESTRATION_PROVIDER: 'codemie-web', EPAM_CALL_MAX_ATTEMPTS: '1', EPAM_CONTENT_RETRY_ATTEMPTS: '1', SEAM_MAX_RETRIES: '0',
  EPAM_DANGEROUS_SKIP_APPROVAL: '1', EPAM_TIMEOUT_SECS: '180', EPAM_PLAN_EXECUTE: '0', AI_MODEL: ladderModels()[0], EPAM_MAX_TOOL_CALLS: '0',
});
const exec = (args: string[], input = '') => new Promise<{ status: number | null; out: string }>((resolve) => {
  const p = spawn(args[0], args.slice(1), { cwd: dir, env: env() });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.stdin.end(input);
  p.on('close', (status) => resolve({ status, out }));
});
const artefact = (seam: string) => {
  const f = join(project, 'assistant-instructions', `${seam.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).rendered as string : '';
};

describe.skipIf(!CODEMIE)('the post-phase assessment runs as its own seam', () => {
  beforeAll(async () => {
    expect(FN, 'run_phase_assessment was not found').toContain('run_orch_prompt');
    expect(TEMPLATE, 'the post-phase call renders no template').not.toBe('');
    dir = mkdtempSync(join(tmpdir(), 'post-phase-'));
    // The project's own prompt copies, as a project has them — the post-phase prompt is project-layer.
    agents = join(dir, 'agents'); project = mintProjectPrompts(); codeline = join(dir, 'codeline');
    for (const d of [agents, codeline, join(dir, 'logs'), join(dir, 'cap')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(codeline, 'README.md'), 'a codeline\n');
    execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: codeline, shell: '/bin/bash' });
    // The call site's own agent name, captured by running the function with a recorder in its place
    // first — so the registry below keeps exactly the seams this call and its template could reach.
    const agentName = (FN.match(/run_orch_prompt "\$_pa_prompt" "([^"]+)"/) || [])[1] || '';
    calledSeam = resolveSeam(agentName, registryPath(AGENTS));
    const keep = new Set([AUTHOR, REVIEW, calledSeam, ...DECLARED]);
    for (const f of readdirSync(AGENTS)) if (f.endsWith('.json')) copyFileSync(join(AGENTS, f), join(agents, f));
    writeFileSync(join(agents, 'invocation-profiles.json'), JSON.stringify({ ...reg, profiles: Object.fromEntries(Object.entries(reg.profiles).filter(([k]) => keep.has(k))) }, null, 2));

    agent = new MockAgent(join(ROOT, 'orchestrations'), join(dir, 'journal'));
    agent.on('*', correct(new World(() => [codeline], () => join(dir, 'prd.json'), project), ROOT));
    await agent.start();
    cm = await new MockCodeMie(agent, join(dir, 'journal'), ladderModels()).start();
    venv = builtPythonEnv(ROOT, 'codemie-web')!.env;
    const authored = await exec([process.execPath, CLI]);
    expect(authored.status, authored.out.slice(-2000)).toBe(0);

    // A finished phase: one story done, its cost recorded.
    writeFileSync(join(dir, 'prd.json'), JSON.stringify({ stories: [{ id: 'S-1', title: 'one', description: 'build the parser', agentRole: 'engineer', passes: true }] }));
    writeFileSync(join(dir, 'logs', 'phase-cost.jsonl'), `${JSON.stringify({ phase_id: 'p1', story_id: 'S-1', started_at: '2026-09-29T10:00:00', agent_role: 'engineer' })}\n`);
    const script = [
      'set -u',
      'info() { :; }; log() { :; }; success() { :; }; warning() { echo "WARN: $*" >&2; }; error() { echo "ERROR: $*" >&2; }',
      '_build_skill_domain_guidance() { :; }',
      `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; PRD_FILE=${JSON.stringify(join(dir, 'prd.json'))}; PHASE_ASSESSMENT_TIMEOUT_SECS=180; EPAM_GATE_TIMEOUT_SECS=180`,
      `source ${JSON.stringify(join(SCRIPTS, 'lib/jq-vals.sh'))}`,
      `source ${JSON.stringify(join(SCRIPTS, 'lib/render-engine-prompt.sh'))}`,
      // The model call itself: what the engine's run_orch_prompt does on this set — the prompt, under
      // the agent name the call site passes, through the real handler.
      `run_orch_prompt() { printf '%s' "$2" > ${JSON.stringify(join(dir, 'cap', 'agent'))}; printf '%s' "$1" | EPAM_AGENT_NAME="$2" bash ${JSON.stringify(HANDLER)} --provider codemie-web; }`,
      FN,
      'run_phase_assessment p1',
    ].join('\n');
    run = await exec(['bash', '-c', script]);
    calledAs = existsSync(join(dir, 'cap', 'agent')) ? readFileSync(join(dir, 'cap', 'agent'), 'utf8') : '';
  }, 900_000);
  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    if (dir) require(join(ROOT, 'orchestrations/plugins/providers/codemie-web/plugins.js')).stopAll({ ...process.env, EPAM_CODEMIE_WEB_HOME: join(dir, 'home') });
    await cm?.stop(); await agent?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); cleanupProjectPrompts();
  });

  it('the call is made, and resolves to the seam its template declares', () => {
    expect(calledAs, `the assessment never called a model:\n${run.out.slice(-1500)}`).not.toBe('');
    expect(DECLARED.length, `${TEMPLATE} declares no seam`).toBe(1);
    expect(resolveSeam(calledAs, registryPath(AGENTS)), `"${calledAs}" resolves to another seam's grant, ladder and instructions`).toBe(DECLARED[0]);
  });

  it('that seam has no tools: it judges pre-computed evidence, and the engine applies its answer', () => {
    expect(reg.profiles[DECLARED[0]].toolGrant).toBe('none');
    expect(toolGrantFor(reg.profiles[DECLARED[0]].toolGrant, [codeline]), 'a no-tool seam was granted tools').toBe('');
    const a = cm.assistants.find((x) => x.name === `Pipeline cl ${DECLARED[0]}`) as any;
    expect(a, `no assistant for ${DECLARED[0]}: ${cm.assistants.map((x) => x.name).join(', ')}`).toBeTruthy();
    expect((a.toolkits || []).length, 'its assistant is bound to a plugin').toBe(0);
  });

  it('its assistant stores its own authored instructions, and the model is handed them — no other seam\'s', () => {
    const own = artefact(DECLARED[0]);
    expect(own, `${DECLARED[0]} was never authored`).not.toBe('');
    const a = cm.assistants.find((x) => x.name === `Pipeline cl ${DECLARED[0]}`) as any;
    expect(a.system_prompt).toBe(own);
    const call = agent.calls.filter((c) => c.template === TEMPLATE).pop();
    expect(call, 'the model never received the assessment').toBeTruthy();
    expect(call!.req.system.trim()).toBe(own);
    for (const other of [...new Set([calledSeam, ...Object.keys(reg.profiles)])].filter((s) => s !== DECLARED[0])) {
      const text = artefact(other);
      if (text) expect(call!.req.system.trim(), `the assessment was handed ${other}'s instructions`).not.toBe(text);
    }
  });

  it('the assessment completes and its record is written', () => {
    expect(run.status, run.out.slice(-1500)).toBe(0);
    expect(existsSync(join(dir, 'logs', 'phase-skill-assessments.jsonl')), run.out.slice(-1500)).toBe(true);
  });
});
