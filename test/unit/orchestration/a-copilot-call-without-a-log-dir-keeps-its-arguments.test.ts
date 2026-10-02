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
  const r = spawnSync('bash', ['-c', `cd ${JSON.stringify(DIR)} && source ./runner.sh && provider_call ${JSON.stringify(prompt)} ${JSON.stringify(join(work, 'r.json'))}`], { encoding: 'utf8', env });
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
