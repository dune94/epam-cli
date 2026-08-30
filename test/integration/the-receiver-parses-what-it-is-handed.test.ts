/**
 * THE RECEIVER IS runClaude's finishOutput, AND IT MERGES STDERR INTO THE ANSWER.
 *
 *     const finishOutput = () => `${stdout}\n${stderr}`.trim();
 *
 * Every JS-path seam parses THAT string. So anything the pipeline writes to stderr — a provider
 * notice, a banner, a deprecation warning from a future dependency — is concatenated onto the
 * model's reply before any consumer sees it.
 *
 * This is the gap that cost two paid metrolinx runs. The provider notice was moved to stderr and
 * declared fixed, with a test asserting the FUNCTION's stdout was clean. That test passed and the
 * corruption continued, because the receiver never reads that function's stdout — it reads this
 * concatenation. Testing the caller proves nothing about the receiver.
 *
 * These drive the real path: a stub runner writes the answer to stdout and noise to stderr,
 * exactly as the pipeline does, and the assertion is on what the CONSUMER ends up with.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const runner = require('../../orchestrations/scripts/spec-mode-runner.js');
const { declaredContracts, TAG_TO_TOOL } =
  require('../../orchestrations/scripts/lib/agent-output-schema.js');
const { contractStandIn } = require('../../orchestrations/scripts/mock-expectations.js');

const PROJECT = join(__dirname, '../../orchestrations/projects/mock3');
process.env.PRD_FILE = process.env.PRD_FILE || join(PROJECT, 'prd.json');
process.env.EPAM_PROJECT_CONFIG_DIR = process.env.EPAM_PROJECT_CONFIG_DIR || PROJECT;

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The notice that actually did this, in shape. */
const NOISE = [
  "  [provider] 'qwen' is not routable by the 'claude' set — using 'claude'.",
  "  [provider] The set is the launch's own choice; the env value was left by something else.",
].join('\n');

/** A runner that answers on stdout and writes noise on stderr — the shape the pipeline produces. */
function execSpecFor(stdoutText: string, stderrText: string) {
  const dir = mkdtempSync(join(tmpdir(), 'receiver-')); dirs.push(dir);
  const sh = join(dir, 'run.sh');
  writeFileSync(sh, [
    '#!/usr/bin/env bash',
    'cat > /dev/null',
    ...(stderrText ? ["cat >&2 <<'NOISE_EOF'", stderrText, 'NOISE_EOF'] : []),
    "cat <<'ANSWER_EOF'", stdoutText, 'ANSWER_EOF',
  ].join('\n'));
  chmodSync(sh, 0o755);
  return { cmd: sh, args: [] as string[], dir };
}

/** Every seam whose contract declares a tag, with a contract-valid answer for it. */
function taggedSeams(): Array<{ seam: string; tag: string; answer: unknown }> {
  return Object.entries<any>(declaredContracts() || {})
    .filter(([, c]) => c && c.tag)
    .map(([seam, c]) => {
      let answer: unknown = null;
      try { answer = contractStandIn(seam); } catch { answer = null; }
      return { seam, tag: c.tag as string, answer };
    })
    .filter((r) => r.answer);
}

const SEAMS = taggedSeams();

async function receive(tag: string, answer: unknown, noise: string, bare = false) {
  // BARE vs TAGGED is the dimension that matters. A tag brackets the JSON, so trailing noise never
  // reaches the parse — which is why a tagged-only test passed while the corruption continued. The
  // metrolinx reply was BARE: that is what --json-schema returns, and it is the shape the notice
  // actually destroyed.
  const body = bare ? JSON.stringify(answer) : `<${tag}>${JSON.stringify(answer)}</${tag}>`;
  const spec = execSpecFor(body, noise);
  // runClaude IS the receiver: finishOutput concatenates stdout and stderr, and every JS-path seam
  // parses that string. Driving it and then extracting is exactly the sequence the pipeline runs.
  const output = await runner.runClaude(spec, 'a prompt', null, {}, { costAgent: 'receiver-test' });
  return runner.extractTaggedJson(output, tag);
}

describe('the receiver parses what it is handed', () => {
  it('there are seams to drive — an empty table proves nothing', () => {
    expect(SEAMS.length).toBeGreaterThan(3);
  });

  it.each(SEAMS.map((s) => [s.seam, s]))(
    '%s: the answer survives with a clean stderr', async (_n, s: any) => {
      const out = await receive(s.tag, s.answer, '');
      expect(out, `${s.seam} lost its answer even with nothing else on the stream`)
        .toEqual(s.answer);
    }, 90_000);

  it.each(SEAMS.map((s) => [s.seam, s]))(
    '%s: a BARE answer survives stderr noise — the metrolinx shape', async (_n, s: any) => {
      // No tag to bracket the JSON, and the pipeline's own notice concatenated after it. This is
      // exactly what the roster reviewer returned on 2026-08-30, twice.
      const out = await receive(s.tag, s.answer, NOISE, true);
      // NOT toBeTruthy: jsonrepair turns "answer + trailing notice" into a TWO-ELEMENT ARRAY, which
      // is perfectly truthy and is exactly what killed metrolinx —
      //   ROSTER_REVIEW[1]: expected an object, got object
      // (typeof [] is "object", so even the error was misleading). The answer must come back as
      // ITSELF, not as the first item of an array the pipeline's own noise created.
      expect(out, `${s.seam}'s bare answer came back mangled by a line the PIPELINE printed`)
        .toEqual(s.answer);
    }, 90_000);

  it.each(SEAMS.map((s) => [s.seam, s]))(
    '%s: a tagged answer survives noise written to STDERR', async (_n, s: any) => {
      // finishOutput concatenates stderr onto stdout, so this is what the consumer really gets.
      const out = await receive(s.tag, s.answer, NOISE);
      expect(out, `${s.seam}'s answer was destroyed by a line the PIPELINE printed, not the model`)
        .toEqual(s.answer);
    }, 90_000);
});
