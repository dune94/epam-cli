/**
 * AN EMPTY VALUE DOES NOT PRODUCE AN EMPTY ARGUMENT — IT PRODUCES NO ARGUMENT.
 *
 * codeline-discovery.js builds its call as a STRING and interpolates two values into it:
 *
 *     `bash ${AI_RUN_SH} --provider ${PROVIDER} --model ${MODEL()} < ${tmpPrompt}`
 *
 * PROVIDER is allowed to be empty — its default is `''` when neither ORCH_GATE_PROVIDER nor
 * EPAM_ORCHESTRATION_PROVIDER is set. The shell then collapses the gap, and the vector that
 * actually arrives is:
 *
 *     --provider  --model  claude-sonnet-5
 *
 * llm-handler.sh reads `--provider`, takes the NEXT token as its value — `--model` — and then meets
 * the model name as a bare word: "unknown option 'claude-sonnet-5'", exit 2.
 *
 * Discovery sees no output and reports "the answer was EMPTY (no text at all — a transport or
 * budget failure, not a format one)". That sentence sends an operator to timeouts and credits. The
 * fault was one empty string, three attempts earlier.
 *
 * It bites only when the project env fails to reach the child, which is why it survives: a run with
 * config.<set>.env loaded works, and the same code on a run without it dies claiming transport.
 *
 * THE ASSERTION IS ON THE VECTOR, not on the string that produced it — a test reading the template
 * would pass while the shell did something else with it.
 */
import { describe, it, expect } from 'vitest';
import { runDiscovery } from '../helpers/discovery-receiver';

/** Neither variable set: the state in which the default `''` is used. */
const NO_PROVIDER = { ORCH_GATE_PROVIDER: '', EPAM_ORCHESTRATION_PROVIDER: '' };

describe('a seam never calls with an empty flag value', () => {
  it('the stub records a vector at all — otherwise nothing below is evidence', () => {
    const r = runDiscovery({ env: NO_PROVIDER });
    expect(r.stubArgv.length, 'the handler was never invoked, so no vector was captured')
      .toBeGreaterThan(0);
  }, 120_000);

  it('no flag is followed by another flag', () => {
    // The general property. A value that vanished leaves its flag pointing at the next flag, and
    // every argument after that is off by one.
    const r = runDiscovery({ env: NO_PROVIDER });
    for (const argv of r.stubArgv) {
      for (let i = 0; i < argv.length - 1; i += 1) {
        if (!argv[i].startsWith('--')) continue;
        expect(argv[i + 1].startsWith('--'),
          `${argv[i]} is followed by ${argv[i + 1]}: its value was empty and the shell dropped it`
          + `\n  vector: ${argv.join(' ')}`).toBe(false);
      }
    }
  }, 120_000);

  it('and the model name arrives as a value, never as a bare word', () => {
    // The specific consequence: the handler met the model as an unknown option and exited 2.
    const r = runDiscovery({ env: NO_PROVIDER });
    for (const argv of r.stubArgv) {
      const i = argv.indexOf('--model');
      expect(i, `no --model in the vector: ${argv.join(' ')}`).toBeGreaterThan(-1);
      expect(argv[i + 1], 'the model has no value').toBeTruthy();
      expect(argv[i + 1].startsWith('--'), 'the model name is being read as an option').toBe(false);
    }
  }, 120_000);

  it('discovery still completes when no provider is configured', () => {
    // The handler resolves the provider from the active set when it is not told one — `if [ -n
    // "$PRIMARY_PROVIDER" ]`. So the correct behaviour is to omit the flag, not to invent a value
    // and not to die.
    const r = runDiscovery({ env: NO_PROVIDER });
    expect(r.code, `discovery failed with no provider configured: ${r.stderr.slice(-400)}`).toBe(0);
    expect(r.out?.codelines?.[0]?.name).toBe('alphashop');
  }, 120_000);

  it('a configured provider is still passed through — the negative half', () => {
    // Dropping the flag whenever it looked awkward would stop the caller ever choosing a provider.
    const r = runDiscovery({ env: { EPAM_ORCHESTRATION_PROVIDER: 'claude' } });
    const argv = r.stubArgv[0] || [];
    const i = argv.indexOf('--provider');
    expect(i, `--provider was dropped although one was configured: ${argv.join(' ')}`)
      .toBeGreaterThan(-1);
    expect(argv[i + 1], 'the configured provider did not reach the handler').toBe('claude');
  }, 120_000);
});
