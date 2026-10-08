/**
 * A RELEASE LINE'S PASS KEEPS ITS OWN CHECKPOINT — NEVER THE CODELINE'S.
 *
 * Live AMSD-2974 run 9 (2026-10-08): the 7.x line's pass paused before its writer and saved its pre-writer checkpoint
 * to runs/<run>/lanes/cxshared/checkpoint — over the codeline's own (8.x) lane checkpoint, its approved spec replaced
 * by the line's. A line pass is identified by the line it runs (EPAM_RELEASE_LINE, set by lib/release-lines.sh).
 *
 * EXECUTED: lib/run-checkpoint.sh checkpoint_dir.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/run-checkpoint.sh');
const dir = (env: Record<string, string>) => spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; checkpoint_dir R1`], {
  encoding: 'utf8', env: { PATH: process.env.PATH || '', EPAM_PROJECT_CONFIG_DIR: '/p', ...env } }).stdout.trim();

describe('where a pass keeps its checkpoint', () => {
  it('a release line\'s pass: under its own line', () => {
    expect(dir({ EPAM_CODELINE: 'lib', EPAM_RELEASE_LINE: '7.x' })).toBe('/p/runs/R1/lanes/lib/lines/7.x/checkpoint');
  });
  it('the codeline\'s own pass: the lane\'s, as before', () => {
    expect(dir({ EPAM_CODELINE: 'lib' })).toBe('/p/runs/R1/lanes/lib/checkpoint');
  });
  it('the line name is made path-safe as the line\'s logs are', () => {
    expect(dir({ EPAM_CODELINE: 'lib', EPAM_RELEASE_LINE: 'release/7 x' })).toBe('/p/runs/R1/lanes/lib/lines/release-7-x/checkpoint');
  });
  it('the run\'s own pass: the run\'s checkpoint, as before', () => {
    expect(dir({})).toBe('/p/runs/R1/checkpoint');
  });
});
