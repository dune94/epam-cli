/**
 * THE AGENT RUNS THE CLI THE OPERATOR LAUNCHED WITH — NOT WHICHEVER A LATER PROCESS'S PATH PUTS FIRST.
 *
 * AMSD-2974 run 9 rehearsal T3 (2026-10-14 04:05Z): the 7.x line's writer escalated to its top rung and ran
 * /usr/local/bin/claude — a 2.1.84 global npm install — instead of the operator's 2.1.299, and died on
 * "unknown option '--safe-mode'" before sending a token. The run's own processes resolved 2.1.299; the writer's did not.
 * The run snapshots the operator's PATH once at launch (EPAM_OPERATOR_PATH) and the hub resolves a bare runner name in it.
 *
 * EXECUTED: the real llm-handler.sh with two stand-in `claude` binaries — the operator's, which answers, and an older one
 * FIRST on the calling process's PATH, which refuses --safe-mode as 2.1.84 did.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const PROJECT = join(__dirname, '../../../orchestrations/projects/mock3');

function stand(dir: string, answer: string | null) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'claude');
  writeFileSync(f, answer === null
    ? '#!/usr/bin/env bash\ncase " $* " in *" --safe-mode "*) echo "error: unknown option \'--safe-mode\'" >&2; exit 1;; esac\necho OLD\n'
    : `#!/usr/bin/env bash\ncat >/dev/null\ncase " $* " in *" --output-format json "*) printf '%s' '{"type":"result","result":"${answer}","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1}}' ;; *) printf '${answer}' ;; esac\n`);
  chmodSync(f, 0o755);
}

function call(operatorPath: string | null) {
  const d = mkdtempSync(join(tmpdir(), 'operator-cli-'));
  const op = join(d, 'operator-bin'); const old = join(d, 'old-bin');
  stand(op, 'from the operator claude'); stand(old, null);
  const env: Record<string, string> = {
    PATH: `${old}:${op}:${process.env.PATH || ''}`, HOME: process.env.HOME || '', NODE_BIN: process.execPath,
    EPAM_PROVIDER_SET: 'claude', EPAM_PROJECT_CONFIG_DIR: PROJECT, EPAM_AGENT_NAME: 'story-writer', EPAM_STORY_ID: 'S-1',
    ORCH_RUN_ID: 'run-test', LOG_DIR: d, ACTIVITY_FILE: join(d, 'agent-activity.jsonl'), EPAM_PLAN_EXECUTE: '0',
  };
  if (operatorPath !== null) env.EPAM_OPERATOR_PATH = operatorPath.replace('OP', op);
  const r = spawnSync('bash', [join(SCRIPTS, 'llm-handler.sh'), '--provider', 'claude', '--model', 'claude-sonnet-5'],
    { input: 'write it', encoding: 'utf8', timeout: 60000, env });
  return { out: r.stdout, err: r.stderr };
}

describe('the agent runs the CLI the operator launched with', () => {
  it('an older claude first on the process PATH: the hub still runs the operator\'s, and the call answers', () => {
    const r = call(`OP:${process.env.PATH || ''}`);
    expect(r.out.trim(), r.err.slice(-600)).toBe('from the operator claude');
    expect(r.err).not.toContain('unknown option');
  });

  it('NEGATIVE: with no launch snapshot the process PATH decides, as before (the older binary refuses)', () => {
    const r = call(null);
    expect(r.out.trim()).not.toBe('from the operator claude');
  });
});
