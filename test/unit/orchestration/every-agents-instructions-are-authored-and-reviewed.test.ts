/**
 * EVERY AGENT'S STANDING INSTRUCTIONS ARE AUTHORED BY AN AGENT AND FALSIFIED BY ANOTHER — PER PROJECT.
 *
 * Operator, 2026-09-29: "We cannot have thin SI" and "YOU need to do this agentically." The seam
 * si-author writes a seam's standing instructions from the seam's task prompt, its declaration, the
 * agent's persona and the project's context; si-review falsifies them; a blocking finding sends the
 * seam back to the author (lib/assistant-instructions.js). The codemie-web assistant stores exactly
 * what was authored.
 *
 * Executed: the real CLI (node lib/assistant-instructions.js) and the real seam hub on the codemie-web
 * set, against CodeMie stood in for (test/mock-agent/codemie.ts) with the mocking agent as the model —
 * whose si-author stand-in builds its answer from the inputs it is handed. The seams authored are the
 * real registry FILTERED to the two authoring seams and two others, so the run stays small; nothing
 * about them is written here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockAgent, type Call } from '../../mock-agent/agent';
import { MockCodeMie } from '../../mock-agent/codemie';
import { builtPythonEnv } from '../../mock-agent/python-env';
import { World } from '../../mock-agent/world';
import { correct } from '../../mock-agent/seams';

const ROOT = join(__dirname, '../../../');
const AGENTS = join(ROOT, 'orchestrations/agents');
const CLI = join(ROOT, 'orchestrations/scripts/lib/assistant-instructions.js');
const HANDLER = join(ROOT, 'orchestrations/scripts/llm-handler.sh');
const CODEMIE = (() => { try { return execSync('command -v codemie', { encoding: 'utf8', shell: '/bin/bash' }).trim(); } catch { return ''; } })();
const reg = JSON.parse(readFileSync(join(AGENTS, 'invocation-profiles.json'), 'utf8'));
const byProduce = (k: string) => Object.keys(reg.profiles).find((s) => reg.profiles[s].produces === k)!;
const AUTHOR = byProduce('assistant-instructions');
const REVIEW = byProduce('instructions-review');
/** Two seams that run in greenfield, each with its own persona and a task template — read from the registry. */
const TARGETS = Object.keys(reg.profiles).filter((s) => {
  const p = reg.profiles[s];
  return s !== AUTHOR && s !== REVIEW && p.template && p.persona && !s.includes(':')
    && !(p.appliesTo || []).includes('brownfield');
}).filter((s, i, all) => all.findIndex((t) => reg.profiles[t].persona === reg.profiles[s].persona) === i).slice(0, 2);
const layoutHeadings = (JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/assistant-instructions.json'), 'utf8')).bodies.authored as string)
  .split('\n').filter((l) => l.startsWith('## '));
const ladderModels = () => JSON.parse(execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/handlers/ladder-models.js'))}`, { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: 'codemie-web' } }));

let dir = ''; let agents = ''; let project = ''; let codeline = ''; let agent: MockAgent; let cm: MockCodeMie; let venv = '';
let lastSystem = '';
let reviewScript: ((c: Call) => ReturnType<ReturnType<typeof correct>>) | null = null;

const env = () => ({
  ...process.env as Record<string, string>, EPAM_PROVIDER_SET: 'codemie-web', NODE_BIN: process.execPath,
  EPAM_CODEMIE_WEB_URL: agent.url, EPAM_CODEMIE_PLUGIN_ENGINE_URI: cm.engineUri, EPAM_CODEMIE_WEB_HOME: join(dir, 'home'),
  EPAM_CODEMIE_PLUGINS_VENV: venv, EPAM_AGENTS_DIR: agents, EPAM_PROJECT_CONFIG_DIR: project, PROJECT_NAME: 'si-proof',
  EPAM_BROWNFIELD: '0', OUTPUT_DIR: codeline, PROJECT_ROOT: codeline, LOG_DIR: join(dir, 'logs'),
  EPAM_ORCHESTRATION_PROVIDER: 'codemie-web', EPAM_CALL_MAX_ATTEMPTS: '1', EPAM_DANGEROUS_SKIP_APPROVAL: '1', EPAM_TIMEOUT_SECS: '180', EPAM_PLAN_EXECUTE: '0',
  EPAM_CONTENT_RETRY_ATTEMPTS: '1', SEAM_MAX_RETRIES: '0',
});

const run = (cmd: string, args: string[], extra: Record<string, string> = {}, input = '') => new Promise<{ status: number | null; out: string; err: string }>((resolve) => {
  const p = spawn(cmd, args, { cwd: dir, env: { ...env(), ...extra } });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(input);
  p.on('close', (status) => resolve({ status, out, err }));
});
const author = () => run(process.execPath, [CLI]);
const artefact = (seam: string) => JSON.parse(readFileSync(join(project, 'assistant-instructions', `${seam.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), 'utf8'));
const callsTo = (seam: string) => agent.calls.filter((c) => c.seam === seam).length;

describe.skipIf(!CODEMIE)('every agent\'s standing instructions are authored and reviewed', () => {
  beforeAll(async () => {
    expect(TARGETS.length, 'the registry offers no seam to author').toBe(2);
    dir = mkdtempSync(join(tmpdir(), 'si-author-'));
    agents = join(dir, 'agents'); project = join(dir, 'project'); codeline = join(dir, 'codeline');
    for (const d of [agents, project, codeline, join(dir, 'logs')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(codeline, 'README.md'), 'a codeline\n');
    execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: codeline, shell: '/bin/bash' });
    for (const f of readdirSync(AGENTS)) if (f.endsWith('.json')) copyFileSync(join(AGENTS, f), join(agents, f));
    const keep = new Set([AUTHOR, REVIEW, ...TARGETS]);
    const filtered = { ...reg, profiles: Object.fromEntries(Object.entries(reg.profiles).filter(([k]) => keep.has(k))) };
    writeFileSync(join(agents, 'invocation-profiles.json'), JSON.stringify(filtered, null, 2));
    agent = new MockAgent(join(ROOT, 'orchestrations'), join(dir, 'journal'));
    const world = new World(() => [codeline], () => join(dir, 'prd.json'), project);
    const good = correct(world, ROOT);
    agent.on('*', (c, a) => { lastSystem = c.req.system.trim(); return good(c, a); });
    agent.on(REVIEW, (c, a) => (reviewScript ? reviewScript(c) : null) ?? good(c, a));
    await agent.start();
    cm = await new MockCodeMie(agent, join(dir, 'journal'), ladderModels()).start();
    venv = builtPythonEnv(ROOT, 'codemie-web')!.env;
  }, 900_000);
  afterAll(async () => { await cm?.stop(); await agent?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('authors every seam the run uses — each laid out in full, reviewed, and stored exactly on its assistant', async () => {
    const r = await author();
    expect(r.status, r.err.slice(-2000)).toBe(0);
    for (const seam of TARGETS) {
      expect(existsSync(join(project, 'assistant-instructions', `${seam.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)), `${seam} was not authored: ${r.err.slice(-1500)}`).toBe(true);
      const a = artefact(seam);
      expect(a.rendered.startsWith(`**Role:** ${reg.profiles[seam]._what}`), 'the role line comes first').toBe(true);
      for (const h of layoutHeadings) expect(a.rendered, `${seam} lacks ${h}`).toContain(h);
      expect(a.reviews[a.reviews.length - 1].verdict).toBe('sound');
      expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(callsTo(AUTHOR)).toBe(TARGETS.length);
    expect(callsTo(REVIEW)).toBe(TARGETS.length);
    // Not the authoring seams themselves: their instructions are their canonical personas.
    expect(existsSync(join(project, 'assistant-instructions', `${AUTHOR}.json`))).toBe(false);

    // The assistant stores exactly what was authored, and the model receives exactly that.
    lastSystem = '';
    const s = await run('bash', [HANDLER, '--provider', 'codemie-web'], { EPAM_AGENT_NAME: TARGETS[0], EPAM_MAX_TOOL_CALLS: '0', AI_MODEL: ladderModels()[0], EPAM_CODELINE: 'cl' }, 'Do the task.');
    expect(s.status, s.err.slice(-1500)).toBe(0);
    const stored = cm.assistants.find((x) => x.name === `Pipeline cl ${TARGETS[0]}`) as any;
    expect(stored.system_prompt).toBe(artefact(TARGETS[0]).rendered);
    expect(lastSystem, 'the model was not handed the authored instructions').toBe(artefact(TARGETS[0]).rendered);
  }, 900_000);

  it('an unchanged seam is not authored again', async () => {
    const before = callsTo(AUTHOR);
    const r = await author();
    expect(r.status, r.err.slice(-1500)).toBe(0);
    expect(callsTo(AUTHOR)).toBe(before);
  }, 600_000);

  it('a changed persona re-authors that seam, and only that seam', async () => {
    const who = reg.profiles[TARGETS[0]].persona;
    const profiles = JSON.parse(readFileSync(join(agents, 'profiles.json'), 'utf8'));
    const was = typeof profiles[who] === 'string' ? profiles[who] : profiles[who]?.persona;
    profiles[who] = `${was} You also check your work twice.`;
    writeFileSync(join(agents, 'profiles.json'), JSON.stringify(profiles, null, 2));
    const before = callsTo(AUTHOR);
    const oldDigest = artefact(TARGETS[0]).digest; const otherDigest = artefact(TARGETS[1]).digest;
    const r = await author();
    expect(r.status, r.err.slice(-1500)).toBe(0);
    expect(callsTo(AUTHOR)).toBe(before + 1);
    expect(artefact(TARGETS[0]).digest).not.toBe(oldDigest);
    expect(artefact(TARGETS[1]).digest).toBe(otherDigest);
  }, 600_000);

  it('a blocking review sends the seam back to the author with the findings; the second instructions are kept', async () => {
    rmSync(join(project, 'assistant-instructions', `${TARGETS[1].replace(/[^A-Za-z0-9._-]/g, '_')}.json`));
    const quote = 'NEGATIVE-CASE-QUOTE';
    let fired = false;
    reviewScript = (c) => {
      if (fired || !c.req.messages.some((m) => m.text.includes(`\`${TARGETS[1]}\``))) return null;
      fired = true;
      const body = JSON.stringify({ verdict: 'defects_found', findings: [{ severity: 'blocking', quote, checked: 'the task prompt', found: 'a contradiction', remedy: 'remove it' }] });
      return { kind: 'text', text: `<INSTRUCTIONS_REVIEW>\n${body}\n</INSTRUCTIONS_REVIEW>` };
    };
    const before = callsTo(AUTHOR);
    const r = await author();
    reviewScript = null;
    expect(r.status, r.err.slice(-1500)).toBe(0);
    expect(fired, 'the blocking review never fired').toBe(true);
    expect(callsTo(AUTHOR)).toBe(before + 2);
    const a = artefact(TARGETS[1]);
    expect(a.cycles).toBe(2);
    expect(a.reviews[0].verdict).toBe('defects_found');
    expect(a.reviews[1].verdict).toBe('sound');
    const second = agent.calls.filter((c) => c.seam === AUTHOR).pop()!;
    expect(second.req.messages.map((m) => m.text).join('\n'), 'the author was not handed the findings').toContain(quote);
  }, 600_000);
});
