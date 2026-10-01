/**
 * AN AGENT IS TOLD ITS TOOLS BY NAME — NEVER BY A LOCAL PATH.
 *
 * Operator, 2026-10-01: "hard coded local paths are not generated into prompts or SI text. This is
 * not permitted. Relative paths only." The detective, the guard-vocabulary check and the repro test
 * writer were told to run `bash "<install>/orchestrations/scripts/codegraph-agent-query.sh"` — an
 * absolute path into the install, in every prompt (the brownfield rehearsal, 2026-10-01).
 *
 * How a tool reaches an agent depends on the set, and is derived from it:
 *  - a set whose runner HOSTS the pipeline's tools (declares hostedToolPlugins) names them as tools;
 *  - every other set runs the scripts through its shell, named by an environment variable the hub
 *    exports — the prompt carries the variable, never the path, and the shell resolves it.
 *
 * EXECUTED: the real block for every provider set; the real hub (llm-handler.sh) with a stand-in
 * runner that records the environment it was given, and every command line of the block run in
 * that environment; the three real templates rendered with the real block.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations');
const LIB = join(ORCH, 'scripts/lib');
const HUB = join(ORCH, 'scripts/llm-handler.sh');
const CONFIG = join(ORCH, 'config');
const SETS = JSON.parse(readFileSync(join(CONFIG, 'provider-sets.json'), 'utf8'));
const settingsOf = (set: string) => JSON.parse(readFileSync(join(CONFIG, SETS.sets[set].settingsFile), 'utf8'));
const hostedModules = (set: string): string[] => Object.values<any>(settingsOf(set).runners || {})
  .flatMap((r) => (Array.isArray(r.hostedToolPlugins) ? r.hostedToolPlugins : []));
/** Every tool name a hosted plugin module declares — read from the modules, never listed here. */
const HOSTED_NAMES = [...new Set(Object.keys(SETS.sets).flatMap(hostedModules))]
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  .flatMap((m) => (require(join(ORCH, m)).tools || []).map((t: any) => t.name as string));
const COMMANDS_FILE = join(CONFIG, 'pipeline-tool-commands.json');
const COMMANDS: Record<string, string> = existsSync(COMMANDS_FILE) ? JSON.parse(readFileSync(COMMANDS_FILE, 'utf8')).commands || {} : {};
const TEMPLATES = ['code-graph-detective', 'guard-vocabulary-codegraph', 'repro-test-writer'];
/** An absolute local path: a slash-rooted token with at least two segments, not part of a URL. */
const ABSOLUTE = /(?<![\w.:/~$-])\/[\w.-]+\/[\w./-]*/g;

const work = mkdtempSync(join(tmpdir(), 'tools-by-name-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function blockFor(set: string): { status: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [join(LIB, 'pipeline-tools.js'), '--block'], {
    encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: set },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const varsIn = (text: string) => [...new Set([...text.matchAll(/\$\{?(EPAM_[A-Z0-9_]+)/g)].map((m) => m[1]))];

describe('an agent is told its tools by name, never by a local path', () => {
  it('the shape is real: one set hosts the pipeline tools and one does not; the commands are declared', () => {
    expect(Object.keys(SETS.sets).some((s) => hostedModules(s).length), 'no set hosts the pipeline tools').toBe(true);
    expect(Object.keys(SETS.sets).some((s) => !hostedModules(s).length), 'every set hosts them').toBe(true);
    expect(HOSTED_NAMES.length).toBeGreaterThan(0);
    expect(Object.keys(COMMANDS).length, `${COMMANDS_FILE} declares no commands`).toBeGreaterThan(0);
  });

  for (const set of Object.keys(SETS.sets)) {
    it(`${set}: the block names its tools the way this set reaches them, and no path`, () => {
      const b = blockFor(set);
      expect(b.status, b.err).toBe(0);
      expect(b.out.trim(), 'the block is empty — this proves nothing').not.toBe('');
      expect(b.out.match(ABSOLUTE) || []).toEqual([]);
      expect(b.out).not.toMatch(/\.sh\b/);
      if (hostedModules(set).length) {
        const named = HOSTED_NAMES.filter((n) => b.out.includes(n));
        expect(named.length, 'a hosting set is not told the hosted tools').toBeGreaterThan(1);
        expect(varsIn(b.out), 'a hosting set is told to run scripts').toEqual([]);
      } else {
        expect(HOSTED_NAMES.filter((n) => b.out.includes(n)), 'a set that hosts none is told a hosted tool').toEqual([]);
        const vars = varsIn(b.out);
        expect(vars.length, 'the command block names no command').toBeGreaterThan(0);
        for (const v of vars) expect(Object.keys(COMMANDS), `${v} is not a declared command`).toContain(v);
      }
    });
  }

  it('every command the block names resolves, in the environment the hub hands the runner', () => {
    const SET: string = Object.keys(SETS.sets).find((s) => !hostedModules(s).length) as string;
    const runners = settingsOf(SET).runners || {};
    const RUNNER = Object.keys(runners).find((r) => runners[r].siChannel && runners[r].siChannel.flag) || Object.keys(runners)[0];
    const rec = join(work, 'env.rec'); const stub = join(work, RUNNER);
    writeFileSync(stub, ['#!/usr/bin/env bash', 'cat >/dev/null', // The shell's own list, not `env`: an `env` earlier on PATH may be something else entirely.
      `for v in $(compgen -e); do printf '%s=%s\\n' "$v" "\${!v}"; done > ${JSON.stringify(rec)}`,
      `printf '%s' '{"result":"ok","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}'`].join('\n'));
    chmodSync(stub, 0o755);
    const codeline = join(work, 'codeline'); mkdirSync(codeline, { recursive: true });
    const r = spawnSync('bash', [HUB, '--provider', RUNNER], {
      input: 'hello', encoding: 'utf8', cwd: ROOT,
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, CLAUDE_CMD: stub, COPILOT_CMD: stub, NODE_BIN: process.execPath,
        EPAM_PROVIDER_SET: SET, EPAM_PROJECT_CONFIG_DIR: '', PROJECT_ROOT: codeline, EPAM_PLAN_EXECUTE: '0' },
    });
    expect(r.status, r.stderr.slice(-1500)).toBe(0);
    expect(existsSync(rec), 'the runner never ran — this proves nothing').toBe(true);
    const env: Record<string, string> = {};
    for (const line of readFileSync(rec, 'utf8').split('\n')) { const i = line.indexOf('='); if (i > 0) env[line.slice(0, i)] = line.slice(i + 1); }
    const vars = varsIn(blockFor(SET).out);
    expect(vars.length).toBeGreaterThan(0);
    for (const v of vars) {
      expect(env[v], `the hub did not hand the runner ${v}`).toBeTruthy();
      expect(existsSync(env[v]), `${v}=${env[v]} does not exist`).toBe(true);
      // Run it as the agent would: the shell resolves the variable, the script answers.
      const run = spawnSync('bash', ['-c', `bash "$${v}" --help`], { encoding: 'utf8', cwd: codeline, env: { ...env, PATH: process.env.PATH as string } });
      expect(run.status, `${v}: ${run.stderr}`).not.toBe(127);
      expect(run.stderr).not.toMatch(/No such file or directory/);
    }
  });

  for (const id of TEMPLATES) {
    it(`${id}: rendered with the real block, it carries no path and no script instruction`, () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const lib = require(join(LIB, 'prompt-library.js'));
      const doc = JSON.parse(readFileSync(join(ORCH, 'prompts/templates', `${id}.json`), 'utf8'));
      const SET: string = Object.keys(SETS.sets).find((s) => !hostedModules(s).length) as string;
      const block = blockFor(SET).out;
      expect(block.trim(), 'the block is empty — this proves nothing').not.toBe('');
      const values: Record<string, string> = {};
      for (const p of doc.placeholders || []) values[p] = `value-of-${p.replace(/_/g, '').toLowerCase()}`;
      values.__PIPELINE_TOOLS__ = block;
      const out: string = lib.render(doc, values);
      expect(out.length, 'rendered nothing — this proves nothing').toBeGreaterThan(200);
      expect(out, `${id} does not carry the tools block`).toContain(block.trim().split('\n')[0]);
      expect(out.match(ABSOLUTE) || []).toEqual([]);
      expect(out).not.toMatch(/orchestrations\/scripts|\.sh\b/);
      expect(out).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
    });
  }
});
