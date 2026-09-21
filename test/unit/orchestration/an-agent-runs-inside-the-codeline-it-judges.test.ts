/**
 * AN AGENT RUNS INSIDE THE CODELINE IT JUDGES.
 *
 * regintel 140717Z resume 4 (2026-09-21 18:59), the team-lead review of REGI-010-B:
 *   "The current working directory (/home/bradleyjerome/projects/ai/regintel-pipeline) is an
 *    orchestration/harness environment; the regintel/ Python package, scripts/run_pipeline.py …
 *    and tests/ directory are not present."
 * and of REGI-008a: "regintel/static/index.html does not exist anywhere in the repo … the only
 * regintel/ tree in the workspace is the orchestration metadata directory". Both false: the files
 * sat in the codeline. invoke_agent takes --codeline, but used it only to discover the plugin tools
 * to grant; the runner itself executed in the orchestrator's cwd — the pipeline install — so every
 * relative read_file, search and bash the reviewer made looked at the wrong tree. Earlier reviews
 * survived by using the absolute paths in the diff header.
 *
 * The runner now starts in the codeline it was handed. Driven through the REAL invoke_agent with
 * a stub runner that records where it ran.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const INVOKE = join(ROOT, 'orchestrations/scripts/lib/agent-invoke.sh');
const PROFILES = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function invokeFrom(opts: { codeline?: string }) {
  const d = mkdtempSync(join(tmpdir(), 'agent-cwd-')); dirs.push(d);
  const codeline = join(d, 'codeline'); mkdirSync(codeline);
  const elsewhere = join(d, 'orchestrator-cwd'); mkdirSync(elsewhere);
  const seen = join(d, 'pwd.txt'); const runner = join(d, 'ai-run.sh');
  writeFileSync(runner, ['#!/usr/bin/env bash', 'cat >/dev/null', `pwd -P > ${JSON.stringify(seen)}`, 'echo "{}"'].join('\n'));
  chmodSync(runner, 0o755);
  const flag = opts.codeline ? `--codeline ${JSON.stringify(opts.codeline)}` : '';
  const r = spawnSync('bash', ['-c', [
    'set -e',
    'log() { :; }; info() { :; }; warning() { :; }; error() { :; }; success() { :; }',
    `export AGENT_PROFILES_REGISTRY=${JSON.stringify(PROFILES)}`,
    `unset PROJECT_ROOT`,
    `. ${JSON.stringify(INVOKE)}`,
    `printf 'a prompt' | invoke_agent team-lead-review --runner ${JSON.stringify(runner)} ${flag} >/dev/null 2>&1 || true`,
  ].join('\n')], { encoding: 'utf8', timeout: 60000, cwd: elsewhere });
  const ran = existsSync(seen) ? readFileSync(seen, 'utf8').trim() : `<runner never ran: ${r.stderr}>`;
  return { ran, codeline, elsewhere };
}

describe('an agent runs inside the codeline it judges', () => {
  it('the runner starts in the codeline invoke_agent was handed, not where the orchestrator stands', () => {
    const r = invokeFrom({ codeline: undefined });
    const withCodeline = invokeFrom({ codeline: r.codeline });
    expect(withCodeline.ran, 'the reviewer would read the pipeline install, not the codeline').toBe(r.codeline);
  });

  it("without a codeline it keeps the caller's cwd — nothing is guessed", () => {
    const r = invokeFrom({});
    expect(r.ran).toBe(r.elsewhere);
  });
});
