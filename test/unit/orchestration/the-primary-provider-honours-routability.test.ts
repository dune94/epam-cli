// THE SET DECIDES, NOT WHATEVER A FILE LEFT IN THE ENVIRONMENT.
//
// resolve_primary_provider() was defined INLINE in llm-handler.sh — the only central LLM
// dispatcher — and unreachable by any other script. change-log/SEAM-CONSISTENCY-ANALYSIS.md found
// 17 seams elsewhere each re-inventing a WEAKER version of the same idea: a hardcoded vendor
// default with no awareness of the active provider set. This extracts the one that already
// survived a real incident (llm-handler.sh's own comment, 2026-08-29: a metrolinx run on
// EPAM_PROVIDER_SET=claude "asked provider 'openrouter' for it, because the repo's .env still
// carried EPAM_ORCHESTRATION_PROVIDER=openrouter from another stack... the run died AFTER the
// roster had been minted and reviewed against real client code") — rather than writing a second,
// simpler one beside it.
//
// A NEAR-MISS DURING THIS EXTRACTION IS WHY ONE TEST BELOW EXISTS SPECIFICALLY: BASH_SOURCE[0]
// read INSIDE a function resolves to the file the function was DEFINED in, not the caller.
// Verified empirically before writing the fix (a two-file bash experiment) — moving the function
// without correcting its SCRIPT_DIR default would have pointed the ladder-providers.js lookup at
// a directory that does not exist, silently emptied $_routable, and reverted every call to "use
// whatever the environment says" — quietly UN-FIXING the 2026-08-29 incident while reporting no
// error at all. That is the exact "looks configured but isn't" class this whole effort exists to
// stop, and it would have been self-inflicted by this very refactor.
//
// These tests EXECUTE the shell function against fixture registries and the REAL ladder-providers.js
// / llm-settings-resolve.js chain — a test that greps for a variable name would pass on a comment.
import { describe, it, expect } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/resolve-primary-provider.sh');

/** jq's real location — not guaranteed to be /usr/bin, and PATH here is otherwise isolated. */
const JQ_DIR = dirname(execSync('command -v jq').toString().trim());
const NODE_DIR = dirname(process.execPath);

function fixture(sets: Record<string, { runner?: string }>, defaultSet: string) {
  const dir = mkdtempSync(join(tmpdir(), 'primary-provider-'));
  mkdirSync(join(dir, 'orchestrations/config'), { recursive: true });
  const psets: any = { defaultSet, sets: {} };
  for (const [name, { runner }] of Object.entries(sets)) {
    psets.sets[name] = { settingsFile: `llm-defaults.${name}.json` };
    writeFileSync(join(dir, 'orchestrations/config', `llm-defaults.${name}.json`),
      JSON.stringify({ runners: runner ? { [runner]: {} } : {} }));
  }
  writeFileSync(join(dir, 'orchestrations/config/provider-sets.json'), JSON.stringify(psets));
  return dir;
}

const ask = (fixtureDir: string, fn: string, env: Record<string, string> = {}) =>
  spawnSync('/bin/bash', ['-c', `set -uo pipefail; . "${LIB}"; ${fn}`], {
    encoding: 'utf8', timeout: 15_000,
    // PATH carries jq, node (ladder-providers.js runs under it) and system bins. Which provider
    // resolves may come ONLY from the fixture and the env under test, never from ambient state —
    // EPAM_PROVIDER_SETS_FILE below points every call at the fixture's own registry.
    env: {
      PATH: `${JQ_DIR}:${NODE_DIR}:/usr/bin:/bin`,
      EPAM_PROVIDER_SETS_FILE: join(fixtureDir, 'orchestrations/config/provider-sets.json'),
      ...env,
    },
  });

describe('resolve_primary_provider — backward compatibility (no argument)', () => {
  it('a run with no declared set is left alone — no preference to contradict', () => {
    const d = fixture({}, '');
    const r = ask(d, 'resolve_primary_provider', { AI_PROVIDER: 'openrouter' });
    expect(r.stdout.trim(), r.stderr).toBe('openrouter');
    rmSync(d, { recursive: true, force: true });
  });

  it('an env value ROUTABLE by the active set is used as-is, no announcement', () => {
    const d = fixture({ claude: { runner: 'claude' } }, 'claude');
    const r = ask(d, 'resolve_primary_provider', { EPAM_PROVIDER_SET: 'claude', AI_PROVIDER: 'claude' });
    expect(r.stdout.trim()).toBe('claude');
    expect(r.stderr.trim()).toBe('');
    rmSync(d, { recursive: true, force: true });
  });

  it('an env value NOT routable by the active set is replaced, and the substitution is ANNOUNCED', () => {
    // The exact 2026-08-29 shape: EPAM_PROVIDER_SET=claude, but the env still says openrouter.
    const d = fixture({ claude: { runner: 'claude' } }, 'claude');
    const r = ask(d, 'resolve_primary_provider',
      { EPAM_PROVIDER_SET: 'claude', EPAM_ORCHESTRATION_PROVIDER: 'openrouter' });
    expect(r.stdout.trim(), r.stderr).toBe('claude');
    expect(r.stderr).toMatch(/'openrouter' is not routable by the 'claude' set — using 'claude'/);
    rmSync(d, { recursive: true, force: true });
  });

  it('EPAM_ORCHESTRATION_PROVIDER is the fallback when AI_PROVIDER is unset', () => {
    const d = fixture({}, '');
    const r = ask(d, 'resolve_primary_provider', { EPAM_ORCHESTRATION_PROVIDER: 'codex' });
    expect(r.stdout.trim()).toBe('codex');
    rmSync(d, { recursive: true, force: true });
  });
});

describe('resolve_primary_provider — the new override parameter (additive)', () => {
  it('a non-empty override takes the exact slot AI_PROVIDER used to occupy', () => {
    const d = fixture({ claude: { runner: 'claude' } }, 'claude');
    const r = ask(d, 'resolve_primary_provider "openrouter"',
      { EPAM_PROVIDER_SET: 'claude', AI_PROVIDER: 'claude' });
    // The override ('openrouter') is not routable by 'claude', so it is substituted — proving the
    // override genuinely reaches the SAME routability check, not a separate unchecked path.
    expect(r.stdout.trim(), r.stderr).toBe('claude');
    expect(r.stderr).toMatch(/'openrouter' is not routable/);
    rmSync(d, { recursive: true, force: true });
  });

  it('an EMPTY override falls through to AI_PROVIDER, not to a blank value', () => {
    const d = fixture({}, '');
    const r = ask(d, 'resolve_primary_provider ""', { AI_PROVIDER: 'claude' });
    expect(r.stdout.trim()).toBe('claude');
    rmSync(d, { recursive: true, force: true });
  });
});

describe('resolve_primary_provider — the SCRIPT_DIR regression (the near-miss)', () => {
  it('finds ladder-providers.js from its OWN location when SCRIPT_DIR is unset — the real prod path', () => {
    // llm-handler.sh's real callers (run-agent-orchestration.sh -> ai-run.sh) never export
    // SCRIPT_DIR, so THIS is the path production actually exercises. Against the REAL registry
    // (no EPAM_PROVIDER_SETS_FILE override), so ladder-providers.js's own require chain is
    // exercised end to end, not a fixture stand-in.
    const r = spawnSync('/bin/bash', ['-c', `set -uo pipefail; . "${LIB}"; resolve_primary_provider`], {
      encoding: 'utf8', timeout: 15_000,
      env: {
        PATH: `${JQ_DIR}:${NODE_DIR}:/usr/bin:/bin`,
        EPAM_PROVIDER_SET: 'claude', EPAM_ORCHESTRATION_PROVIDER: 'openrouter',
      },
    });
    // If SCRIPT_DIR's default pointed at the wrong directory, ladder-providers.js would not be
    // found, $_routable would be silently empty, and this would print 'openrouter' unrouted —
    // the exact incident this function exists to prevent, reintroduced by moving the file.
    expect(r.stdout.trim(), `stderr: ${r.stderr}`).toBe('claude');
    expect(r.stderr).toMatch(/is not routable/);
  });

  it('still respects an explicitly-provided SCRIPT_DIR override', () => {
    const realScriptsDir = join(ROOT, 'orchestrations/scripts');
    const r = spawnSync('/bin/bash', ['-c', `set -uo pipefail; . "${LIB}"; resolve_primary_provider`], {
      encoding: 'utf8', timeout: 15_000,
      env: {
        PATH: `${JQ_DIR}:${NODE_DIR}:/usr/bin:/bin`,
        SCRIPT_DIR: realScriptsDir,
        EPAM_PROVIDER_SET: 'claude', EPAM_ORCHESTRATION_PROVIDER: 'openrouter',
      },
    });
    expect(r.stdout.trim(), `stderr: ${r.stderr}`).toBe('claude');
  });
});

describe('resolve_primary_provider — existing edge behaviour, preserved not improved', () => {
  it('a set with no routable providers at all falls through to the env value unchanged', () => {
    const d = fixture({ empty: {} }, 'empty');
    const r = ask(d, 'resolve_primary_provider', { EPAM_PROVIDER_SET: 'empty', AI_PROVIDER: 'openrouter' });
    expect(r.stdout.trim(), r.stderr).toBe('openrouter');
    rmSync(d, { recursive: true, force: true });
  });

  it('an unknown EPAM_PROVIDER_SET does not throw here — ladder-providers.js swallows it and this ' +
     'falls through to the env value. Documented, not fixed: a separate, later concern.', () => {
    const d = fixture({ claude: { runner: 'claude' } }, 'claude');
    const r = ask(d, 'resolve_primary_provider',
      { EPAM_PROVIDER_SET: 'no-such-set', AI_PROVIDER: 'openrouter' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('openrouter');
    rmSync(d, { recursive: true, force: true });
  });
});
