/**
 * A COPILOT CALL WITHOUT A LOG DIRECTORY KEEPS ITS ARGUMENTS.
 *
 * Live 2026-10-02, the detective re-run on copilot: every call failed before reaching a model —
 * "[copilot] call failed (invocation): unrecognized subcommand '--available-tools=bash'".
 * provider_call passes "--" as the placeholder for the events-keep slot when LOG_DIR is unset, then
 * "--" as the separator before the extra arguments. copilot_invoke took the placeholder for the
 * separator, so the real separator went to the CLI, and every argument after it (--add-dir, the
 * tool list) was read as a positional "subcommand". The pipeline sets LOG_DIR, which is why its
 * calls worked and the re-run step's did not.
 *
 * EXECUTED: the real provider_call (plugins/providers/copilot/runner.sh) with a stand-in CLI that
 * records its argument list, with and without LOG_DIR, with and without read roots.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations');
const DIR = join(ORCH, 'plugins/providers/copilot');
const work = mkdtempSync(join(tmpdir(), 'copilot-args-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const stub = join(work, 'cli.sh');
const argsOut = join(work, 'args.txt');
writeFileSync(stub, `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argsOut)}\ncat >/dev/null\n`);
chmodSync(stub, 0o755);
const prompt = join(work, 'prompt.txt'); writeFileSync(prompt, 'hi');
const home = join(work, 'home'); mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'catalog.json'), '{}');
const root = join(work, 'sibling'); mkdirSync(root, { recursive: true });

function argsFor(extraEnv: Record<string, string>) {
  rmSync(argsOut, { force: true });
  const env: Record<string, string> = { ...process.env as any, COPILOT_CMD: stub, EPAM_COPILOT_HOME: home, NODE_BIN: process.execPath, AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'bash', EPAM_PROVIDER_SET: 'copilot', ...extraEnv };
  if (!('LOG_DIR' in extraEnv)) delete env.LOG_DIR;
  for (const k of ['EPAM_READ_ROOTS', 'PRD_FILE', 'MAIN_PRD_FILE']) if (!(k in extraEnv)) delete env[k];
  // set -u, as every caller runs it: a reference without a default kills the call (run 11, 2026-10-08).
  const r = spawnSync('bash', ['-c', `set -u; cd ${JSON.stringify(DIR)} && source ./runner.sh && provider_call ${JSON.stringify(prompt)} ${JSON.stringify(join(work, 'r.json'))}`], { encoding: 'utf8', env });
  expect(existsSync(argsOut), `the CLI was never invoked: ${r.stderr.slice(-500)}`).toBe(true);
  return readFileSync(argsOut, 'utf8').trim().split('\n');
}

describe('the CLI receives the arguments the runner built', () => {
  for (const [label, env] of [
    ['no LOG_DIR, a read root', { EPAM_READ_ROOTS: root }],
    ['no LOG_DIR, no read root', {}],
    ['LOG_DIR set, a read root', { EPAM_READ_ROOTS: root, LOG_DIR: join(work, 'logs') }],
  ] as const) {
    it(`${label}: no stray "--", the tool grant and the read roots are options`, () => {
      const a = argsFor(env as any);
      expect(a, 'a "--" reached the CLI — everything after it is read as a subcommand').not.toContain('--');
      expect(a.some((x) => x.startsWith('--available-tools')), 'the tool grant was lost').toBe(true);
      if ((env as any).EPAM_READ_ROOTS) expect(a.slice(a.indexOf('--add-dir') + 1)[0]).toBe(root);
    });
  }
});

// Live AMSD-2974 runs 8 and 10 (2026-10-08): the gate-finding analyst was told to read the gate's log and the PRD;
// both live in the run's own folders, outside the codeline, and the CLI refused every read ("Permission denied
// because no interactive user response was available"). It answered "no grounded finding", the AC remediator added
// nothing, and a verified QA finding never reached the writer. The run's own files are readable by every call.
describe('every call may read the run\'s own files it is pointed at', () => {
  it('the log folder and the PRD folders are read roots, after the caller\'s own', () => {
    const logs = join(work, 'run-logs'); mkdirSync(logs, { recursive: true });
    const lane = join(work, 'lane'); mkdirSync(lane, { recursive: true });
    const canon = join(work, 'project'); mkdirSync(canon, { recursive: true });
    const a = argsFor({ EPAM_READ_ROOTS: root, LOG_DIR: logs, PRD_FILE: join(lane, 'prd.json'), MAIN_PRD_FILE: join(canon, 'prd.json') });
    const roots = a.flatMap((x, i) => (x === '--add-dir' ? [a[i + 1]] : []));
    expect(roots[0], 'the caller\'s own read root comes first').toBe(root);
    expect(roots).toEqual(expect.arrayContaining([logs, lane, canon]));
    expect(new Set(roots).size, 'a folder granted twice').toBe(roots.length);
  });
  it('no read roots from the caller (the common case): the call still runs, and the run\'s folders are granted', () => {
    const logs = join(work, 'run-logs-2'); mkdirSync(logs, { recursive: true });
    const env: Record<string, string> = { LOG_DIR: logs };
    const a = argsFor(env);
    expect(a.flatMap((x, i) => (x === '--add-dir' ? [a[i + 1]] : []))).toEqual([logs]);
  });
  it('none set: no extra grant', () => {
    const a = argsFor({});
    expect(a).not.toContain('--add-dir');
  });
});
