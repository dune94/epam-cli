/**
 * Detective timeout floor (found live 2026-07-24, AMSD-1820 run): the code-graph
 * detective runs up to EPAM_MAX_ITERATIONS=10 tool-call iterations, yet its default
 * timeout was 240000ms — SHORTER than a single normal prompt's RUNCLAUDE_TIMEOUT_MS
 * default (360000ms). An agent that does MORE work should not time out SOONER. The
 * detective log showed it actively exploring (10KB, 18 tool markers) when it hit the
 * 240s wall on a large repo. Invariant: the detective's default timeout must be at
 * least the general prompt timeout. (Env-overridable per project for slow codelines.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

function defaultOf(re: RegExp): number {
  const m = src.match(re);
  return m ? Number(m[1]) : NaN;
}

describe('detective timeout is not shorter than a normal prompt timeout', () => {
  it('CODEGRAPH_DETECTIVE_TIMEOUT_MS default >= RUNCLAUDE_TIMEOUT_MS default', () => {
    const general = defaultOf(/RUNCLAUDE_TIMEOUT_MS \|\| '(\d+)'/);
    const detective = defaultOf(/CODEGRAPH_DETECTIVE_TIMEOUT_MS \|\| '(\d+)'/);
    expect(general).toBeGreaterThan(0);
    expect(detective).toBeGreaterThanOrEqual(general);
  });

  it('no detective timeout default is left at the too-low 240000', () => {
    expect(src).not.toMatch(/CODEGRAPH_DETECTIVE_TIMEOUT_MS \|\| '240000'/);
  });
});
