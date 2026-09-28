/**
 * A GUARD REFUSES WHAT IT SAYS IT REFUSES — BEFORE ANYTHING IS SPENT.
 *
 * Three blocking functions added 2026-09-27/28 were exercised only through their callers, so no test
 * ran their refusals (pre-flight's guard-calibration ratchet: 33 against a baseline of 30). Each is
 * run here against the case it exists to stop, from its real file, and the assertion is on both the
 * verdict and what did NOT happen after it:
 *
 *   codemie_web_invoke         no agent or no codeline to name an assistant after → refused; no call
 *   copilot_invoke             a model the catalog does not list → refused; the CLI never runs
 *   _read_estimation_manifest  a manifest the operator named that cannot be read → the run stops;
 *                              unset → nothing at all (no directory, no export)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'guard-')); dirs.push(d); return d; };
const bash = (script: string, env: Record<string, string> = {}) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath, ...env } });

describe('codemie_web_invoke', () => {
  const run = (env: Record<string, string>) => {
    const d = tmp(); const prompt = join(d, 'p.txt'); writeFileSync(prompt, 'hello');
    const result = join(d, 'r.json');
    const r = bash(`. ${JSON.stringify(join(LIB, 'codemie-web-runner.sh'))}; codemie_web_invoke ${JSON.stringify(prompt)} claude-sonnet-5 ${JSON.stringify(result)}; echo "RC=$?"`,
      { EPAM_AGENT_NAME: '', EPAM_CODELINE: '', PROJECT_NAME: '', EPAM_CODEMIE_WEB_URL: 'http://127.0.0.1:9', ...env });
    return { rc: Number((/RC=(\d+)/.exec(r.stdout) || [])[1]), err: r.stderr, called: existsSync(result) };
  };
  it('with no agent name, refuses to name an assistant after nobody — and makes no call', () => {
    const r = run({ EPAM_CODELINE: 'shop' });
    expect(r.rc).toBe(1);
    expect(r.err).toMatch(/EPAM_AGENT_NAME is unset/);
    expect(r.called).toBe(false);
  });
  it('with no codeline and no project, refuses — and makes no call', () => {
    const r = run({ EPAM_AGENT_NAME: 'story-writer' });
    expect(r.rc).toBe(1);
    expect(r.err).toMatch(/no codeline to name the assistant for/);
    expect(r.called).toBe(false);
  });
});

describe('copilot_invoke', () => {
  it('a model the catalog does not list is refused — the CLI is never started', () => {
    const d = tmp(); const prompt = join(d, 'p.txt'); writeFileSync(prompt, 'hello');
    const marker = join(d, 'cli-ran'); const cli = join(d, 'copilot');
    writeFileSync(cli, `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`); chmodSync(cli, 0o755);
    const r = bash(`. ${JSON.stringify(join(LIB, 'copilot-runner.sh'))}; copilot_invoke ${JSON.stringify(prompt)} no-such-model-anywhere '' ${JSON.stringify(join(d, 'r.json'))}; echo "RC=$?"`,
      { COPILOT_CMD: cli, EPAM_COPILOT_HOME: join(d, 'home'), EPAM_COPILOT_CATALOG: join(ROOT, 'test/fixtures/copilot/models-20260927.json'), COPILOT_PROVIDER_BASE_URL: '' });
    expect(Number((/RC=(\d+)/.exec(r.stdout) || [])[1])).toBe(1);
    expect(existsSync(marker), 'the CLI ran for a model the catalog does not list').toBe(false);
  });
});

describe('_read_estimation_manifest', () => {
  const fn = shellFunction(join(LIB, 'mint-and-spec.sh'), '_read_estimation_manifest');
  const run = (manifest: string | null) => {
    const d = tmp(); const prd = join(d, 'prd.json'); writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', jiraKey: 'ABC-1' }] }));
    const r = bash(['log(){ :; }; warning(){ :; }; error(){ echo "E: $*" >&2; }', fn,
      `_read_estimation_manifest ${JSON.stringify(prd)} ${JSON.stringify(join(d, 'ingest.log'))}; echo "RC=$? DIR=\${EPAM_ESTIMATION_DIR:-none}"`].join('\n'),
      { LOG_DIR: d, SCRIPT_DIR: join(ROOT, 'orchestrations/scripts'), ...(manifest === null ? { EPAM_ESTIMATION_MANIFEST: '' } : { EPAM_ESTIMATION_MANIFEST: manifest }) });
    return { rc: Number((/RC=(\d+)/.exec(r.stdout) || [])[1]), dirExport: (/DIR=(\S+)/.exec(r.stdout) || [])[1], made: existsSync(join(d, 'estimation')), err: r.stderr };
  };
  it('a manifest the operator named that cannot be read stops the run — before any agent is spent', () => {
    const r = run(join(tmp(), 'no-such-manifest.html'));
    expect(r.rc).toBe(1);
    expect(r.err).toMatch(/cannot be read — refusing to run/);
    expect(r.made).toBe(false);
  });
  it('unset is nothing: no refusal, no directory, no export', () => {
    const r = run(null);
    expect(r.rc).toBe(0);
    expect(r.made).toBe(false);
    expect(r.dirExport).toBe('none');
  });
});
