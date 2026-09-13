/**
 * PRE-FLIGHT ASKS THE PROVIDER SET WHICH KEYS A RUN NEEDS.
 *
 * preflight-check.sh required OPENROUTER_API_KEY and OPENAI_API_KEY of every run — two vendors,
 * named in the engine, whatever set was active — and warned about RAPIDAPI_KEY, one project's
 * contract-discovery key, for every project. On the claude, codemie and mockserver sets those keys
 * are absent by design (the mockserver set REMOVES vendor credentials so a rehearsal cannot spend),
 * so pre-flight refused every £0 rehearsal and every subscription-billed launch over keys nothing
 * would use. Found 2026-09-13 opening the greenfield rehearsal.
 *
 * The check now derives: the active set's own credential declarations (config/provider-sets.json
 * through lib/set-credentials.sh), then the project's REQUIRED_KEYS. The block is lifted from the
 * script and EXECUTED against the real registry for every declared set.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const SRC = readFileSync(join(SCRIPTS, 'preflight-check.sh'), 'utf8');
const sets = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8')).sets as Record<string, any>;

/** The API-keys block, lifted by its own heading and run with ok/fail stubs. */
function keysBlock(env: Record<string, string>) {
  const start = SRC.indexOf('# ── 4. Required API keys');
  const end = SRC.indexOf('# ──', start + 10);
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
  const body = SRC.slice(start, end);
  const script = `set -uo pipefail
SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; REPO_ROOT=${JSON.stringify(ROOT)}
. "$SCRIPT_DIR/lib/env-file.sh"
ok(){ echo "OK: $*"; }; fail(){ echo "FAIL: $*"; }
load_env_file_safe(){ :; }
${body}`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env } });
  return (r.stdout || '') + (r.stderr || '');
}

describe('pre-flight asks the provider set which keys a run needs', () => {
  it('the block names no vendor key and no project key of its own', () => {
    const code = SRC.slice(SRC.indexOf('# ── 4. Required API keys'), SRC.indexOf('# ──', SRC.indexOf('# ── 4. Required API keys') + 10))
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/OPENROUTER_API_KEY|OPENAI_API_KEY|RAPIDAPI_KEY|MINIMAX_API_KEY/);
  });

  for (const [set, cfg] of Object.entries(sets)) {
    const required = (cfg.credentials || []).filter((c: any) => c.required).map((c: any) => c.from as string);
    it(`${set}: every key the set declares required is checked, and nothing else fails (${required.length} declared)`, () => {
      const out = keysBlock({ EPAM_PROVIDER_SET: set });
      for (const k of required) expect(out).toMatch(new RegExp(`FAIL: ${k} is NOT set`));
      const fails = out.split('\n').filter((l) => l.startsWith('FAIL:'));
      expect(fails, `keys failed that the ${set} set never declared`).toHaveLength(required.length);
      if (!required.length) expect(out).toMatch(/declares no required credentials/);
    });
    if (required.length) {
      it(`${set}: with the declared keys present, nothing fails`, () => {
        const env: Record<string, string> = { EPAM_PROVIDER_SET: set };
        for (const k of required) env[k] = 'present';
        const out = keysBlock(env);
        expect(out.split('\n').filter((l) => l.startsWith('FAIL:'))).toEqual([]);
      });
    }
  }

  it('a key the PROJECT declares in REQUIRED_KEYS is a warning when absent — the project, not the engine, named it', () => {
    const anySet = Object.keys(sets)[0];
    const out = keysBlock({ EPAM_PROVIDER_SET: anySet, REQUIRED_KEYS: 'SOME_PROJECT_KEY' });
    expect(out).toMatch(/⚠ SOME_PROJECT_KEY not set — this project declares it/);
    const with_ = keysBlock({ EPAM_PROVIDER_SET: anySet, REQUIRED_KEYS: 'SOME_PROJECT_KEY', SOME_PROJECT_KEY: 'x' });
    expect(with_).toMatch(/OK: SOME_PROJECT_KEY is set \(required by this project\)/);
  });
});
