/**
 * A PROVIDER IS A DECLARATION AND A PLUGIN — ADDING ONE CHANGES NO ENGINE FILE.
 *
 * The copilot and codemie-web providers were wired by naming them in engine `case` arms (the seam
 * hub, the story writer, the orchestrator's wrapper dispatch, the exit handler) with their vendor
 * facts in scripts/lib — the hardcoding rule's one forbidden home (review of 2026-09-29). A provider
 * now declares its runner plugin in config/providers.json (`runnerPlugin`); the engine calls the
 * plugin's `provider_call`, and runs its `provider_stop` when the run ends.
 *
 * Proven on a fixture install of this tree: a provider no engine file has ever heard of, declared in
 * that install's providers.json with a plugin of its own, answers a seam call made through the real
 * llm-handler.sh — the prompt reaching it, the result file written, the answer on stdout.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureInstall } from '../../integration/lib/fixture-install';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PLUGIN = `# the echo provider — a plugin, so it may say whatever it likes about itself
provider_call() {
  local prompt_file="\${1:?}" result_json="\${2:?}"
  local said; said="$(cat "$prompt_file")"
  printf '%s' "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"ECHO:\${EPAM_AGENT_NAME}:\${AI_MODEL}\\",\\"usage\\":{\\"input_tokens\\":0,\\"output_tokens\\":1}}" > "$result_json"
  printf 'ECHO:%s:%s:%s' "\${EPAM_AGENT_NAME}" "\${AI_MODEL}" "$said"
}
provider_stop() { echo stopped >> "\${ECHO_STOP_LOG:?}"; }
`;

function installWithEcho() {
  const install = fixtureInstall(dirs);
  const providers = join(install, 'orchestrations/config/providers.json');
  const p = JSON.parse(readFileSync(providers, 'utf8'));
  p.known = Array.isArray(p.known) ? [...p.known, 'echo'] : { ...p.known, echo: {} };
  p.runnerPlugin = { ...(p.runnerPlugin || {}), echo: 'plugins/providers/echo' };
  writeFileSync(providers, JSON.stringify(p, null, 2));
  mkdirSync(join(install, 'orchestrations/plugins/providers/echo'), { recursive: true });
  writeFileSync(join(install, 'orchestrations/plugins/providers/echo/runner.sh'), PLUGIN);
  return install;
}

describe('a provider is a declaration and a plugin', () => {
  it('the seam hub routes a call to a provider declared only in config, through its plugin', () => {
    const install = installWithEcho();
    const result = join(install, 'result.json');
    const r = spawnSync('bash', [join(install, 'orchestrations/scripts/llm-handler.sh'), '--provider', 'echo'], {
      cwd: install, input: 'HELLO-PLUGIN', encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, NODE_BIN: process.execPath, ORCH_JSON_RESULT: result, AI_MODEL: 'model-x', EPAM_AGENT_NAME: 'plan-reviewer',
        LOG_DIR: join(install, 'logs'), EPAM_CALL_MAX_ATTEMPTS: '1', EPAM_DANGEROUS_SKIP_APPROVAL: '1', EPAM_TIMEOUT_SECS: '60', EPAM_PLAN_TIMEOUT_SECS: '60', EPAM_PLAN_EXECUTE: '0' },
    });
    expect(r.status, r.stderr.slice(-1500)).toBe(0);
    expect(r.stdout).toContain('ECHO:plan-reviewer:model-x:');
    expect(r.stdout).toContain('HELLO-PLUGIN');
    expect(JSON.parse(readFileSync(result, 'utf8'))).toMatchObject({ is_error: false, result: 'ECHO:plan-reviewer:model-x' });
  });

  it('the run\'s exit handler stops every declared plugin that can be stopped', () => {
    const install = installWithEcho();
    const log = join(install, 'stop.log');
    const r = spawnSync('bash', ['-c', `. ${JSON.stringify(join(install, 'orchestrations/scripts/lib/provider-plugin.sh'))}; provider_plugins_stop`], {
      cwd: install, encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath, ECHO_STOP_LOG: log },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('stopped\n');
  });
});
