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
 *   3. a codemie-web call as that seam, through the real llm-handler.sh, stores an assistant whose
 *      system instructions carry the persona in full, then the seam's description — and the model is
 *      handed exactly those instructions.
 * The rehearsal drivers (test/mock-agent) assert the other half for every provider: every call a run
 * makes carries its seam's persona in what the model was sent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockAgent } from '../../mock-agent/agent';
import { MockCodeMie } from '../../mock-agent/codemie';

const ROOT = join(__dirname, '../../../');
const AGENTS = join(ROOT, 'orchestrations/agents');
const HANDLER = join(ROOT, 'orchestrations/scripts/llm-handler.sh');
const CODEMIE = (() => { try { return execSync('command -v codemie', { encoding: 'utf8', shell: '/bin/bash' }).trim(); } catch { return ''; } })();
const seams = JSON.parse(readFileSync(join(AGENTS, 'invocation-profiles.json'), 'utf8')).profiles as Record<string, { _what?: string; persona?: string }>;
const SEAMS = Object.keys(seams);
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

  it.each(SEAMS)('%s: that persona resolves to text in the install\'s profiles', (seam) => {
    expect(personaOf(seam), `${seam} speaks as '${seams[seam].persona}', which the profiles do not carry`).not.toBe('');
  });
});

let dir = ''; let agent: MockAgent; let cm: MockCodeMie; let lastSystem = '';

describe.skipIf(!CODEMIE)('a codemie-web assistant carries its seam\'s whole persona', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'thin-si-')); mkdirSync(join(dir, 'codeline'));
    agent = new MockAgent(join(ROOT, 'orchestrations'), join(dir, 'journal'));
    agent.on('*', (c) => { lastSystem = c.req.system.trim(); return { kind: 'text', text: 'OK' }; });
    await agent.start();
    cm = await new MockCodeMie(agent, join(dir, 'journal'), ladderModels()).start();
  }, 300_000);
  afterAll(async () => { await cm?.stop(); await agent?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  const call = (seam: string) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const p = spawn('bash', [HANDLER, '--provider', 'codemie-web'], {
      cwd: dir,
      env: {
        ...process.env as Record<string, string>, EPAM_PROVIDER_SET: 'codemie-web', NODE_BIN: process.execPath,
        EPAM_CODEMIE_WEB_URL: agent.url, EPAM_CODEMIE_PLUGIN_ENGINE_URI: cm.engineUri, EPAM_CODEMIE_WEB_HOME: join(dir, 'home'),
        EPAM_CODELINE: 'cl', PROJECT_ROOT: join(dir, 'codeline'), LOG_DIR: join(dir, 'logs'), EPAM_AGENTS_DIR: AGENTS,
        EPAM_PROJECT_CONFIG_DIR: '', EPAM_CALL_MAX_ATTEMPTS: '1', EPAM_DANGEROUS_SKIP_APPROVAL: '1', AI_MODEL: ladderModels()[0],
        EPAM_MAX_TOOL_CALLS: '0', EPAM_TIMEOUT_SECS: '120', EPAM_PLAN_TIMEOUT_SECS: '90', EPAM_PLAN_EXECUTE: '0', EPAM_AGENT_NAME: seam,
      },
    });
    let stderr = ''; p.stderr.on('data', (d) => { stderr += d; });
    p.stdin.end('Do the task.');
    p.on('close', (status) => resolve({ status, stderr }));
  });

  it.each(SEAMS)('%s: the stored instructions are its persona in full, then its description — and the model gets them', async (seam) => {
    lastSystem = '';
    const r = await call(seam);
    expect(r.status, r.stderr.slice(-1200)).toBe(0);
    const a = cm.assistants.find((x) => x.name === `Pipeline cl ${seam}`) as any;
    expect(a, `no assistant for ${seam}: ${cm.assistants.map((x) => x.name).join(', ')}`).toBeTruthy();
    const persona = personaOf(seam);
    expect(persona, `${seam} has no persona to carry`).not.toBe('');
    expect(a.system_prompt).toContain(persona);
    expect(a.system_prompt.startsWith(persona), 'the persona comes first').toBe(true);
    if (seams[seam]._what) expect(a.system_prompt).toContain(seams[seam]._what);
    expect(a.system_prompt.trim(), 'the instructions are the description alone').not.toBe(String(seams[seam]._what || '').trim());
    expect(lastSystem, `the model was not handed ${seam}'s instructions`).toBe(a.system_prompt.trim());
  }, 180_000);
});
