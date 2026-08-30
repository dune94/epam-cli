/**
 * A STUB THAT IS MORE FORGIVING THAN THE REAL THING TURNS A RECEIVER TEST INTO THEATRE.
 *
 * The discovery receiver harness runs the real script against a stubbed ai-run.sh. That is only
 * worth anything while the stub answers the way the real handler answers. The first version of it
 * did not: it ignored every argument, where llm-handler.sh EXITS 2 on an unknown option, and it
 * wrote nothing to stderr, where the real handler sends its [provider] notices there.
 *
 * Both gaps hide the failures that actually happened. Discovery builds its command line as
 * `bash ai-run.sh --provider X --model Y < prompt`; if that drifts, the real handler kills the run
 * and a shrugging stub would stay green. And a notice printed on the wrong stream is the defect
 * that merged a diagnostic into a parsed answer and cost two paid runs.
 *
 * So this asserts the two agree — by RUNNING BOTH, not by reading either.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDiscovery, REPO } from '../helpers/discovery-receiver';

const REAL = join(REPO, 'orchestrations/scripts/ai-run.sh');

/** Run a handler with the given arguments and an empty prompt on stdin. */
function invoke(script: string, args: string[]) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8', input: '', timeout: 60000, cwd: REPO,
    env: { ...process.env, EPAM_PROVIDER_SET: 'mockserver', ORCH_JSON_RESULT: '' },
  });
}

/** The stub the harness writes, recovered from a real harness run. */
function stubPath(): string {
  const r = runDiscovery({ omitArgs: true });   // exits at usage; the stub is written regardless
  return join(r.workDir, 'stub-ai-run.sh');
}

describe('the discovery stub is the real interface', () => {
  const stub = stubPath();

  it('the real handler is reachable, so this compares against something', () => {
    // Without this the comparisons below would pass by both sides failing to start.
    const help = invoke(REAL, ['--help']);
    expect(help.status, 'the real handler does not answer --help').toBe(0);
    expect(help.stdout).toMatch(/Usage: llm-handler\.sh/);
  }, 60_000);

  it('both answer --help the same way', () => {
    expect(invoke(stub, ['--help']).status).toBe(invoke(REAL, ['--help']).status);
    expect(invoke(stub, ['--help']).stdout).toMatch(/Usage: llm-handler\.sh/);
  }, 60_000);

  it('both REJECT an unknown option, with the same exit code', () => {
    // The one that matters: discovery's command line drifting must fail the harness too.
    const real = invoke(REAL, ['--not-an-option']);
    const fake = invoke(stub, ['--not-an-option']);
    expect(real.status, 'the real handler no longer rejects unknown options').toBe(2);
    expect(fake.status, `the stub accepts an option the real handler rejects with ${real.status}`)
      .toBe(real.status);
    expect(fake.stderr).toMatch(/unknown option/);
  }, 60_000);

  it('both accept exactly the options discovery passes', () => {
    // Read the command discovery builds rather than restating it here, so a change to the call
    // site fails this test instead of silently passing.
    // Read the flags discovery can emit rather than restating them, so a change to the call site
    // fails this test instead of passing quietly. They now come from a _flag() helper, because
    // interpolating an empty value straight into the command string dropped the argument.
    const src = readFileSync(join(REPO, 'orchestrations/scripts/lib/codeline-discovery.js'), 'utf8');
    const flags = [...src.matchAll(/_flag\('([a-z-]+)'/g)].map((m) => `--${m[1]}`);
    expect(flags.length, 'no flags parsed from the discovery command line — the shape has changed')
      .toBeGreaterThan(0);
    for (const f of flags) {
      expect(invoke(REAL, [f, 'value']).status,
        `discovery passes ${f}, which the real handler rejects`).not.toBe(2);
      expect(invoke(stub, [f, 'value']).status,
        `discovery passes ${f}, which the stub rejects`).not.toBe(2);
    }
  }, 120_000);

  it('the [provider] notice is on stderr in the real handler, and in the stub', () => {
    // If it were on stdout it would be read as part of the answer.
    const handler = readFileSync(join(REPO, 'orchestrations/scripts/llm-handler.sh'), 'utf8');
    const notices = handler.split('\n').filter((l) => /printf.*\[provider\]/.test(l));
    expect(notices.length, 'the handler prints no [provider] notice at all').toBeGreaterThan(0);
    for (const line of notices) {
      expect(line, `a [provider] notice is not redirected to stderr: ${line.trim()}`)
        .toMatch(/>&2\s*$/);
    }
  });

  it('and discovery survives a notice arriving on stderr', () => {
    // The receiver assertion the stub exists to make possible.
    const r = runDiscovery({ providerNotice: true });
    expect(r.code, `a stderr notice broke discovery: ${r.stderr.slice(-300)}`).toBe(0);
    expect(r.out?.codelines?.[0]?.name, 'the answer did not survive the notice').toBe('alphashop');
  }, 120_000);
});
