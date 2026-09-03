/**
 * WHAT AN AGENT SAID IS WHAT IT WROTE TO STDOUT.
 *
 * runClaude accumulated both streams and resolved `${stdout}\n${stderr}` on EVERY path, success
 * included. Anything the child logged to stderr became part of what the pipeline believed the
 * model replied.
 *
 * Not hypothetical. .env sets EPAM_ORCHESTRATION_PROVIDER=openrouter, left from the openrouter
 * stack. Launch with EPAM_PROVIDER_SET=claude and that value is unroutable, so llm-handler.sh:62
 * correctly warns — to stderr, on EVERY call:
 *
 *     [provider] 'openrouter' is not routable by the 'claude' set — using 'claude'.
 *     [provider] The set is the launch's own choice; the env value was left by something else.
 *
 * Those lines were welded onto every agent reply. Measured 2026-09-01: 4 of 4 generated metrolinx
 * prompts carried them in the prompt BODY, cached and marked reviewed:true — every downstream agent
 * would have executed a contract with pipeline log noise inside it. The mock3 cache, written before
 * the stray variable existed, has 0 of 39. The contamination tracks the stderr chatter exactly.
 *
 * The wider cost is the JSON seams: a reply parsed as JSON with two log lines welded to the end is
 * unparseable, and "no parseable verdict" has killed runs here repeatedly.
 *
 * WHY NOT SIMPLY DROP STDERR. It was merged deliberately. On 2026-07-23 the code-graph-detective
 * emitted perfect fix-site JSON, exited non-zero, and runClaude discarded everything. The reply of
 * a FAILING call is evidence and must be kept. So the rule is per-path:
 *
 *   SUCCESS (exit 0)   -> stdout only. This is the model's answer.
 *   FAILURE / TIMEOUT  -> both streams. This is evidence, and stderr is the useful half.
 *
 * THIS TEST EXECUTES runClaude against a real child process. The first version asserted on source
 * text, found `const output = finishOutput()`, saw no "stderr" in that expression and passed —
 * fooled by one level of indirection while the defect sat inside the function it named. A reply is
 * an artefact; it has to be produced and inspected, never inferred from the code that makes it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(process.cwd(), 'orchestrations/scripts/spec-mode-runner.js'));

const OUT = 'THE MODEL ANSWER {"verdict":"sound"}';
const ERR = "  [provider] 'openrouter' is not routable by the 'claude' set — using 'claude'.";

/** A child that writes to both streams and exits with the given code. */
function child(code: number) {
  return {
    cmd: 'sh',
    args: ['-c', `cat >/dev/null; printf '%s\\n' ${JSON.stringify(OUT)}; `
      + `printf '%s\\n' ${JSON.stringify(ERR)} >&2; exit ${code}`],
  };
}

const logPath = () => join(mkdtempSync(join(tmpdir(), 'runclaude-')), 'call.log');

describe('a successful reply is stdout only', () => {
  it('the harness works — a successful call returns what the child printed', async () => {
    // Non-vacuity: if the child never runs, every assertion below passes on an empty string.
    const out = await spec.runClaude(child(0), 'prompt', logPath(), {}, {});
    expect(String(out), 'the child produced nothing — the assertions below prove nothing')
      .toContain('THE MODEL ANSWER');
  });

  it('SUCCESS: the stderr log line is NOT part of the reply', async () => {
    const out = await spec.runClaude(child(0), 'prompt', logPath(), {}, {});
    expect(String(out),
      'a pipeline log line written to stderr was returned as part of the model\'s reply — this is '
      + 'what contaminated 4 of 4 generated metrolinx prompts')
      .not.toContain('[provider]');
  });

  it('SUCCESS: and the reply is still parseable as what the model emitted', async () => {
    // The consequence that costs runs. Welding two log lines onto a JSON reply breaks the parse,
    // and the caller reports "no parseable verdict" about a model that answered correctly.
    const out = String(await spec.runClaude(child(0), 'prompt', logPath(), {}, {}));
    const json = out.slice(out.indexOf('{'));
    expect(() => JSON.parse(json),
      `the reply does not parse as the JSON the child emitted: ${JSON.stringify(out.slice(-160))}`)
      .not.toThrow();
  });

  it('FAILURE: a non-zero exit still carries stderr — that evidence is the useful half', async () => {
    // The 2026-07-23 regression guard. Losing this is worse than the contamination.
    await expect(spec.runClaude(child(3), 'prompt', logPath(), {}, {}))
      .rejects.toThrow(/provider|openrouter/);
  });

  it('FAILURE with salvage: the caller opting in still receives what the child wrote', async () => {
    const out = await spec.runClaude(child(3), 'prompt', logPath(), {}, { salvageOutputOnFailure: true });
    expect(String(out), 'salvage no longer returns the child output').toContain('THE MODEL ANSWER');
  });
});
