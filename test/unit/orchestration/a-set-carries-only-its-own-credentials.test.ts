/**
 * A STACK BRINGS ITS OWN CREDENTIALS, AND NOBODY ELSE'S.
 *
 * orchestrate.sh exported two vendor keys unconditionally, on every stack:
 *
 *     EPAM_API_KEY_MINIMAX="${MINIMAX_API_KEY:-}"
 *     EPAM_API_KEY_OPENROUTER="${OPENROUTER_API_KEY:-}"
 *
 * and metrolinx's config.env demanded both before it would launch at all —
 * REQUIRED_KEYS=MINIMAX_API_KEY,OPENROUTER_API_KEY,JIRA_TOKEN — although metrolinx runs on the
 * claude set, which calls neither vendor.
 *
 * That is the same defect spend-probe.sh was written to remove one layer down, in its own words:
 * a key "is present in .env whatever stack is active", so the guard `[ -n "$OPENROUTER_API_KEY" ]`
 * let a free run call a paid vendor. Here it is worse than a stray call — a present key OUTRANKS
 * the OAuth subscription, which is how seven runs billed an API account the operator was not
 * trying to spend from.
 *
 * WHICH CREDENTIALS A STACK NEEDS IS A FACT ABOUT THE STACK. provider-sets.json declares them, so
 * swapping stacks stays one environment variable and never an edit — and a project declares only
 * the keys that are true of it whatever it runs on, like a Jira token.
 *
 * The assertions run the real loading chain and read what a child would inherit. A configuration
 * that merely looks right is what the earlier version of this class of bug had.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/set-credentials.sh');
const REGISTRY = JSON.parse(
  readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8'));

/** Every stack the registry declares, discovered rather than listed here. */
const SETS: string[] = Object.keys(REGISTRY.sets || {});

/** A vendor key that is unmistakably present, so "not exported" cannot be confused with "unset". */
const PLANTED: Record<string, string> = {
  OPENROUTER_API_KEY: 'sk-or-PLANTED-BY-THE-TEST',
  MINIMAX_API_KEY: 'PLANTED-BY-THE-TEST-minimax',
  ANTHROPIC_API_KEY: 'sk-ant-PLANTED-BY-THE-TEST',
  CODEMIE_API_KEY: 'PLANTED-BY-THE-TEST-codemie',
};

/** What a child inherits after the active set has exported its credentials. */
function exportedUnder(set: string): Record<string, string> {
  const r = spawnSync('bash', ['-c', `
    set -euo pipefail
    cd "${ROOT}"
    . "${LIB}"
    export_set_credentials
    echo "__RAN__=1"
    for k in $(compgen -e); do case "$k" in EPAM_API_KEY_*) printf '%s=%s\\n' "$k" "\${!k}";; esac; done
  `], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...PLANTED, EPAM_PROVIDER_SET: set } });
  const out: Record<string, string> = {};
  for (const line of (r.stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** The source variables the active set says it cannot launch without. */
function requiredUnder(set: string): string[] {
  const r = spawnSync('bash', ['-c', `
    set -euo pipefail
    cd "${ROOT}"
    . "${LIB}"
    set_required_keys
  `], { encoding: 'utf8', timeout: 60000, env: { ...process.env, EPAM_PROVIDER_SET: set } });
  return (r.stdout || '').trim().split(',').map((s) => s.trim()).filter(Boolean);
}

describe('a set carries only its own credentials', () => {
  it('there are stacks to check, and the exporter actually runs', () => {
    // Guards the vacuous pass: if the library never runs, every not-exported assertion below is
    // true and none of them means anything.
    expect(SETS.length, 'the registry declares no sets at all').toBeGreaterThan(2);
    expect(exportedUnder('claude').__RAN__, 'export_set_credentials did not run to completion')
      .toBe('1');
  }, 60_000);

  it('the claude stack exports no vendor key it never calls', () => {
    // The billing hazard: a key present in the environment outranks the OAuth subscription.
    const env = exportedUnder('claude');
    for (const name of ['EPAM_API_KEY_OPENROUTER', 'EPAM_API_KEY_MINIMAX']) {
      expect(env[name] || '', `${name} was exported on the claude stack, which calls neither vendor`)
        .toBe('');
    }
  }, 60_000);

  it('and the mockserver stack exports none at all — a free run has nothing to spend', () => {
    const env = exportedUnder('mockserver');
    const leaked = Object.entries(env)
      .filter(([k, v]) => k.startsWith('EPAM_API_KEY_') && v !== '')
      .map(([k]) => k);
    expect(leaked, 'the free rehearsal was handed usable vendor credentials').toEqual([]);
  }, 60_000);

  it('the openrouter stack DOES get its keys — the negative half', () => {
    // Withdrawing the keys everywhere would break the stack that needs them, which is not a fix.
    const env = exportedUnder('openrouter');
    expect(env.EPAM_API_KEY_OPENROUTER, 'the openrouter stack was left without its own key')
      .toBe(PLANTED.OPENROUTER_API_KEY);
  }, 60_000);

  it.each(SETS)('%s: declares its credentials, so a swap inherits none from the last stack', (set) => {
    expect(REGISTRY.sets[set], `${set} is not declared`).toBeTruthy();
    expect(Array.isArray(REGISTRY.sets[set].credentials),
      `${set} declares no credentials list, so what it needs is guesswork`).toBe(true);
  });

  it('launching claude does not demand a key the claude stack never uses', () => {
    // metrolinx could not start: REQUIRED_KEYS named two vendors belonging to a different stack.
    const required = requiredUnder('claude');
    for (const name of ['OPENROUTER_API_KEY', 'MINIMAX_API_KEY']) {
      expect(required, `launching the claude stack still demands ${name}`).not.toContain(name);
    }
  }, 60_000);

  it('no project bakes another stack\'s vendor keys into its own required list', () => {
    // A project's own REQUIRED_KEYS is for what is true of it on ANY stack — a Jira token, not a
    // vendor. Otherwise selecting a set means editing the project, which is not a swap.
    const vendorKeys = new Set<string>();
    for (const s of Object.values<any>(REGISTRY.sets)) {
      for (const c of s.credentials || []) if (c.from) vendorKeys.add(c.from);
    }
    expect(vendorKeys.size, 'no set declares any credential, so this proves nothing')
      .toBeGreaterThan(1);

    const offenders: string[] = [];
    const projects = spawnSync('bash', ['-c',
      `ls -d "${ROOT}"/orchestrations/projects/*/ 2>/dev/null`], { encoding: 'utf8' });
    for (const dir of (projects.stdout || '').split('\n').filter(Boolean)) {
      let body = '';
      try { body = readFileSync(join(dir, 'config.env'), 'utf8'); } catch { continue; }
      const line = /^\s*REQUIRED_KEYS=(.*)$/m.exec(body)?.[1] || '';
      for (const k of line.replace(/["']/g, '').split(',').map((s) => s.trim())) {
        if (vendorKeys.has(k)) offenders.push(`${dir.replace(ROOT + '/', '')}config.env: ${k}`);
      }
    }
    expect(offenders, 'these projects demand a vendor key that belongs to a stack, not to them')
      .toEqual([]);
  });

  // ── The receiver ──────────────────────────────────────────────────────────────────────────────
  //
  // Everything above proves the library answers correctly. None of it fails if orchestrate.sh
  // never calls it — deleting the call site left all ten green, which is the shape of a library
  // that has a test but no caller. These execute the launcher's OWN sections.

  /** Run one section of orchestrate.sh, spliced out at its marker and executed for real. */
  function launcherSection(marker: string, endMarker: RegExp, env: Record<string, string>) {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/orchestrate.sh'), 'utf8');
    const lines = src.split('\n');
    const from = lines.findIndex((l) => l.includes(marker));
    expect(from, `orchestrate.sh no longer contains ${marker}`).toBeGreaterThan(-1);
    const rest = lines.slice(from + 1);
    const to = rest.findIndex((l) => endMarker.test(l));
    const body = rest.slice(0, to === -1 ? rest.length : to).join('\n');
    expect(body.trim().length, 'the spliced section is empty').toBeGreaterThan(0);
    return spawnSync('bash', ['-c', `
      cd "${ROOT}"
      fail() { echo "FAILED: $*"; exit 9; }
      . orchestrations/scripts/lib/set-credentials.sh
      ${body}
      echo "__RAN__=1"
      for k in $(compgen -e); do case "$k" in EPAM_API_KEY_*) printf '%s=%s\n' "$k" "\${!k}";; esac; done
    `], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  }

  it('the launcher itself exports the credentials — not just the library that can', () => {
    const r = launcherSection('Export all config vars', /^# ──/, {
      ...PLANTED, EPAM_PROVIDER_SET: 'openrouter',
    });
    expect(r.stdout, 'the launcher export section did not run').toContain('__RAN__=1');
    expect(r.stdout, 'orchestrate.sh no longer exports the active stack\'s credentials at all — '
      + 'the library is wired to nothing')
      .toContain(`EPAM_API_KEY_OPENROUTER=${PLANTED.OPENROUTER_API_KEY}`);
  }, 60_000);

  it('the launcher enforces the set\'s required keys, and refuses when one is missing', () => {
    // The union has to be read, not merely computed. With the openrouter stack selected and its
    // keys absent, the launcher must refuse rather than start and die at the first seam.
    const bare = { ...process.env } as Record<string, string>;
    for (const k of Object.keys(PLANTED)) delete bare[k];
    const r = launcherSection('Required key validation', /^# ──/,
      { ...bare, EPAM_PROVIDER_SET: 'openrouter', REQUIRED_KEYS: '' });
    expect(r.stdout + r.stderr, 'the openrouter stack launched with no key for the vendors it calls')
      .toMatch(/FAILED: (OPENROUTER|MINIMAX)_API_KEY/);
  }, 60_000);

  it('and does NOT refuse on a stack that needs no key at all', () => {
    // The negative half: a union that always demands something would block claude and mockserver,
    // which is how this started.
    const bare = { ...process.env } as Record<string, string>;
    for (const k of Object.keys(PLANTED)) delete bare[k];
    for (const set of ['claude', 'mockserver']) {
      const r = launcherSection('Required key validation', /^# ──/,
        { ...bare, EPAM_PROVIDER_SET: set, REQUIRED_KEYS: '' });
      expect(r.stdout, `the ${set} stack was blocked by a key requirement it does not have`)
        .not.toMatch(/FAILED:/);
    }
  }, 60_000);
});
