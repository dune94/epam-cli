/**
 * THE STORY WRITER NAMES ITS SEAM, AT EVERY PLACE IT INVOKES A RUNNER.
 *
 * Every other seam names itself at its call (lib/orch-prompt.sh: "NAME THE AGENT AT THE CALL").
 * The writer never did: it invokes the runner directly, so the anonymous-agent guard — which
 * watches callers of the hub — never saw it. The recorder labels a turn from the CHILD's
 * environment (src/observability/agentLabel.ts: `EPAM_AGENT_NAME · EPAM_STORY_ID`), so the
 * writer's turns were filed under whatever the child inherited: `prompt-review` on 2026-09-09
 * (76 turns, 612 tool calls, mislabelled), the bare story id on 2026-09-10 (232 turns as
 * AMSD-1919.json). No replayer or mock loader can find either by seam. Found by the per-seam
 * replay test, 2026-09-11.
 *
 * Two assertions: the replay delegate call, lifted from claude.sh and EXECUTED with a stub runner
 * that dumps its environment, receives the seam name and the story id; and every runner arm in
 * the writer's dispatch carries the same prefix — enumerated from the script, so a new arm is
 * covered the day it is written.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const DELEGATE = join(ROOT, 'orchestrations/scripts/lib/replay-delegate.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const src = readFileSync(CLAUDE_SH, 'utf8');
const lines = src.split('\n');

/** Every line in claude.sh that hands the writer's prompt to a runner binary or the delegate. */
const runnerArms = lines
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => /^\s*if echo "\$prompt" \|/.test(line) && /(--print|"\$EPAM_CLI" run)/.test(line + (lines[lines.indexOf(line) + 1] || '')));
const delegateCall = lines.find((l) => /replay_delegate "\$prompt"/.test(l) && !/^\s*#/.test(l));

describe('the writer names its seam', () => {
  it('the seam name is declared once', () => {
    const decls = lines.filter((l) => /^STORY_WRITER_SEAM=/.test(l));
    expect(decls, 'STORY_WRITER_SEAM must be declared exactly once in claude.sh').toHaveLength(1);
  });

  it('the scan found the runner arms — otherwise the case below is vacuous', () => {
    expect(runnerArms.length, 'no `if echo "$prompt" | … --print` arms found; the dispatch shape has changed').toBeGreaterThanOrEqual(3);
    expect(delegateCall, 'no replay_delegate call found').toBeTruthy();
  });

  it.each(runnerArms.map((a) => ({ n: a.n, line: a.line.trim().slice(0, 90) })))(
    'runner arm at line $n passes the seam name and the story id', ({ n }) => {
      const line = lines[n - 1];
      expect(line, `line ${n} invokes a runner without EPAM_AGENT_NAME="\${STORY_WRITER_SEAM}"`).toMatch(/EPAM_AGENT_NAME="\$\{STORY_WRITER_SEAM\}"/);
      expect(line, `line ${n} invokes a runner without EPAM_STORY_ID`).toMatch(/EPAM_STORY_ID="\$\{story_id\}"/);
    });

  it('the epam arm (multi-line env prefix) carries the seam name beside EPAM_STORY_ID', () => {
    const i = lines.findIndex((l) => /^\s*EPAM_STORY_ID="\$\{story_id\}" \\$/.test(l));
    expect(i, 'the epam arm env prefix was not found').toBeGreaterThan(-1);
    const block = lines.slice(i - 3, i + 1).join('\n');
    expect(block, 'the epam arm passes EPAM_STORY_ID but no EPAM_AGENT_NAME — the recorder files the writer under the story id').toMatch(/EPAM_AGENT_NAME="\$\{STORY_WRITER_SEAM\}"/);
  });

  it('the replay delegate call, executed, hands the runner the seam name and the story id', () => {
    const d = mkdtempSync(join(tmpdir(), 'writer-seam-')); dirs.push(d);
    const envDump = join(d, 'env.txt');
    const runner = join(d, 'ai-run.sh');
    writeFileSync(runner, `#!/bin/bash\ncat >/dev/null\nprintf 'EPAM_AGENT_NAME=%s\\nEPAM_STORY_ID=%s\\n' "\${EPAM_AGENT_NAME:-}" "\${EPAM_STORY_ID:-}" > ${JSON.stringify(envDump)}\necho '{"result":"x"}' > "\${ORCH_JSON_RESULT:-/dev/null}"\n`);
    chmodSync(runner, 0o755);
    const script = join(d, 'run.sh');
    writeFileSync(script, [
      '#!/bin/bash',
      `source ${JSON.stringify(DELEGATE)}`,
      `AI_RUNNER_CMD=${JSON.stringify(runner)}`,
      'STORY_WRITER_SEAM="story-writer"',
      'story_id="FX-7"; prompt="p"; json_result_file="' + join(d, 'r.json') + '"; output_file="' + join(d, 'o.log') + '"; STORY_MODEL=""',
      // THE REAL LINE, lifted from claude.sh.
      delegateCall!.trim().replace(/; then$/, '; then :; fi'),
    ].join('\n'));
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, EPAM_REPLAY_CASSETTE_DIR: d } });
    const got = (() => { try { return readFileSync(envDump, 'utf8'); } catch { return ''; } })();
    expect(got, `the runner was never reached:\n${r.stdout}${r.stderr}`).not.toBe('');
    expect(got).toMatch(/^EPAM_AGENT_NAME=story-writer$/m);
    expect(got).toMatch(/^EPAM_STORY_ID=FX-7$/m);
  });
});
