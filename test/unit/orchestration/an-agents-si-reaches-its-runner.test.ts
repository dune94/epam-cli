/**
 * AN AGENT'S STANDING INSTRUCTIONS REACH ITS RUNNER — SEPARATE FROM THE TASK, AND ONLY ITS OWN.
 *
 * Operator, 2026-09-29: "Ensure each provider has a proper agent si transit." Until now no
 * provider received an agent's SI as a system prompt: the hub sent the task on stdin and nothing
 * else, and 23 of 41 seams carried no persona anywhere. The SI now travels on the channel each
 * RUNNER declares in its provider set (runners.<name>.siChannel) — the engine names no flag.
 *
 * Drives the REAL hub with a stand-in runner that records its argv, the file its SI channel names,
 * and its stdin. The project roster is built by the REAL roster library from the REAL per-seam base.
 * Nothing expected is spelled here: flags come from the set's declaration, SIs from the roster and
 * the registry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const HUB = join(ROOT, 'orchestrations/scripts/llm-handler.sh');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const NODE_BIN = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const roster = require(join(LIB, 'project-roster.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { seamForKind } = require(join(LIB, 'seam-invocation.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveRunner } = require(join(LIB, 'llm-settings-resolve.js'));

// Every name below is read from a declaration: the provider sets' declared default, the runner in
// it that declares an SI flag, a seam that carries an si, a minted agent of a declared kind.
const SETS = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8'));
const SET: string = SETS.defaultSet;
const SET_RUNNERS = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config', SETS.sets[SET].settingsFile), 'utf8')).runners || {};
const RUNNER = Object.keys(SET_RUNNERS).find((r) => SET_RUNNERS[r].siChannel && SET_RUNNERS[r].siChannel.flag) as string;
const REG_DOC = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const reg = REG_DOC.profiles;
const SPECIALISED = Object.keys(reg).find((s) => reg[s].si) as string;
const MINTED_KIND = (REG_DOC.agentKinds as string[]).find((k) => { try { return !!seamForKind(k, REGISTRY); } catch { return false; } }) as string;
const MINTED = `minted-${MINTED_KIND}`;
const TASK = 'THE TASK TEXT ONLY';

let work = '';
let projWithRoster = '';
let projWithout = '';

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'si-transit-'));
  projWithRoster = join(work, 'proj'); mkdirSync(projWithRoster, { recursive: true });
  projWithout = join(work, 'bare'); mkdirSync(projWithout, { recursive: true });
  const logs = join(work, 'logs'); mkdirSync(logs, { recursive: true });
  const base = roster.seamBaseForRun(REGISTRY, logs);
  const produce = async ({ canonicalCopyPath, outPath }: any) => {
    const c = JSON.parse(readFileSync(canonicalCopyPath, 'utf8'));
    writeFileSync(outPath, JSON.stringify({ agents: {
      [SPECIALISED]: { persona: `[project] ${c[SPECIALISED]}` },
      [MINTED]: { persona: '[project] A minted agent of this codeline.', kind: MINTED_KIND },
    } }));
  };
  const prev = process.env.EPAM_PROJECT_CONFIG_DIR;
  process.env.EPAM_PROJECT_CONFIG_DIR = projWithRoster;
  try {
    await roster.buildProjectRoster({ canonicalPath: base, logDir: logs, projectConfigDir: projWithRoster,
      produce, review: async () => ({ verdict: 'approved' }), attempts: 1, log: () => {} });
  } finally {
    if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev;
  }
});
afterAll(() => { rmSync(work, { recursive: true, force: true }); });

/** Run the hub as `agent`; return what the stand-in runner received. */
function call(agent: string, projectDir: string, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'si-runner-'));
  try {
    const rec = join(dir, 'rec');
    const stub = join(dir, RUNNER);
    // Records argv, stdin, and the content of every argument that is a readable file.
    writeFileSync(stub, [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$@" > ${JSON.stringify(rec + '.argv')}`,
      `cat > ${JSON.stringify(rec + '.stdin')}`,
      `for a in "$@"; do [ -f "$a" ] && cat "$a" >> ${JSON.stringify(rec + '.files')}; done`,
      `printf '%s' '{"result":"ok","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}'`,
    ].join('\n'));
    chmodSync(stub, 0o755);
    const res = spawnSync('bash', [HUB, '--provider', RUNNER], {
      input: TASK, encoding: 'utf8', cwd: ROOT,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CLAUDE_CMD: stub, NODE_BIN,
        EPAM_PROVIDER_SET: SET, EPAM_AGENT_NAME: agent, EPAM_PROJECT_CONFIG_DIR: projectDir, ...extraEnv },
    });
    const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
    return { argv: (read(rec + '.argv') || '').split('\n').filter(Boolean), stdin: read(rec + '.stdin'),
      files: read(rec + '.files') || '', status: res.status, stderr: res.stderr || '' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const channel = () => (resolveRunner(RUNNER, { projectConfigDir: projWithRoster }) || {}).siChannel;
const personaOf = (name: string) => JSON.parse(readFileSync(join(projWithRoster, 'roster.json'), 'utf8')).agents[name].persona;

describe('the channel is declared, not spelled', () => {
  it('the runner declares an SI channel in its provider set', () => {
    expect(channel(), `runners.${RUNNER}.siChannel is not declared in the ${SET} set`).toBeTruthy();
    expect(typeof channel().flag).toBe('string');
  });
});

describe('an agent\'s SI reaches its runner', () => {
  it('a seam gets its PROJECT SI, on the declared flag, and the task alone on stdin', () => {
    const r = call(SPECIALISED, projWithRoster);
    expect(r.argv.length, `the hub never reached the runner: ${r.stderr.slice(0, 400)}`).toBeGreaterThan(0);
    expect(r.argv).toContain(channel().flag);
    expect(r.files).toContain(personaOf(SPECIALISED));
    expect(personaOf(SPECIALISED).startsWith('[project] ')).toBe(true);
    expect(r.stdin).toContain(TASK);
    expect(r.stdin).not.toContain(personaOf(SPECIALISED));
  });

  it('ONLY its own SI — no other agent\'s standing instructions travel with it', () => {
    const r = call(SPECIALISED, projWithRoster);
    expect(r.files.length).toBeGreaterThan(0);
    const all = JSON.parse(readFileSync(join(projWithRoster, 'roster.json'), 'utf8')).agents;
    for (const [name, e] of Object.entries<any>(all)) {
      if (name === SPECIALISED) continue;
      expect(r.files.includes(e.persona), `${name}'s SI travelled with ${SPECIALISED}`).toBe(false);
    }
  });

  it('a MINTED agent gets its own derived SI', () => {
    const r = call(MINTED, projWithRoster);
    expect(r.files).toContain(personaOf(MINTED));
    expect(JSON.parse(readFileSync(join(projWithRoster, 'roster.json'), 'utf8')).agents[MINTED].ancestor)
      .toBe(seamForKind(MINTED_KIND, REGISTRY));
  });

  it('the SEAM THE INVOCATION RESOLVED decides the SI — not a label that names another seam', () => {
    // spec-mode-runner uses a call's cost label as its agent name when none is set, and a label can
    // resolve by name to a different seam. seamInvocationEnv exports EPAM_SEAM — the
    // seam that decided this call's ladder and budget — and that is the seam whose SI it receives.
    // A declared agent name that the registry maps to a DIFFERENT seam (its agentSeams).
    const label = Object.keys(REG_DOC.agentSeams).find((n) => REG_DOC.agentSeams[n] !== SPECIALISED) as string;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveSeam } = require(join(LIB, 'seam-invocation.js'));
    expect(resolveSeam(label, REGISTRY, { ignoreXref: true }), 'the label must resolve elsewhere, or this proves nothing').not.toBe(SPECIALISED);
    const r = call(label, projWithRoster, { EPAM_SEAM: SPECIALISED });
    expect(r.files).toContain(personaOf(SPECIALISED));
  });

  it('BEFORE the roster exists, a seam gets its BASE SI from the registry', () => {
    const r = call(SPECIALISED, projWithout);
    expect(r.argv).toContain(channel().flag);
    expect(r.files).toContain(reg[SPECIALISED].si);
  });
});
