/**
 * A RUNNER DECLARATION THAT NEVER REACHES THE RUNNER IS NOT CONFIGURATION.
 *
 * config/llm-defaults.<set>.json declares, per runner, the flags and env a call must carry.
 * resolveRunner()/runnerValues() implement that, are exported, and carry 11 green tests — and
 * had ZERO production callers. Nothing in the pipeline invoked them, so on every Claude-family
 * stack the declared effort, compaction window and output cap reached nothing, and on the
 * mockserver stack the ANTHROPIC_BASE_URL redirect was never exported either: the run would
 * have looked redirected and called the real endpoint. A library with a test but no caller
 * looks covered.
 *
 * Three things the declaration got wrong, found by checking it against the installed CLIs
 * rather than by reading it:
 *   - `alwaysFlags: ["-s"]` on the `claude` runner is codemie-claude's silent flag. Plain
 *     claude has no -s, so wiring the layer unchanged would have failed every call on an
 *     unknown option.
 *   - reasoningEffort was mapped to an env var; the real control is the `--effort` flag.
 *   - autoCompressAt likewise; the real control is `--autocompact`.
 *
 * This drives the REAL hub with a stubbed runner that records its argv, so what is asserted is
 * the command line the pipeline actually builds.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stackNames } from '../../support/llm-settings';

const ROOT = join(__dirname, '../../..');
const HUB = join(ROOT, 'orchestrations/scripts/llm-handler.sh');
const NODE_BIN = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');

/** Run the hub with a stubbed runner binary; return the argv it was handed. */
function argvFor(opts: { set: string; runnerName: string; env?: Record<string, string> }) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-argv-'));
  try {
    const argvFile = join(dir, 'argv.txt');
    const stub = join(dir, opts.runnerName);
    // The stub answers like the real thing: a JSON envelope on stdout, argv recorded on the side.
    writeFileSync(stub, [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}`,
      `cat > /dev/null`,
      `printf '%s' '{"result":"ok","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}'`,
    ].join('\n'));
    chmodSync(stub, 0o755);

    const res = spawnSync('bash', [HUB, '--provider', 'claude'], {
      input: 'hello',
      encoding: 'utf8',
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CLAUDE_CMD: stub,
        NODE_BIN,
        EPAM_PROVIDER_SET: opts.set,
        EPAM_AGENT_NAME: 'runner-declaration-test',
        ...(opts.env || {}),
      },
    });
    const argv = existsSync(argvFile)
      ? readFileSync(argvFile, 'utf8').split('\n').filter(Boolean)
      : null;
    return { argv, stderr: res.stderr || '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the runner declaration reaches the runner', () => {
  it('the harness actually reaches the stub — otherwise every assertion below is vacuous', () => {
    const { argv, stderr } = argvFor({ set: 'claude', runnerName: 'claude' });
    expect(argv, `the hub never invoked the runner. stderr: ${stderr.slice(0, 400)}`).not.toBeNull();
    expect(argv!.length, 'the runner was invoked with no arguments at all').toBeGreaterThan(0);
    expect(argv).toContain('--print');
  });

  it('THE DEFECT: a declared effort reaches the runner as --effort', () => {
    const { argv } = argvFor({
      set: 'claude', runnerName: 'claude', env: { EPAM_REASONING_EFFORT: 'high' },
    });
    expect(argv).not.toBeNull();
    const i = argv!.indexOf('--effort');
    expect(i, `--effort absent; argv was: ${argv!.join(' ')}`).toBeGreaterThan(-1);
    expect(argv![i + 1]).toBe('high');
  });

  it('a declared compaction window reaches the runner as --autocompact', () => {
    const { argv } = argvFor({
      set: 'claude', runnerName: 'claude', env: { EPAM_AUTO_COMPRESS_AT: '150000' },
    });
    const i = argv!.indexOf('--autocompact');
    expect(i, `--autocompact absent; argv was: ${argv!.join(' ')}`).toBeGreaterThan(-1);
    expect(argv![i + 1]).toBe('150000');
  });

  it('a setting the run never states is not passed as an empty flag', () => {
    const { argv } = argvFor({ set: 'claude', runnerName: 'claude' });
    // An empty value must be SKIPPED, never passed as `--effort ""`, which the CLI rejects.
    for (let i = 0; i < argv!.length - 1; i++) {
      if (argv![i].startsWith('--')) {
        expect(argv![i + 1], `${argv![i]} was passed an empty value`).not.toBe('');
      }
    }
    expect(argv![argv!.length - 1], 'a flag was passed with no value at all').not.toMatch(/^--(effort|autocompact)$/);
  });

  it('plain claude is never handed codemie-claude\'s -s', () => {
    const { argv } = argvFor({ set: 'claude', runnerName: 'claude' });
    expect(argv, 'the `claude` CLI has no -s; passing it fails the call on an unknown option')
      .not.toContain('-s');
  });

  it('THE MONEY ONE: the mockserver stack\'s redirect is actually exported', () => {
    // ANTHROPIC_BASE_URL is declared in the mockserver runner's env and was never exported,
    // because nothing called the layer. A free run would have looked redirected and billed the
    // real endpoint. A redirect that is only declared is not a redirect.
    const out = spawnSync(NODE_BIN, ['-e', `
      const { runnerValues } = require(${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/llm-settings-resolve.js'))});
      process.stdout.write(JSON.stringify(runnerValues('claude', {}).env));
    `], { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: 'mockserver' } });
    expect(out.status, out.stderr).toBe(0);
    const env = JSON.parse(out.stdout || '{}');
    expect(Object.keys(env), 'the mockserver runner declares no env at all').toContain('ANTHROPIC_BASE_URL');
    expect(env.ANTHROPIC_BASE_URL, 'the redirect resolved to an empty value and would be skipped').toBeTruthy();
  });

  it('the paid stacks declare no base-url redirect of their own', () => {
    for (const set of ['claude', 'codemie']) {
      const out = spawnSync(NODE_BIN, ['-e', `
        const { runnerValues } = require(${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/llm-settings-resolve.js'))});
        const v = runnerValues(process.argv[1], {});
        process.stdout.write(JSON.stringify(v ? v.env : {}));
      `, set === 'codemie' ? 'codemie-claude' : 'claude'],
        { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: set } });
      expect(Object.keys(JSON.parse(out.stdout || '{}')), `${set} declares a runner env it should not`).toEqual([]);
    }
  });

  it('every declared stack resolves a runner without throwing', () => {
    // A stack whose declaration cannot be read would silently pass NO flags, which looks
    // identical to a stack that declares none.
    for (const set of stackNames()) {
      const out = spawnSync(NODE_BIN, ['-e', `
        const { resolveRunner } = require(${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/llm-settings-resolve.js'))});
        const r = resolveRunner(process.argv[1], {});
        process.stdout.write(JSON.stringify(r === null ? 'none' : Object.keys(r)));
      `, 'claude'], { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: set } });
      expect(out.status, `${set}: resolveRunner threw: ${out.stderr}`).toBe(0);
    }
  });
});
