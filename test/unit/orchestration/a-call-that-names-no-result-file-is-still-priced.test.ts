/**
 * A CALL THAT NAMES NO RESULT FILE IS STILL PRICED.
 *
 * AMSD-2974 run 9: repro-test-writer (6), tc-writer (1) and vc-coverage (33) recorded 0 tokens and $0 — 40 Writer-phase
 * calls invisible. All go through ai-run.sh → llm-handler.sh without setting ORCH_JSON_RESULT, so the hub ran the
 * Claude CLI with `--output-format text` and the standard recorder could only write "this call happened and its usage
 * is unknown". The hub now owns a result document when the caller names none, so the call runs in JSON mode and its
 * real usage reaches the ledger — one fix at the one place every seam passes through.
 *
 * EXECUTED: the real llm-handler.sh, called as repro-test-writer calls it, with the Claude CLI stood in by a script that
 * answers JSON (with usage) when asked for JSON and plain text when asked for text — so the mode the hub chose is
 * visible in what was recorded.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const PROJECT = join(__dirname, '../../../orchestrations/projects/mock3');

function call(env: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'hub-priced-'));
  const stub = join(d, 'claude'); const argv = join(d, 'argv');
  writeFileSync(stub, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(argv)}`,
    'cat >/dev/null',
    'case " $* " in',
    `  *" --output-format json "*) printf '%s' '{"type":"result","result":"the answer","total_cost_usd":0.0421,"usage":{"input_tokens":1200,"output_tokens":340,"cache_read_input_tokens":9000,"cache_creation_input_tokens":500},"num_turns":2}' ;;`,
    '  *) printf "the answer" ;;',
    'esac',
  ].join('\n'));
  chmodSync(stub, 0o755);
  const r = spawnSync('bash', [join(SCRIPTS, 'llm-handler.sh'), '--provider', 'claude', '--model', 'claude-sonnet-5'], {
    input: 'write a test', encoding: 'utf8', timeout: 60000,
    env: {
      PATH: process.env.PATH || '', HOME: process.env.HOME || '', NODE_BIN: process.execPath,
      CLAUDE_CMD: stub, EPAM_PROVIDER_SET: 'claude', EPAM_PROJECT_CONFIG_DIR: PROJECT,
      EPAM_AGENT_NAME: 'repro-test-writer', EPAM_STORY_ID: 'S-1', ORCH_RUN_ID: 'run-test',
      LOG_DIR: d, ACTIVITY_FILE: join(d, 'agent-activity.jsonl'), EPAM_PLAN_EXECUTE: '0', ...env,
    },
  });
  const ledger = existsSync(join(d, 'phase-cost.jsonl'))
    ? readFileSync(join(d, 'phase-cost.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { stdout: r.stdout, stderr: r.stderr, ledger, argv: existsSync(argv) ? readFileSync(argv, 'utf8') : '', d };
}

describe('a call that names no result file is still priced', () => {
  it('the stand-in Claude was reached, and the caller still gets the plain answer on stdout', () => {
    const r = call();
    expect(r.argv, `the runner was never invoked:\n${r.stderr.slice(-800)}`).toContain('--print');
    expect(r.stdout.trim()).toBe('the answer');
  });

  it('the ledger records the call\'s real usage and cost — not a zero "usage unknown" row', () => {
    const r = call();
    const row = r.ledger.find((x) => x.agent_name === 'repro-test-writer' && Number(x.task_cost_usd) > 0);
    expect(row, `no priced row for the call:\n${JSON.stringify(r.ledger)}\n${r.stderr.slice(-600)}`).toBeTruthy();
    expect(Number(row.task_tokens_out)).toBe(340);
    expect(row.costUnknown).not.toBe(true);
  });

  it('the hub leaves no result file of its own behind', () => {
    const r = call();
    const left = spawnSync('bash', ['-c', `ls ${JSON.stringify(tmpdir())} | grep -c '^hub-result-' || true`], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('the answer');
    expect(Number(left.stdout.trim()), 'a hub-owned result document outlived its call').toBe(0);
  });

  it('a caller that names its own result file still gets it — nothing changes for it', () => {
    const own = join(mkdtempSync(join(tmpdir(), 'own-')), 'result.json');
    const r = call({ ORCH_JSON_RESULT: own });
    expect(r.stdout.trim()).toBe('the answer');
    expect(JSON.parse(readFileSync(own, 'utf8')).usage.output_tokens).toBe(340);
  });
});
