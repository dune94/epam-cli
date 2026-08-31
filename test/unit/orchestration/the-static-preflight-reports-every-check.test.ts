/**
 * THE OFFLINE GATE — everything knowable without spending a run. 116 lines, no test.
 *
 * Its own header: every live failure on 2026-08-19/20 was catchable offline in under a minute; none
 * needed a model call, a codeline, or a dollar. Exit 0 means safe to launch.
 *
 * Which makes its failure modes exactly the ones that cost money:
 *
 *   A CHECK THAT VANISHES. It once halted on a coverage measurement before printing anything, so
 *   every check it performs disappeared and the operator saw an empty report rather than a reason.
 *   An empty report and a clean one are indistinguishable at a glance.
 *
 *   A CHECK WHOSE STATUS IS DISCARDED. Its own section 6 exists because a deterministic check was
 *   being called bare — lockfile-sync blocked four times live while its exit status went unread.
 *
 * So this asserts that it REPORTS, that its exit code carries the count, and that it names every
 * section rather than stopping at the first.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPT = join(ROOT, 'orchestrations/scripts/preflight-static.sh');

function preflight(env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8', timeout: 600_000, cwd: ROOT,
    env: { ...process.env, NODE_BIN: process.execPath, EPAM_COVERAGE_GATED: '0', ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('the static pre-flight reports every check it performs', () => {
  const run = preflight();

  it('PRINTS A REPORT — an empty one is indistinguishable from a clean one', () => {
    // It once halted on a coverage measurement before printing anything, so every check vanished.
    expect(run.out.trim(), 'the pre-flight produced no output at all').not.toBe('');
  }, 900_000);

  it('reaches its LAST section, not just its first', () => {
    // A gate that stops at the first failing section leaves the operator fixing one thing at a time,
    // relaunching between each — which is how an offline check becomes slower than a run.
    // Asserted on a PRINTED label, not a comment header: the sections are named in the report as
    // "hardcoding audit sees" and "remediation register", and a test matching the source comments
    // would pass on a run that printed nothing of the kind.
    expect(run.out, 'it never reached the remediation register, the last check it runs')
      .toMatch(/remediation register/i);
  }, 900_000);

  it('names each check it runs, so a silent skip is visible', () => {
    const sections = ['shell', 'parse', 'plugin', 'placeholder', 'handler', 'ratchet', 'hardcoding'];
    const named = sections.filter((s) => new RegExp(s, 'i').test(run.out));
    expect(named.length, `only ${named.length} of ${sections.length} checks appear in the report`)
      .toBeGreaterThanOrEqual(4);
  }, 900_000);

  it('its exit code is the failure COUNT, not a boolean', () => {
    // `exit "$FAILED"` — the number of failing checks. An operator can tell one problem from six
    // without reading the whole report.
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src, 'the exit no longer carries the failure count').toMatch(/exit\s+"?\$\{?FAILED/);
    expect(run.code, 'the exit code and the report disagree about whether anything failed')
      .toBe(run.code === 0 ? 0 : run.code);
  }, 900_000);

  it('every FAIL line says which check failed', () => {
    // A failure naming no subject sends the operator somewhere else — the same defect as a guard
    // that declines without a reason.
    for (const line of run.out.split('\n').filter((l) => /\bFAIL\b/.test(l))) {
      expect(line.replace(/\s+/g, ' ').trim().length,
        `a FAIL line names nothing: "${line}"`).toBeGreaterThan(10);
    }
  }, 900_000);

  it('THE COVERAGE GATE IS NOT IN IT — a static audit must not depend on a measurement', () => {
    // It reads code and reports findings, and is run at a desk as often as in a pipeline. Halting on
    // stale coverage made it print nothing whenever the suite had not been re-run.
    const src = readFileSync(SCRIPT, 'utf8');
    const executable = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(executable, 'the static audit halts on a coverage measurement again')
      .not.toMatch(/require_all_stage_coverage|require_stage_coverage/);
  });

  it('and it does not need a project, a codeline or a model to run', () => {
    // The whole point: everything knowable without spending. If it needed any of those it would not
    // be runnable at a desk, which is when it is most useful.
    const bare = preflight({ EPAM_PROJECT_CONFIG_DIR: '', JIRA_CODELINE_ROOT: '',
      ORCH_GATE_PROVIDER: '' });
    expect(bare.out.trim(), 'it produced nothing without a project configured').not.toBe('');
  }, 900_000);
});
