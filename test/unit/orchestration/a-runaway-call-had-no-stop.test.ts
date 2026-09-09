/**
 * NOTHING BOUNDED WHAT A SINGLE CALL COULD SPEND.
 *
 * The project declares its cost stop — llm-settings.json costControls:
 *
 *     storyBudgetHardLimitUsd: 15      "$15.00 is the actual cost stop"
 *     storyBudgetWarningUsd:    3.5
 *
 * claude.sh:343 already exports it as EPAM_STORY_BUDGET_HARD_LIMIT_USD, and nothing passes it to
 * the runner. Claude Code 2.1.265 documents `--max-budget-usd <amount>  Maximum dollar amount to
 * spend on API calls (only works with --print)` — the exact control, unused.
 *
 * The gap matters because the pipeline's other bound does not exist on this stack: every seam
 * declares maxOutputTokens, seam-invocation exports EPAM_MAX_OUTPUT_TOKENS, and no CLI arm reads
 * it. Proven live 2026-09-09 — a seam pinned to 128 output tokens produced 1,665, 13x its declared
 * cap, exiting 0 and saying nothing. So today a call that loops has no token stop AND no spend stop.
 *
 * This is a RUNAWAY BACKSTOP, not a squeeze: the cap is the whole story's hard limit, so a single
 * call may only be stopped by exceeding what the entire story was allowed. The most expensive call
 * in run 20260908T215555Z was $1.70 against a $15 limit, so nothing legitimate comes near it.
 *
 * Nothing is invented here. The number is the project's own declaration, and the flag is used only
 * where the installed runner advertises it in --help — the same probe the --json-schema binding
 * beside it already performs, so an older CLI or a different vendor arm is unaffected.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HANDLER = join(process.cwd(), 'orchestrations', 'scripts', 'llm-handler.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/**
 * A stub standing in for the installed CLI. `advertises` controls what its --help says, which is
 * what the handler probes — so support and non-support are both exercised against the real logic.
 */
function stubCli(dir: string, advertises: boolean) {
  const argvLog = join(dir, 'argv.txt');
  const cli = join(dir, 'claude');
  writeFileSync(cli, `#!/usr/bin/env bash
if [ "\${1:-}" = "--help" ]; then
  echo "  --print"
  echo "  --output-format <format>"
  ${advertises ? 'echo "  --max-budget-usd <amount>   Maximum dollar amount to spend"' : 'echo "  --model <m>"'}
  echo "  --json-schema <schema>"
  exit 0
fi
printf '%s\\n' "$*" >> "${argvLog}"
cat > /dev/null
echo '{"result":"OK","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  chmodSync(cli, 0o755);
  return { cli, argvLog };
}

function call(opts: { advertises: boolean; env?: Record<string, string> }) {
  const d = tmp('budget-');
  const { cli, argvLog } = stubCli(d, opts.advertises);
  const jsonOut = join(d, 'result.json');
  let stderr = '', status = 0;
  try {
    execFileSync('bash', [HANDLER, '--provider', 'claude', '--model', 'claude-haiku-4-5-20251001'], {
      input: 'hello\n', encoding: 'utf8', timeout: 60_000,
      env: {
        ...process.env, CLAUDE_CMD: cli, ORCH_JSON_RESULT: jsonOut,
        EPAM_PROVIDER_SET: 'claude', EPAM_RESPONSE_SCHEMA: '',
        EPAM_STORY_BUDGET_HARD_LIMIT_USD: '', ...(opts.env || {}),
      },
    });
  } catch (e: any) { stderr = e.stderr || ''; status = e.status ?? -1; }
  const argv = existsSync(argvLog) ? readFileSync(argvLog, 'utf8') : '';
  return { argv, stderr, status, ran: argv.trim().length > 0 };
}

describe('the declared story budget reaches the runner', () => {
  it('passes --max-budget-usd with the project\'s OWN declared limit', () => {
    const r = call({ advertises: true, env: { EPAM_STORY_BUDGET_HARD_LIMIT_USD: '15' } });
    expect(r.ran, `the stub CLI was never invoked. stderr: ${r.stderr.slice(0, 300)}`).toBe(true);
    expect(r.argv, 'the declared cost stop never reached the runner — a single call is unbounded')
      .toMatch(/--max-budget-usd 15/);
  });

  it('still sends the flags it always sent — nothing else changes', () => {
    const r = call({ advertises: true, env: { EPAM_STORY_BUDGET_HARD_LIMIT_USD: '15' } });
    expect(r.argv).toMatch(/--print/);
    expect(r.argv).toMatch(/--output-format json/);
    expect(r.argv).toMatch(/--dangerously-skip-permissions/);
  });
});

describe('it cannot disturb a run that declares no budget, or a runner that lacks the flag', () => {
  it('sends NO budget flag when the project declares none', () => {
    const r = call({ advertises: true });
    expect(r.ran).toBe(true);
    expect(r.argv, 'a budget was invented for a project that declared none')
      .not.toMatch(/--max-budget-usd/);
  });

  it('sends NO budget flag when the installed runner does not advertise it', () => {
    const r = call({ advertises: false, env: { EPAM_STORY_BUDGET_HARD_LIMIT_USD: '15' } });
    expect(r.ran, 'the call failed on a runner that simply lacks the flag').toBe(true);
    expect(r.argv, 'an unsupported flag was passed — this is how `-s` broke the plain claude arm')
      .not.toMatch(/--max-budget-usd/);
  });

  it('ignores a non-numeric budget rather than passing garbage to the CLI', () => {
    const r = call({ advertises: true, env: { EPAM_STORY_BUDGET_HARD_LIMIT_USD: 'unlimited' } });
    expect(r.ran).toBe(true);
    expect(r.argv).not.toMatch(/--max-budget-usd/);
  });
});
