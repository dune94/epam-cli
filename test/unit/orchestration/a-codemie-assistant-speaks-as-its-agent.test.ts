/**
 * A CODEMIE ASSISTANT'S SYSTEM INSTRUCTIONS ARE ITS AGENT'S OWN — ITS GENERATED PERSONA AND ITS
 * DESCRIPTION — AND FOLLOW THEM WHEN THEY CHANGE.
 *
 * Operator, 2026-09-29, on the roster-review assistant: "system instructions appear very ineffective
 * — for roster review I would have expected more elaboration. Is this the case for all agents?" It
 * was: every assistant carried one engine literal (registry.js PERSONA, "You are an agent of an
 * automated software delivery pipeline…"). Each seam now DECLARES whose persona it speaks as
 * (agents/invocation-profiles.json `persona`) — the name its call site used to spell out — and the
 * assistant's instructions are that agent's generated persona (the project roster once it exists,
 * the install's profiles before) followed by the seam's description (`_what`); a changed persona
 * updates the stored assistant.
 *
 * Executed: the real llm-handler.sh on the codemie-web set against CodeMie stood in for
 * (test/mock-agent/codemie.ts), which records what each assistant was created or updated with, and
 * hands its system prompt to the model as the system message.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockAgent } from '../../mock-agent/agent';
import { MockCodeMie } from '../../mock-agent/codemie';

const ROOT = join(__dirname, '../../../');
const HANDLER = join(ROOT, 'orchestrations/scripts/llm-handler.sh');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const CODEMIE = (() => { try { return execSync('command -v codemie', { encoding: 'utf8', shell: '/bin/bash' }).trim(); } catch { return ''; } })();
const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8'];
const seams = JSON.parse(readFileSync(REGISTRY, 'utf8')).profiles as Record<string, { _what: string; persona?: string }>;

/** A seam that declares a persona — read from the registry, not named here. Every seam declares one
 *  (no-agent-is-given-thin-instructions proves that for all of them). */
const WITH = Object.keys(seams).find((k) => seams[k].persona && !k.includes(':'))!;

let dir = ''; let agents = ''; let agent: MockAgent; let cm: MockCodeMie; const systems: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'codemie-si-'));
  agents = join(dir, 'agents'); mkdirSync(agents);
  copyFileSync(REGISTRY, join(agents, 'invocation-profiles.json'));
  mkdirSync(join(dir, 'codeline'));
  agent = new MockAgent(join(ROOT, 'orchestrations'), join(dir, 'journal'));
  agent.on('*', (c) => { systems.push(c.req.system.trim()); return { kind: 'text', text: 'OK' }; });
  await agent.start();
  cm = await new MockCodeMie(agent, join(dir, 'journal'), MODELS).start();
}, 300_000);
afterAll(async () => { await cm?.stop(); await agent?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const profiles = (map: Record<string, string>) => writeFileSync(join(agents, 'profiles.json'), JSON.stringify(map));

function call(agentName: string, extra: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const p = spawn('bash', [HANDLER, '--provider', 'codemie-web'], {
      cwd: dir,
      env: {
        ...process.env as Record<string, string>, EPAM_PROVIDER_SET: 'codemie-web', NODE_BIN: process.execPath,
        EPAM_CODEMIE_WEB_URL: agent.url, EPAM_CODEMIE_PLUGIN_ENGINE_URI: cm.engineUri, EPAM_CODEMIE_WEB_HOME: join(dir, 'home'),
        EPAM_CODELINE: 'shop-web', PROJECT_ROOT: join(dir, 'codeline'), LOG_DIR: join(dir, 'logs'), EPAM_AGENTS_DIR: agents,
        EPAM_CALL_MAX_ATTEMPTS: '1', EPAM_DANGEROUS_SKIP_APPROVAL: '1', AI_MODEL: 'claude-sonnet-5', EPAM_MAX_TOOL_CALLS: '0',
        EPAM_TIMEOUT_SECS: '120', EPAM_PLAN_TIMEOUT_SECS: '90', EPAM_PLAN_EXECUTE: '0', EPAM_AGENT_NAME: agentName, ...extra,
      },
    });
    let stderr = ''; p.stderr.on('data', (d) => { stderr += d; });
    p.stdin.end('Do the task.');
    p.on('close', (status) => resolve({ status, stderr }));
  });
}
const stored = (agentName: string) => cm.assistants.find((a) => a.name === `Pipeline shop-web ${agentName}`) as any;

describe.skipIf(!CODEMIE)('a codemie assistant speaks as its agent', () => {
  it('the registry has a seam to prove this on', () => {
    expect(WITH, 'no seam declares a persona').toBeTruthy();
  });

  it('a seam that declares a persona: the assistant carries that agent\'s generated persona, then the seam\'s description', async () => {
    const who = seams[WITH].persona!;
    profiles({ [who]: `PERSONA-OF-${who}-v1: you judge with care.`, 'some-other-agent': 'OTHER-PERSONA-must-not-appear' });
    const r = await call(WITH);
    expect(r.status, r.stderr.slice(-1500)).toBe(0);
    const a = stored(WITH);
    expect(a, cm.assistants.map((x) => x.name).join(', ')).toBeTruthy();
    expect(a.system_prompt).toContain(`PERSONA-OF-${who}-v1: you judge with care.`);
    expect(a.system_prompt).toContain(seams[WITH]._what);
    expect(a.system_prompt.indexOf('PERSONA-OF')).toBeLessThan(a.system_prompt.indexOf(seams[WITH]._what));
    expect(a.system_prompt).not.toContain('OTHER-PERSONA-must-not-appear');
    expect(a.system_prompt).not.toMatch(/You are an agent of an automated software delivery pipeline/);
    expect(a.description).toBe(seams[WITH]._what);
    expect(systems[systems.length - 1], 'the model was not handed the assistant\'s instructions').toBe(a.system_prompt.trim());
  });

  it('when the persona changes, the stored assistant is updated — the next chat speaks with the new one', async () => {
    const who = seams[WITH].persona!;
    const id = stored(WITH).id;
    profiles({ [who]: `PERSONA-OF-${who}-v2: sharper.` });
    const r = await call(WITH);
    expect(r.status, r.stderr.slice(-1500)).toBe(0);
    const a = stored(WITH);
    expect(a.id).toBe(id);                                   // updated in place, not duplicated
    expect(cm.assistants.filter((x) => x.name === a.name)).toHaveLength(1);
    expect(a.system_prompt).toContain(`PERSONA-OF-${who}-v2: sharper.`);
    expect(a.system_prompt).not.toContain('-v1');
    expect(systems[systems.length - 1]).toContain('-v2: sharper.');
  });

  it('once the project roster carries the agent, its persona is the roster\'s', async () => {
    const who = seams[WITH].persona!;
    const cfg = join(dir, 'project'); mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'roster.json'), JSON.stringify({ agents: { [who]: { persona: `ROSTER-PERSONA-OF-${who}`, kind: 'seam' } } }));
    const r = await call(WITH, { EPAM_PROJECT_CONFIG_DIR: cfg });
    expect(r.status, r.stderr.slice(-1500)).toBe(0);
    expect(stored(WITH).system_prompt).toContain(`ROSTER-PERSONA-OF-${who}`);
    expect(stored(WITH).system_prompt).not.toContain('-v2: sharper.');
  });
});
