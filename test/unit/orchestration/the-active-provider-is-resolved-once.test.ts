// ONE FUNCTION RESOLVES THE ACTIVE PROVIDER. Every one of 17 seams (see
// change-log/SEAM-CONSISTENCY-ANALYSIS.md) had its own copy of "${SOME_PROVIDER:-<vendor>}",
// and none of those copies consulted EPAM_PROVIDER_SET — a swap made because a provider ran out
// of tokens left them all calling the exhausted vendor anyway.
//
// THE OVERRIDE IS REAL AND MUST BE RESPECTED. ORCH_GATE_PROVIDER is deliberately preserved across
// a .env reload in run-agent-orchestration.sh (lines 292, 313) so a tier script can intentionally
// point gates at a specific vendor. This resolver is only for what happens when NO override is
// given — and that fallback must derive from the active set, never guess a vendor, per
// provider-sets.json's own $comment: "falling back would run a whole programme on the wrong stack
// while looking configured."
//
// These tests EXECUTE the shell function against fixture registries — a test that greps the
// source for a variable name would pass on a comment.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/resolve-active-provider.sh');

function fixture(sets: Record<string, { runner: string }>, defaultSet: string) {
  const dir = mkdtempSync(join(tmpdir(), 'active-provider-'));
  mkdirSync(join(dir, 'orchestrations/config'), { recursive: true });
  const psets: any = { defaultSet, sets: {} };
  for (const [name, { runner }] of Object.entries(sets)) {
    psets.sets[name] = { settingsFile: `llm-defaults.${name}.json` };
    writeFileSync(join(dir, 'orchestrations/config', `llm-defaults.${name}.json`),
      JSON.stringify({ runners: { [runner]: {} } }));
  }
  writeFileSync(join(dir, 'orchestrations/config/provider-sets.json'), JSON.stringify(psets));
  return dir;
}

const ask = (fixtureDir: string, fn: string, env: Record<string, string> = {}) =>
  spawnSync('/bin/bash', ['-c', `set -uo pipefail; . "${LIB}"; ${fn}`], {
    encoding: 'utf8', timeout: 15_000,
    // PATH ISOLATED TO SYSTEM BINS: bash needs jq, cat and friends, but nothing about which
    // provider is chosen may come from anywhere except the fixture and the env under test.
    // PATH carries jq's real location (not guaranteed to be /usr/bin — it is a hard dependency
    // per install.sh, but where it lives varies by machine) plus system bins for bash itself.
    // Nothing about WHICH provider is chosen may come from anywhere except the fixture and env.
    env: {
      PATH: `${require('path').dirname(require('child_process').execSync('command -v jq').toString().trim())}:/usr/bin:/bin`,
      EPAM_PROVIDER_SETS_FILE: join(fixtureDir, 'orchestrations/config/provider-sets.json'), ...env,
    },
  });

describe('resolve_active_provider', () => {
  it('resolves the runner of the DEFAULT set when EPAM_PROVIDER_SET is unset', () => {
    const d = fixture({ claude: { runner: 'claude' }, codemie: { runner: 'codemie-claude' } }, 'claude');
    const r = ask(d, 'resolve_active_provider');
    expect(r.stdout.trim(), r.stderr).toBe('claude');
    expect(r.status).toBe(0);
    rmSync(d, { recursive: true, force: true });
  });

  it('resolves the runner of the DECLARED set, not the default, when EPAM_PROVIDER_SET is set', () => {
    const d = fixture({ claude: { runner: 'claude' }, codemie: { runner: 'codemie-claude' } }, 'claude');
    const r = ask(d, 'resolve_active_provider', { EPAM_PROVIDER_SET: 'codemie' });
    expect(r.stdout.trim(), r.stderr).toBe('codemie-claude');
    rmSync(d, { recursive: true, force: true });
  });

  it('MOVES WITH A SWAP: the same call resolves differently before and after EPAM_PROVIDER_SET changes', () => {
    // The exact scenario hot-swap exists for: a provider runs out mid-programme and the operator
    // swaps. A resolver that cached its answer, or read the value once at process start, would
    // fail this the same way the 17 broken seams did.
    const d = fixture({ claude: { runner: 'claude' }, codemie: { runner: 'codemie-claude' } }, 'claude');
    const before = ask(d, 'resolve_active_provider', { EPAM_PROVIDER_SET: 'claude' });
    const after = ask(d, 'resolve_active_provider', { EPAM_PROVIDER_SET: 'codemie' });
    expect(before.stdout.trim()).toBe('claude');
    expect(after.stdout.trim()).toBe('codemie-claude');
    rmSync(d, { recursive: true, force: true });
  });

  it('respects an explicit override — a tier script pointing a gate at a specific vendor on purpose', () => {
    const d = fixture({ claude: { runner: 'claude' } }, 'claude');
    const r = ask(d, 'resolve_active_provider "openrouter"');
    expect(r.stdout.trim()).toBe('openrouter');
    rmSync(d, { recursive: true, force: true });
  });

  it('an EMPTY override is not a real override — falls through to the active set, never to a literal', () => {
    // The 17 broken seams all had this shape: "${VAR:-openrouter}" where VAR was usually empty.
    // An empty string reaching the resolver must behave exactly like no argument at all.
    const d = fixture({ codemie: { runner: 'codemie-claude' } }, 'codemie');
    const r = ask(d, 'resolve_active_provider ""');
    expect(r.stdout.trim()).toBe('codemie-claude');
    rmSync(d, { recursive: true, force: true });
  });

  it('FAILS LOUDLY on an unknown set — never falls through to a guessed vendor', () => {
    const d = fixture({ claude: { runner: 'claude' } }, 'claude');
    const r = ask(d, 'resolve_active_provider', { EPAM_PROVIDER_SET: 'no-such-set' });
    expect(r.status, 'an unknown set must not exit 0').not.toBe(0);
    expect(r.stdout.trim(), 'nothing on stdout a caller could mistake for a real answer').toBe('');
    expect(r.stderr).toMatch(/no-such-set/);
    expect(r.stderr).toMatch(/claude/);            // names the declared sets, per provider-sets.json's own rule
    rmSync(d, { recursive: true, force: true });
  });

  it('FAILS LOUDLY when a set declares a runner block with no keys', () => {
    const d = mkdtempSync(join(tmpdir(), 'active-provider-empty-'));
    mkdirSync(join(d, 'orchestrations/config'), { recursive: true });
    writeFileSync(join(d, 'orchestrations/config/provider-sets.json'),
      JSON.stringify({ defaultSet: 'broken', sets: { broken: { settingsFile: 'llm-defaults.broken.json' } } }));
    writeFileSync(join(d, 'orchestrations/config/llm-defaults.broken.json'), JSON.stringify({ runners: {} }));
    const r = ask(d, 'resolve_active_provider');
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
    rmSync(d, { recursive: true, force: true });
  });

  it('FAILS LOUDLY when a set declares MORE THAN ONE runner — never silently picks a winner', () => {
    // Every set declared today has exactly one runner, but the check exists for the day one
    // doesn't: an ambiguous config must be refused, not resolved by whichever key jq lists first.
    const d = mkdtempSync(join(tmpdir(), 'active-provider-ambiguous-'));
    mkdirSync(join(d, 'orchestrations/config'), { recursive: true });
    writeFileSync(join(d, 'orchestrations/config/provider-sets.json'),
      JSON.stringify({ defaultSet: 'ambiguous', sets: { ambiguous: { settingsFile: 'llm-defaults.ambiguous.json' } } }));
    writeFileSync(join(d, 'orchestrations/config/llm-defaults.ambiguous.json'),
      JSON.stringify({ runners: { claude: {}, 'codemie-claude': {} } }));
    const r = ask(d, 'resolve_active_provider');
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
    rmSync(d, { recursive: true, force: true });
  });

  it('FAILS LOUDLY when no provider-sets.json exists at all — never assumes a vendor', () => {
    const d = mkdtempSync(join(tmpdir(), 'active-provider-missing-'));
    mkdirSync(join(d, 'orchestrations/config'), { recursive: true });
    const r = ask(d, 'resolve_active_provider');
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
    rmSync(d, { recursive: true, force: true });
  });

  it('NEVER prints an empty string on success — a caller that reads one goes on to call nothing', () => {
    // No trailing newline is deliberate (matches container_runtime()'s own convention): a caller
    // captures the value with $(...), which strips a trailing newline anyway, so the two lines
    // land concatenated here rather than separated. The assertion checks both halves rather than
    // assuming a newline that the function correctly does not print.
    const d = fixture({ claude: { runner: 'claude' } }, 'claude');
    const r = ask(d, 'resolve_active_provider; echo " EXIT=$?"');
    expect(r.stdout).toBe('claude EXIT=0\n');
    rmSync(d, { recursive: true, force: true });
  });
});
