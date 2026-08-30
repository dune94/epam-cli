/**
 * EVERY DECLARED SEAM, EXERCISED THROUGH THE REAL HUB.
 *
 * Discovery emitted `--provider --model claude-sonnet-5` because an empty value interpolated into a
 * command STRING does not become an empty argument — it becomes no argument, and the flag swallows
 * whatever follows. llm-handler.sh then took '--model' as the provider and met the model name as a
 * bare word: "unknown option", exit 2. Discovery reported "the answer was EMPTY ... a transport or
 * budget failure", which is not what happened.
 *
 * That defect is invisible to every test that reads the template, and to every test that stubs
 * above the hub. It is only visible in the ARGUMENT VECTOR the runner binary receives. So these run
 * the real llm-handler.sh with the runner stubbed underneath it, once per declared seam, and assert
 * on the vector and the prompt that actually arrived.
 *
 * The seam list is read from invocation-profiles.json, so a seam added tomorrow is covered without
 * editing this file — and a seam that stops resolving fails here rather than in a paid run.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callSeamThroughHub, declaredSeams, seamProfile, REPO } from '../helpers/seam-receiver';

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { coverageFor } = require(join(REPO, 'test/helpers/v8-line-coverage.js'));

const SEAMS = declaredSeams();
const COV = mkdtempSync(join(tmpdir(), 'seam-cov-'));

/** One call per seam, made once and shared by the assertions below. */
const results = new Map<string, ReturnType<typeof callSeamThroughHub>>();
function called(seam: string) {
  if (!results.has(seam)) {
    results.set(seam, callSeamThroughHub(seam, `prompt for ${seam}`, { covDir: COV }));
  }
  return results.get(seam)!;
}

describe('every seam reaches its runner with a well-formed call', () => {
  it('there are seams to check, and they come from the registry', () => {
    // Guards the vacuous pass: an empty list would make every it.each below vanish silently.
    expect(SEAMS.length, 'the registry declares no seams').toBeGreaterThan(30);
  });

  it.each(SEAMS)('%s: reaches the runner at all', (seam) => {
    const r = called(seam);
    expect(r.runnerArgv.length,
      `the hub never invoked a runner for ${seam}: exit ${r.code}\n${r.stderr.slice(-300)}`)
      .toBeGreaterThan(0);
  }, 120_000);

  it.each(SEAMS)('%s: no flag in the vector is followed by another flag', (seam) => {
    // THE DEFECT, generalised. A value that vanished leaves its flag pointing at the next flag and
    // every argument after it off by one.
    for (const argv of called(seam).runnerArgv) {
      for (let i = 0; i < argv.length - 1; i += 1) {
        if (!argv[i].startsWith('--')) continue;
        const next = argv[i + 1];
        if (!next.startsWith('--')) continue;
        // A boolean flag legitimately has no value. It is only a defect when the flag is one that
        // TAKES a value, which the registry and the runner declaration know about.
        expect(VALUE_FLAGS.has(argv[i]),
          `${seam}: ${argv[i]} takes a value and is followed by ${next} — the value was empty and `
          + `the shell dropped it\n  vector: ${argv.join(' ')}`).toBe(false);
      }
    }
  }, 120_000);

  it.each(SEAMS)('%s: the prompt arrives at the runner, not an empty stdin', (seam) => {
    // A seam whose prompt renders empty still "succeeds" — the model answers something. This is the
    // dead-render defect, caught where it is observable.
    const r = called(seam);
    expect(r.prompts.length, `${seam} sent no prompt at all`).toBeGreaterThan(0);
    expect(r.prompts[0].trim().length, `${seam} sent an EMPTY prompt to the runner`)
      .toBeGreaterThan(10);
    expect(r.prompts[0], `${seam}'s own prompt text did not reach the runner`)
      .toContain(`prompt for ${seam}`);
  }, 120_000);

  it.each(SEAMS)('%s: the runner answer comes back to the caller intact', (seam) => {
    // The receiving half: whatever the runner said must reach the hub's stdout unchanged, with no
    // diagnostic merged into it. A [provider] notice on stdout is exactly this failure.
    const r = called(seam);
    expect(r.stdout.trim(), `${seam}: the hub did not return the runner's answer`)
      .toBe('{"ok":true}');
  }, 120_000);

  it.each(SEAMS)('%s: a runner that fails is not reported as an answer', (seam) => {
    const r = callSeamThroughHub(seam, `prompt for ${seam}`, { exitCode: 1, reply: '', covDir: COV });
    expect(r.code === 0 && r.stdout.trim() !== '',
      `${seam}: the runner exited 1 and said nothing, and the hub reported success`).toBe(false);
  }, 120_000);

  it('every seam declares what it produces, so an output has somewhere to go', () => {
    // The consumer side of the contract. A seam producing nothing named cannot have its output
    // read by anything.
    const silent = SEAMS.filter((s) => !(seamProfile(s) || {}).produces);
    expect(silent, 'these seams declare no `produces`, so no consumer can be named').toEqual([]);
  });

  it('RECEIVER COVERAGE OF THE HUB IS MEASURED, NOT ASSUMED', () => {
    const files = [join(REPO, 'orchestrations/scripts/lib/seam-invocation.js')];
    const report = coverageFor(COV, files);
    let covered = 0; let total = 0;
    for (const v of Object.values<any>(report)) { covered += v.covered; total += v.total; }
    expect(total, 'nothing was measured — the harness ran nothing').toBeGreaterThan(0);
  });
});

/** Flags that take a value. A boolean flag followed by another flag is correct, not a defect. */
const VALUE_FLAGS = new Set(['--provider', '--model', '--output-format', '--json-schema',
  '--effort', '--max-turns', '--append-system-prompt', '--allowedTools', '--json-result']);
