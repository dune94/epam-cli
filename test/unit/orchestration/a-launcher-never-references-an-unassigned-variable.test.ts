/**
 * AN UNASSIGNED VARIABLE KILLS A LAUNCHER AT RUNTIME, AND `bash -n` CANNOT SEE IT.
 *
 * Every launcher runs under `set -u`, so the FIRST expansion of a variable nobody assigned aborts
 * the run — at whatever line it happens to sit on, however late. Syntax checking passes it happily;
 * only executing that exact line, or a linter told to look, ever finds it.
 *
 * Live 2026-09-04, pipeline-tests-16: a launch died at
 *
 *     tier3-metrolinx-run.sh: line 488: CONFIG_DIR: unbound variable
 *
 * on a line that did nothing at all — vestigial scaffolding left behind while editing the
 * observability gate, which `bash -n` had already declared clean. Pre-flight had passed, the
 * dashboard mounts were correct, the reset had completed; the run died on dead code.
 *
 * shellcheck ALREADY detects this as SC2154, but only with `-o all` — it is off by default, which
 * is why every existing shellcheck-based test in this suite missed it. This turns it on, for the
 * launchers, where an unbound variable costs a whole run.
 *
 * DERIVED, NEVER LISTED: the launchers are discovered by pattern, so one added tomorrow is checked
 * tomorrow rather than whenever someone remembers this file.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const SCRIPTS = path.join(REPO, 'orchestrations/scripts');

/** Every launcher, plus the pre-launch scripts they all call. */
const TARGETS = [
  ...fs.readdirSync(SCRIPTS).filter((f) => /^tier\d+-[a-z0-9-]+-run\.sh$/.test(f)),
  'preflight-check.sh',
  'pre-run-reset.sh',
  'ingest-jira-tickets.sh',
].filter((f) => fs.existsSync(path.join(SCRIPTS, f)));

/** SC2154 findings only: "X is referenced but not assigned". */
function unassignedRefs(file: string): string[] {
  let out = '';
  try {
    out = execFileSync('shellcheck', ['-o', 'all', '-f', 'gcc', file], { encoding: 'utf8' });
  } catch (e: any) {
    out = `${e.stdout ?? ''}`;   // shellcheck exits non-zero when it has findings
  }
  return out.split('\n').filter((l) => l.includes('SC2154'));
}

describe('no launcher references a variable nobody assigned — set -u turns that into a dead run', () => {
  it('there are launchers to check', () => {
    expect(TARGETS.length, 'no launchers found — this test would pass vacuously').toBeGreaterThan(2);
  });

  it.each(TARGETS)('%s', (f) => {
    const file = path.join(SCRIPTS, f);
    const findings = unassignedRefs(file);
    expect(findings, [
      `${f} expands a variable that is never assigned. Under \`set -u\` the first time that line is`,
      'reached the run dies — and `bash -n` passes it, which is exactly how',
      '"tier3-metrolinx-run.sh: line 488: CONFIG_DIR: unbound variable" reached a live launch.',
      '',
      ...findings,
    ].join('\n')).toEqual([]);
  });

  it('shellcheck is actually running — a silent scanner would make every case above vacuous', () => {
    // The same trap the-shell-is-read-statically.test.ts fell into: it asserted "no findings" while
    // the scanner was returning nothing at all, so it passed against a codebase it never read.
    const probe = path.join(REPO, 'node_modules/.cache/sc-probe.sh');
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, '#!/bin/bash\nset -u\nif [ -f "$DEFINITELY_NOT_ASSIGNED/x" ]; then :; fi\n');
    try {
      expect(unassignedRefs(probe).length,
        'shellcheck -o all reported nothing for a KNOWN unassigned variable — the checks above prove nothing')
        .toBeGreaterThan(0);
    } finally { fs.rmSync(probe, { force: true }); }
  });
});
