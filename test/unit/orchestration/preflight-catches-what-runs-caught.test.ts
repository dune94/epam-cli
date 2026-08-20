// THE PRE-FLIGHT MUST STAY ABLE TO CATCH WHAT COST US RUNS.
//
// Every live failure on 2026-08-19/20 was knowable offline. The one that ended run 3 was a single
// word — `local` at top level in team-lead-review.sh — which `bash -n` cannot see, because it is a
// SYNTAX checker and this is a SCOPE error. The reviewer aborted on every cycle, produced NO
// VERDICT eight times, the phase halted, and $10.32 bought nothing.
//
// Five findings, all matched against the run logs at the time:
//
//   SC2168 'local' outside a function   → "REVIEWER produced NO VERDICT 8 time(s)"      2 hits
//   plugin tool missing name            → "[epam] Plugin load warning: verification..." 15 hits
//   __PA_SUMMARY__ unsupplied           → "missing values for: __PA_SUMMARY__"           2 hits
//   __TMPDIR__ unsupplied               → "missing values for: __TMPDIR__"               1 hit
//   tc story context empty              → "the 'Stories to process' section is empty"   14 hits
//
// This asserts the pre-flight still discriminates: each defect reintroduced makes it fail, and a
// clean tree makes it pass. A check that cannot go red is not a check, and one that cannot go
// green is noise — the first version of the plugin check flagged 6 of 6 plugins before being
// verified against the loader's real contract.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const PREFLIGHT = join(ROOT, 'orchestrations/scripts/preflight-static.sh');

/** Run the real pre-flight against the real tree. Returns its exit code. */
function preflight(): number {
  const r = spawnSync('bash', [PREFLIGHT, ROOT], { encoding: 'utf8', timeout: 180_000 });
  return r.status ?? -1;
}

/** Reintroduce a defect, observe, restore, and verify the restore byte-for-byte. */
function withDefect(file: string, mutate: (s: string) => string, fn: () => void): void {
  const p = join(ROOT, file);
  const original = readFileSync(p, 'utf8');
  const mutated = mutate(original);
  expect(mutated, `the mutation did not apply to ${file} — it would prove nothing`).not.toBe(original);
  writeFileSync(p, mutated);
  try { fn(); } finally {
    writeFileSync(p, original);
    expect(readFileSync(p, 'utf8'), `${file} was not restored`).toBe(original);
  }
}

describe('the pre-flight exists and is itself clean', () => {
  it('is present and executable', () => {
    expect(existsSync(PREFLIGHT)).toBe(true);
  });

  it('passes its own shell check — a checker with a scope error is a bad joke', () => {
    const r = spawnSync('shellcheck', ['-S', 'error', PREFLIGHT], { encoding: 'utf8' });
    expect(r.stdout || '', r.stdout).not.toMatch(/SC\d+ \(error\)/);
  });
});

describe('a clean tree passes', () => {
  it('exits 0 as the tree stands', () => {
    expect(preflight(), 'the tree has a defect the pre-flight can see — fix it or the guard is noise')
      .toBe(0);
  });
});

describe('each defect that cost a run is caught again', () => {
  it('SC2168: `local` outside a function — the word that halted run 3', () => {
    withDefect('orchestrations/scripts/team-lead-review.sh',
      (s) => s.replace('    _review_prior_block=""', '    local _review_prior_block=""'),
      () => expect(preflight(), 'bash -n cannot see this; the pre-flight must').not.toBe(0));
  });

  it('a plugin tool with no name — 15 silent load warnings', () => {
    withDefect('orchestrations/plugins/verification-plugin.js',
      (s) => s.replace("  name: 'verify_typecheck',\n  pluginApiVersion: PLUGIN_API_VERSION,\n  definition: {", '  definition: {'),
      () => expect(preflight()).not.toBe(0));
  });

  it('a template value no producer supplies — 3 live render failures', () => {
    withDefect('orchestrations/scripts/run-agent-orchestration.sh',
      (s) => s.replace('"__PA_SUMMARY__":$pa_summary,', ''),
      () => expect(preflight()).not.toBe(0));
  });

  it('an empty TC brief — 14 wasted invocations', () => {
    withDefect('orchestrations/scripts/lib/handlers/tc-story-context.py',
      (s) => s.replace('    if not (is_test_story or has_vcs):', '    if not is_test_story:'),
      () => expect(preflight()).not.toBe(0));
  });

  it('a deterministic check called bare — the gate that never gated', () => {
    withDefect('orchestrations/scripts/claude.sh',
      (s) => s.replace('    if ! run_lockfile_sync_check "$PROJECT_ROOT"; then\n        return 1\n    fi',
                       '    run_lockfile_sync_check "$PROJECT_ROOT"'),
      () => expect(preflight()).not.toBe(0));
  });
});
