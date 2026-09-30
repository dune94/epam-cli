/**
 * A SEAM CALL ON THE CODEMIE-WEB SET IS A CHAT WITH THE OPERATOR'S OWN STORED ASSISTANT — and reaches
 * the codeline only through the plugin its grant binds.
 *
 * Operator, 2026-09-28: "I need the codemie web agent to work … Keep agents local, to my name only.
 * but use a common naming for agents 'Pipeline [codeline] [agent name]'." The proof is what CodeMie
 * was told and what landed on disk: the real llm-handler.sh on the codemie-web set, the real CodeMie
 * SDK, the real codemie-plugins process (the toolkit a live run uses), against CodeMie stood in for
 * (test/mock-agent/codemie.ts — its API and its plugin engine) with the mocking agent as the model.
 * £0; nothing reaches CodeMie.
 *
 * Skipped only when the CodeMie CLI (whose SDK the runner calls through) is not installed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockAgent, type Call } from '../../mock-agent/agent';
import { MockCodeMie } from '../../mock-agent/codemie';
import { builtPythonEnv } from '../../mock-agent/python-env';
import { newCallId, type Turn } from '../../mock-agent/wire';

const ROOT = join(__dirname, '../../../');
const HANDLER = join(ROOT, 'orchestrations/scripts/llm-handler.sh');
const RUNNER = join(ROOT, 'orchestrations/plugins/providers/codemie-web/runner.sh');
const CODEMIE = (() => { try { return execSync('command -v codemie', { encoding: 'utf8', shell: '/bin/bash' }).trim(); } catch { return ''; } })();
const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8'];

let dir = ''; let agent: MockAgent; let cm: MockCodeMie; let venv = ''; let codeline = '';

/**
 * A model that does what the prompt asks with the tools it is offered: "WRITE <file> <text>" through
 * the tool whose parameters say it writes, "READ <file>" through the one that reads; given the tools'
 * results, it reports them. Offered no such tool, it says so — as a model does.
 */
function obliging(call: Call): Turn {
  const prompt = call.req.messages.find((m) => m.role === 'user')?.text || '';
  const results = call.req.messages.filter((m) => m.role === 'tool').map((m) => m.text);
  if (results.length) return { kind: 'text', text: `TOOL-RESULTS: ${results.join(' | ')}` };
  const byParams = (re: RegExp[]) => call.req.tools.find((t) => { const p = Object.keys(t.params?.properties || {}); return re.every((r) => p.some((k) => r.test(k))); });
  const w = /WRITE (\S+) (\S+)/.exec(prompt); const r = /READ (\S+)/.exec(prompt);
  if (w) {
    const tool = byParams([/path/i, /content|text/i]);
    if (!tool) return { kind: 'text', text: 'NO-WRITE-TOOL' };
    const p = Object.keys(tool.params.properties);
    return { kind: 'tools', calls: [{ id: newCallId(), name: tool.name, input: { [p.find((k) => /path/i.test(k))!]: w[1], [p.find((k) => /content|text/i.test(k))!]: w[2] } }] };
  }
  if (r) {
    const tool = call.req.tools.find((t) => /read/i.test(t.name) && Object.keys(t.params?.properties || {}).some((k) => /path/i.test(k)));
    if (!tool) return { kind: 'text', text: 'NO-READ-TOOL' };
    return { kind: 'tools', calls: [{ id: newCallId(), name: tool.name, input: { [Object.keys(tool.params.properties).find((k) => /path/i.test(k))!]: r[1] } }] };
  }
  const q = /SEARCH (\S+) IN (\S+)/.exec(prompt);
  if (q) {
    const tool = byParams([/pattern/i, /dir|path/i]);
    if (!tool) return { kind: 'text', text: 'NO-SEARCH-TOOL' };
    const p = Object.keys(tool.params.properties);
    return { kind: 'tools', calls: [{ id: newCallId(), name: tool.name, input: { [p.find((k) => /pattern/i.test(k))!]: q[1], [p.find((k) => /dir|path/i.test(k))!]: q[2] } }] };
  }
  if (/SAY-NOTHING/.test(prompt)) return { kind: 'text', text: '' };
  return { kind: 'text', text: `ANSWER tools-offered=${call.req.tools.length}` };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'codemie-web-seam-'));
  codeline = join(dir, 'codeline'); mkdirSync(codeline);
  writeFileSync(join(codeline, 'sentinel.txt'), 'SENTINEL-CONTENT-7f3a');
  agent = new MockAgent(join(ROOT, 'orchestrations'), join(dir, 'journal'));
  agent.on('*', (c) => obliging(c));
  await agent.start();
  cm = await new MockCodeMie(agent, join(dir, 'journal'), MODELS).start();
  venv = CODEMIE ? builtPythonEnv(ROOT, 'codemie-web')!.env : '';
}, 900_000);
afterAll(async () => { await cm?.stop(); await agent?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const baseEnv = () => ({
  ...process.env as Record<string, string>, EPAM_PROVIDER_SET: 'codemie-web', NODE_BIN: process.execPath,
  EPAM_CODEMIE_WEB_URL: agent.url, EPAM_CODEMIE_PLUGIN_ENGINE_URI: cm.engineUri, EPAM_CODEMIE_WEB_HOME: join(dir, 'home'),
  EPAM_CODEMIE_PLUGINS_VENV: venv, EPAM_CODELINE: 'shop-web', PROJECT_ROOT: codeline, LOG_DIR: join(dir, 'logs'),
  EPAM_CALL_MAX_ATTEMPTS: '1', EPAM_DANGEROUS_SKIP_APPROVAL: '1', AI_MODEL: 'claude-sonnet-5',
  EPAM_TIMEOUT_SECS: '120', EPAM_PLAN_TIMEOUT_SECS: '90',
});

function call(prompt: string, env: Record<string, string>) {
  const out = join(dir, `result-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return new Promise<{ status: number | null; stdout: string; stderr: string; json: Record<string, any> }>((resolve) => {
    const p = spawn('bash', [HANDLER, '--provider', 'codemie-web'], { cwd: dir, env: { ...baseEnv(), ORCH_JSON_RESULT: out, ...env } });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.stdin.end(prompt);
    p.on('close', (status) => { let json = {}; try { json = JSON.parse(readFileSync(out, 'utf8')); } catch { /* none */ } resolve({ status, stdout, stderr, json }); });
  });
}

describe.skipIf(!CODEMIE)('a seam call on the codemie-web set', () => {
  it('is a chat with the operator\'s private assistant "Pipeline <codeline> <agent>", on the ladder\'s model; a call whose tool budget is 0 (the hub\'s plan pass) gets no tools', async () => {
    const r = await call('Summarise the plan.', { EPAM_AGENT_NAME: 'plan-reviewer', EPAM_MAX_TOOL_CALLS: '0' });
    expect(r.stderr, r.stderr.slice(-1500)).not.toMatch(/call failed/);
    expect(r.status, r.stderr.slice(-2000)).toBe(0);
    expect(r.stdout).toContain('ANSWER tools-offered=0');
    expect(r.json).toMatchObject({ type: 'result', is_error: false, result: 'ANSWER tools-offered=0', model: 'claude-sonnet-5' });
    const a = cm.assistants.find((x) => x.name === 'Pipeline shop-web plan-reviewer');
    expect(a, `assistants: ${cm.assistants.map((x) => x.name).join(', ')}`).toBeTruthy();
    expect(a!.shared).toBe(false);                         // not shared with the team
    expect(a!.project).toBe(cm.user);                     // the operator's personal project
    expect(a!.toolkits).toEqual([]);                      // no grant, no plugin
    const chat = cm.chats[cm.chats.length - 1];
    expect(chat.model).toBe('claude-sonnet-5');
    expect(chat.tools).toEqual([]);
    expect(cm.integrations).toHaveLength(0);              // nothing registered for a tool-free seam
  }, 180_000);

  it('a seam that grants nothing gets the runner\'s full set — as on the claude runner, where no grant keeps the default tools', async () => {
    const r = await call('WRITE full-set.txt WRITTEN-WITH-NO-GRANT', { EPAM_AGENT_NAME: 'plan-author', EPAM_PLAN_EXECUTE: '0' });
    expect(r.status, r.stderr.slice(-1500)).toBe(0);
    expect(readFileSync(join(codeline, 'full-set.txt'), 'utf8')).toBe('WRITTEN-WITH-NO-GRANT');
    const chat = cm.chats[cm.chats.length - 1];
    expect(chat.tools).toContain('_write_file_to_file_system');
    expect(chat.tools).toContain('_run_command_line_tool');
  }, 180_000);

  it('a read-only grant binds the read-only plugin: the file is read from the codeline, and no write or command tool is offered', async () => {
    const r = await call('READ sentinel.txt', { EPAM_AGENT_NAME: 'estate-survey', AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'read_file,list_files,search' });
    expect(r.stderr, r.stderr.slice(-1500)).not.toMatch(/call failed/);
    expect(r.status, r.stderr.slice(-2000)).toBe(0);
    expect(r.stdout).toContain('SENTINEL-CONTENT-7f3a');
    const chat = cm.chats[cm.chats.length - 1];
    expect(chat.assistant).toBe('Pipeline shop-web estate-survey');
    expect(chat.tools).toContain('_read_file_from_file_system');
    expect(chat.tools).not.toContain('_write_file_to_file_system');
    expect(chat.tools).not.toContain('_run_command_line_tool');
    expect(cm.integrations.map((i) => i.alias)).toContain('Pipeline shop-web ro');
  }, 180_000);

  it('a read-only grant cannot write: asked to, the model finds no write tool and nothing lands on disk', async () => {
    const r = await call('WRITE leak.txt SHOULD-NOT-EXIST', { EPAM_AGENT_NAME: 'estate-survey', AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'read_file' });
    const seen = JSON.stringify(cm.chats[cm.chats.length - 1]);
    expect(r.stdout, seen).toContain('NO-WRITE-TOOL');
    expect(existsSync(join(codeline, 'leak.txt')), seen).toBe(false);
  }, 180_000);

  it('a write grant binds the development plugin: the file is written in the codeline by the plugin', async () => {
    const r = await call('WRITE src/written.txt WRITTEN-BY-THE-PLUGIN', { EPAM_AGENT_NAME: 'story-writer', AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'read_file,write_file,bash' });
    expect(r.stderr, r.stderr.slice(-1500)).not.toMatch(/call failed/);
    expect(r.status, r.stderr.slice(-2000)).toBe(0);
    expect(readFileSync(join(codeline, 'src/written.txt'), 'utf8')).toBe('WRITTEN-BY-THE-PLUGIN');
    const chat = cm.chats[cm.chats.length - 1];
    expect(chat.tools).toContain('_write_file_to_file_system');
    expect(chat.toolCalls).toEqual([expect.objectContaining({ name: '_write_file_to_file_system', error: '' })]);
    expect(cm.integrations.map((i) => i.alias)).toContain('Pipeline shop-web rw');
  }, 180_000);

  it('with a codeline estate, a read-only call reads a SIBLING codeline — as a claude-runner call can', async () => {
    // The estate survey is one call about every codeline; rooted at one, it could open only that one.
    const sibling = join(dir, 'sibling'); mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'other.txt'), 'SIBLING-CONTENT-19c2');
    const r = await call(`READ ${join(sibling, 'other.txt')}`, { EPAM_AGENT_NAME: 'estate-survey', AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'read_file,list_files,search', JIRA_CODELINE_ROOT: dir });
    expect(r.status, r.stderr.slice(-1500)).toBe(0);
    expect(r.stdout).toContain('SIBLING-CONTENT-19c2');
    expect(r.stderr).toMatch(new RegExp(`plugin ro at ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }, 180_000);

  it('with a codeline estate, a write-granted call still cannot write outside its own codeline', async () => {
    const outside = join(dir, 'sibling', 'written-outside.txt');
    await call(`WRITE ${outside} MUST-NOT-LAND`, { EPAM_AGENT_NAME: 'story-writer', AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'read_file,write_file,bash', JIRA_CODELINE_ROOT: dir });
    expect(existsSync(outside), 'the development plugin wrote outside the codeline').toBe(false);
  }, 180_000);

  it('search reads what the repository tracks — never a gitignored file, never a binary one', async () => {
    // Run 20260929T094305Z: search returned the binary .codegraph/codegraph.db and ignored .gitignore.
    const repo = join(dir, 'searched'); mkdirSync(join(repo, 'src'), { recursive: true }); mkdirSync(join(repo, 'build'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), 'build/\n');
    writeFileSync(join(repo, 'src', 'kept.ts'), 'export const NEEDLE_4b1 = 1;\n');
    writeFileSync(join(repo, 'build', 'ignored.js'), 'NEEDLE_4b1 in a build output\n');
    writeFileSync(join(repo, 'src', 'index.db'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('NEEDLE_4b1 in a binary')]));
    execSync(`git -C ${JSON.stringify(repo)} init -q && git -C ${JSON.stringify(repo)} add -A`);
    const r = await call(`SEARCH NEEDLE_4b1 IN ${repo}`, { EPAM_AGENT_NAME: 'estate-survey', AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'read_file,list_files,search', JIRA_CODELINE_ROOT: dir });
    expect(r.status, r.stderr.slice(-1500)).toBe(0);
    expect(r.stdout).toMatch(/src\/kept\.ts:1:/);
    expect(r.stdout).not.toMatch(/ignored\.js/);
    expect(r.stdout).not.toMatch(/index\.db/);
  }, 180_000);

  it('an answer with nothing in it is a failure the ladder can act on, not a success', async () => {
    const r = await call('SAY-NOTHING', { EPAM_AGENT_NAME: 'plan-reviewer' });
    expect(r.status).not.toBe(0);
    expect(r.json).toMatchObject({ is_error: true, error: { class: 'empty' } });
  }, 180_000);

  it('the run\'s exit handler stops every plugin: none stays connected, none stays alive', async () => {
    const state = JSON.parse(readFileSync(join(dir, 'home/plugins.json'), 'utf8')) as Record<string, { pid: number }>;
    const pids = Object.values(state).map((s) => s.pid);
    expect(pids.length).toBeGreaterThanOrEqual(2);   // the ro and rw plugins above
    expect(cm.engine.connections).toBeGreaterThanOrEqual(2);
    execSync(`bash -c '. ${JSON.stringify(RUNNER)}; provider_stop'`, { env: baseEnv() });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(pids.filter(alive)).toEqual([]);
    for (let i = 0; i < 20 && cm.engine.connections > 0; i += 1) await new Promise((ok) => setTimeout(ok, 250));
    expect(cm.engine.connections).toBe(0);
  }, 60_000);
});
