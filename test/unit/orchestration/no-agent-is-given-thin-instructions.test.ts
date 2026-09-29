/**
 * NO AGENT IS GIVEN THIN INSTRUCTIONS — EVERY SEAM SPEAKS AS A DECLARED, FULL PERSONA.
 *
 * Operator, 2026-09-29, on the codemie-web assistants of the AMSD-2974 run: agent-mint's system
 * instructions were its one-line description ("Proposes the roster of agents this project needs…").
 * "We cannot have thin SI." 26 of the 41 seams declared no persona: their identity was written inline
 * in their task template, where nothing could read it, so the assistant got the description alone.
 *
 * THIN, DEFINED WITHOUT A NUMBER: an agent's instructions are thin when they do not carry that agent's
 * whole declared persona. So, for EVERY seam the registry declares (enumerated from the registry, not
 * listed here):
 *   1. it declares whose persona it speaks as (invocation-profiles.json `persona`);
 *   2. that persona resolves to text in the install's profiles — the stage before a roster exists;
 *   3. once si-author and si-review have run for a project (lib/assistant-instructions.js — the real
 *      CLI, in both modes, through the seam hub), a codemie-web call as that seam, through the real
 *      llm-handler.sh, stores an assistant whose system instructions are the AUTHORED ones: the role
 *      line first, then every section of the layout (templates/assistant-instructions.json) with
 *      something in it — and the model is handed exactly those instructions. The two authoring seams
 *      are not authored by themselves: theirs are the role line, then their recorded persona in full.
 * The rehearsal drivers (test/mock-agent) assert the other half for every provider: every call a run
 * makes carries its seam's persona in what the model was sent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockAgent } from '../../mock-agent/agent';
import { MockCodeMie } from '../../mock-agent/codemie';
import { builtPythonEnv } from '../../mock-agent/python-env';
import { World } from '../../mock-agent/world';
import { correct } from '../../mock-agent/seams';

const ROOT = join(__dirname, '../../../');
const AGENTS = join(ROOT, 'orchestrations/agents');
const HANDLER = join(ROOT, 'orchestrations/scripts/llm-handler.sh');
const CLI = join(ROOT, 'orchestrations/scripts/lib/assistant-instructions.js');
const CODEMIE = (() => { try { return execSync('command -v codemie', { encoding: 'utf8', shell: '/bin/bash' }).trim(); } catch { return ''; } })();
const seams = JSON.parse(readFileSync(join(AGENTS, 'invocation-profiles.json'), 'utf8')).profiles as Record<string, { _what?: string; persona?: string }>;
const SEAMS = Object.keys(seams);
/** The two seams that author and review everyone else's — found by what they produce. */
const AUTHORING = SEAMS.filter((k) => ['assistant-instructions', 'instructions-review'].includes((seams[k] as any).produces));
const LAYOUT = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/assistant-instructions.json'), 'utf8')).bodies.authored as string;
const HEADINGS = LAYOUT.split('\n').filter((l) => l.startsWith('## '));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { agentPersona } = require(join(ROOT, 'orchestrations/scripts/lib/agent-roster.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ladderModels } = { ladderModels: () => JSON.parse(execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/handlers/ladder-models.js'))}`, { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: 'codemie-web' } })) };

/** A persona as the pipeline resolves it for a seam before any project roster exists. */
const personaOf = (seam: string) => String(agentPersona(seams[seam].persona || '', AGENTS, '') || '').trim();

describe('every seam declares a full persona', () => {
  it('the registry has seams to check — otherwise nothing below means anything', () => {
    expect(SEAMS.length).toBeGreaterThan(10);
  });

  it.each(SEAMS)('%s declares whose persona it speaks as', (seam) => {
    expect(seams[seam].persona, `${seam} declares no persona — its instructions would be its description alone`).toBeTruthy();
  });

  it.each(SEAMS)('%s: the agent it speaks as resolves to a seam — the mint refuses one that resolves to none', (seam) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveSeam, registryPath } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));
    const who = seams[seam].persona || '';
    const back = (() => { try { return resolveSeam(who, registryPath(AGENTS)); } catch (e) { return `none (${(e as Error).message.slice(0, 80)})`; } })();
    expect(Object.keys(seams), `'${who}' resolves to ${back}`).toContain(back);
  });

  it.each(SEAMS)('%s: that persona resolves to text in the install\'s profiles', (seam) => {
    expect(personaOf(seam), `${seam} speaks as '${seams[seam].persona}', which the profiles do not carry`).not.toBe('');
  });
});

let dir = ''; let project = ''; let codeline = ''; let venv = ''; let agent: MockAgent; let cm: MockCodeMie; let lastSystem = '';

const env = (extra: Record<string, string> = {}) => ({
  ...process.env as Record<string, string>, EPAM_PROVIDER_SET: 'codemie-web', NODE_BIN: process.execPath,
  EPAM_CODEMIE_WEB_URL: agent.url, EPAM_CODEMIE_PLUGIN_ENGINE_URI: cm.engineUri, EPAM_CODEMIE_WEB_HOME: join(dir, 'home'),
  EPAM_CODEMIE_PLUGINS_VENV: venv, EPAM_CODELINE: 'cl', PROJECT_ROOT: codeline, OUTPUT_DIR: codeline, LOG_DIR: join(dir, 'logs'),
  EPAM_AGENTS_DIR: AGENTS, EPAM_PROJECT_CONFIG_DIR: project, PROJECT_NAME: 'thin-si', EPAM_ORCHESTRATION_PROVIDER: 'codemie-web',
  EPAM_CALL_MAX_ATTEMPTS: '1', EPAM_CONTENT_RETRY_ATTEMPTS: '1', SEAM_MAX_RETRIES: '0', EPAM_DANGEROUS_SKIP_APPROVAL: '1',
  AI_MODEL: ladderModels()[0], EPAM_MAX_TOOL_CALLS: '0', EPAM_TIMEOUT_SECS: '180', EPAM_PLAN_TIMEOUT_SECS: '90', EPAM_PLAN_EXECUTE: '0',
  ...extra,
});
const run = (args: string[], extra: Record<string, string>, input = '') => new Promise<{ status: number | null; stderr: string }>((resolve) => {
  const p = spawn(args[0], args.slice(1), { cwd: dir, env: env(extra) });
  let stderr = ''; p.stderr.on('data', (d) => { stderr += d; });
  p.stdin.end(input);
  p.on('close', (status) => resolve({ status, stderr }));
});
const artefactPath = (seam: string) => join(project, 'assistant-instructions', `${seam.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
/** Each layout section's own text: what lies between its heading and the next. */
const sections = (text: string) => HEADINGS.map((h, i) => {
  const from = text.indexOf(h); const to = i + 1 < HEADINGS.length ? text.indexOf(HEADINGS[i + 1]) : text.length;
  return { h, body: from < 0 ? '' : text.slice(from + h.length, to).trim() };
});

describe.skipIf(!CODEMIE)('a codemie-web assistant carries its seam\'s authored instructions', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'thin-si-'));
    project = join(dir, 'project'); codeline = join(dir, 'codeline');
    for (const d of [project, codeline, join(dir, 'logs')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(codeline, 'README.md'), 'a codeline\n');
    execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: codeline, shell: '/bin/bash' });
    // The brownfield pass reads the codelines the discovery chose, as a run's does.
    writeFileSync(join(dir, 'logs', 'codeline-discovery.json'), JSON.stringify({ codelines: [{ name: 'cl', path: codeline }] }));
    agent = new MockAgent(join(ROOT, 'orchestrations'), join(dir, 'journal'));
    const good = correct(new World(() => [codeline], () => join(dir, 'prd.json'), project), ROOT);
    agent.on('*', (c, a) => { lastSystem = c.req.system.trim(); return good(c, a); });
    await agent.start();
    cm = await new MockCodeMie(agent, join(dir, 'journal'), ladderModels()).start();
    venv = builtPythonEnv(ROOT, 'codemie-web')!.env;
    for (const brownfield of ['0', '1']) {
      const r = await run([process.execPath, CLI], { EPAM_BROWNFIELD: brownfield });
      expect(r.status, r.stderr.slice(-2000)).toBe(0);
    }
    // What follows only asks what each assistant was given, so its model just acknowledges — as a
    // JSON object, since a seam whose contract is JSON is not answered in prose.
    agent.on('*', (c) => { lastSystem = c.req.system.trim(); return { kind: 'text', text: '{"ok": true}' }; });
  }, 1_800_000);
  afterAll(async () => { await cm?.stop(); await agent?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('the authoring seams were found, and the layout has sections to check', () => {
    expect(AUTHORING.length).toBe(2);
    expect(HEADINGS.length).toBeGreaterThan(3);
  });

  it.each(SEAMS)('%s: the stored instructions are the role line, then every section filled — and the model gets them', async (seam) => {
    lastSystem = '';
    const r = await run(['bash', HANDLER, '--provider', 'codemie-web'], { EPAM_AGENT_NAME: seam }, 'Do the task.');
    expect(r.status, r.stderr.slice(-1200)).toBe(0);
    const a = cm.assistants.find((x) => x.name === `Pipeline cl ${seam}`) as any;
    expect(a, `no assistant for ${seam}: ${cm.assistants.map((x) => x.name).join(', ')}`).toBeTruthy();
    const si = String(a.system_prompt);
    expect(si.startsWith(`**Role:** ${seams[seam]._what}`), 'the one-line role comes first').toBe(true);
    expect(si.trim(), 'the instructions are the description alone').not.toBe(String(seams[seam]._what || '').trim());
    if (AUTHORING.includes(seam)) {
      expect(existsSync(artefactPath(seam)), 'an authoring seam authored itself').toBe(false);
      expect(si).toContain(personaOf(seam));
    } else {
      expect(existsSync(artefactPath(seam)), `${seam} was never authored`).toBe(true);
      expect(si).toBe(JSON.parse(readFileSync(artefactPath(seam), 'utf8')).rendered);
      for (const { h, body } of sections(si)) expect(body, `${seam}: "${h}" is empty`).not.toBe('');
    }
    expect(lastSystem, `the model was not handed ${seam}'s instructions`).toBe(si.trim());
  }, 180_000);
});
