/**
 * THE DIRECTORIES THE PRD DECLARES ARE REACHABLE BY THE RUNNER.
 *
 * regintel 20260916T200108Z, 2026-09-17, resume on 2.0.50: the writer — now told the PRD's
 * configuration.sourceRepoReadOnly — was refused both Read and Bash on that path by the runner,
 * which confines its tools to the working directory, and reported the wall instead of copying.
 *
 * Two halves, both executed: _declared_read_roots (lib/story-attempt.sh) lists every absolute,
 * existing directory the PRD's configuration names, whatever the key; and the flag assembly
 * lifted from implement_story hands each to the runner with the flag the runner's own --help
 * advertises — asserted on the argv a stub runner received.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function lift(src: string, name: string): string {
  const start = src.indexOf(`\n${name}() {`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 3);
}

/** The flag-assembly lines from implement_story, by their own comment marker. */
function flagAssembly(src: string): string {
  const start = src.indexOf('    # THE DIRECTORIES THE PRD DECLARES ARE REACHABLE BY THE RUNNER.');
  expect(start, 'the read-roots block is not in implement_story').toBeGreaterThan(-1);
  const end = src.indexOf('\n    fi\n', src.indexOf('while IFS= read -r _rr', start));
  return src.slice(start, end + 8);
}

function setup(configuration: Record<string, unknown>, advertises = true) {
  const d = mkdtempSync(join(tmpdir(), 'read-roots-')); dirs.push(d);
  const src = join(d, 'source-repo'); mkdirSync(src);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ configuration, stories: [] }));
  const bin = join(d, 'claude');
  writeFileSync(bin, `#!/usr/bin/env bash\nif [ "\${1:-}" = "--help" ]; then ${advertises ? 'echo "  --add-dir <directories...>  Additional directories"' : 'echo "Usage"'}; exit 0; fi\n`);
  chmodSync(bin, 0o755);
  return { d, src, prd, bin };
}

describe('the runner may reach what the PRD declares', () => {
  const engine = engineSource(CLAUDE_SH);

  it("run 200108Z's shape: an existing absolute directory under any configuration key is listed; author comments and non-directories are not", () => {
    const s = setup({ sourceRepoReadOnly: 'SRC', '$sourceRepoReadOnly': '/etc', llmGateway: 'dial/client.py', nested: { alsoHere: 'SRC/' }, missing: '/no/such/dir' });
    writeFileSync(s.prd, readFileSync(s.prd, 'utf8').replace(/"SRC\/?"/g, JSON.stringify(s.src)));
    const r = spawnSync('bash', ['-c', `${lift(engine, '_declared_read_roots')}\n_declared_read_roots ${JSON.stringify(s.prd)}`], { encoding: 'utf8' });
    expect(r.stdout.trim().split('\n')).toEqual([s.src]);
  });

  it('the runner receives --add-dir <dir> when its --help advertises the flag', () => {
    const s = setup({ sourceRepoReadOnly: 'SRC' });
    writeFileSync(s.prd, readFileSync(s.prd, 'utf8').replace('"SRC"', JSON.stringify(s.src)));
    const script = [
      'set -uo pipefail', 'log(){ :; }', `runner_bin_for(){ printf '%s' ${JSON.stringify(s.bin)}; }`,
      `prd_target=${JSON.stringify(s.prd)}`, 'STORY_PROVIDER=claude', `CLAUDE_CMD=${JSON.stringify(s.bin)}`, 'RUNNER_FLAGS=()',
      lift(engine, '_declared_read_roots'), flagAssembly(engine),
      'printf "%s\\n" "${RUNNER_FLAGS[@]}"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['--add-dir', s.src]);
  });

  it('a runner whose --help does not advertise the flag is handed nothing', () => {
    const s = setup({ sourceRepoReadOnly: 'SRC' }, false);
    writeFileSync(s.prd, readFileSync(s.prd, 'utf8').replace('"SRC"', JSON.stringify(s.src)));
    const script = [
      'set -uo pipefail', 'log(){ :; }', `runner_bin_for(){ printf '%s' ${JSON.stringify(s.bin)}; }`,
      `prd_target=${JSON.stringify(s.prd)}`, 'STORY_PROVIDER=claude', `CLAUDE_CMD=${JSON.stringify(s.bin)}`, 'RUNNER_FLAGS=()',
      lift(engine, '_declared_read_roots'), flagAssembly(engine),
      'echo "N=${#RUNNER_FLAGS[@]}"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(r.stdout.trim(), r.stderr).toBe('N=0');
  });

  it('a PRD with no configuration hands the runner nothing — the negative assertion', () => {
    const s = setup({});
    const script = [
      'set -uo pipefail', 'log(){ :; }', `runner_bin_for(){ printf '%s' ${JSON.stringify(s.bin)}; }`,
      `prd_target=${JSON.stringify(s.prd)}`, 'STORY_PROVIDER=claude', `CLAUDE_CMD=${JSON.stringify(s.bin)}`, 'RUNNER_FLAGS=()',
      lift(engine, '_declared_read_roots'), flagAssembly(engine),
      'echo "N=${#RUNNER_FLAGS[@]}"',
    ].join('\n');
    expect(spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout.trim()).toBe('N=0');
  });
});
