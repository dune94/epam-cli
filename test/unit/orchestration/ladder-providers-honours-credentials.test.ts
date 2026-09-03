// A SET'S ROUTABLE PROVIDERS MUST INCLUDE WHAT ITS OWN CREDENTIALS AUTHORIZE.
//
// Found 2026-09-03 while fixing STORY_PROVIDER's hardcoded "codex" default
// (change-log/SEAM-CONSISTENCY-ANALYSIS.md): the openrouter set declares
// `$credentials` for BOTH EPAM_API_KEY_OPENROUTER and EPAM_API_KEY_MINIMAX — real,
// required credentials, real evidence those vendor names are legitimate under that
// set — but ladder-providers.js's routable-list computation only ever looked at
// `runners` keys and ladder-declared providers. The openrouter set's runner is
// "claude" (the CLI binary invoked), so its routable list was ["claude"] only,
// missing the two vendors the set exists to route to.
//
// Consequence, confirmed directly: `_mc_providers` — fed into the
// prd-model-coordinator's OWN prompt as __MC_PERMITTED_PROVIDERS__
// (run-agent-orchestration.sh:5691) — told the roster agent only "claude" was
// permitted under a set whose entire purpose is per-model routing to
// openrouter/minimax. And once resolve_primary_provider() (706469cf) started
// consulting this same list for STORY_PROVIDER's routability check, a roster
// assignment of aiProvider: "minimax" under EPAM_PROVIDER_SET=openrouter was
// SILENTLY SUBSTITUTED to "claude" — breaking a correct, deliberate per-story
// vendor choice, the opposite of what that mechanism exists to protect.
//
// These tests EXECUTE the script against fixtures — a test reading the source for
// a regex would pass on a comment.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPT = join(ROOT, 'orchestrations/scripts/lib/handlers/ladder-providers.js');
const NODE = process.execPath;

function fixture(setName: string, setCfg: Record<string, unknown>, llmDefaults: Record<string, unknown>) {
  const d = mkdtempSync(join(tmpdir(), 'ladder-providers-'));
  mkdirSync(join(d, 'config'), { recursive: true });
  writeFileSync(join(d, 'config/provider-sets.json'), JSON.stringify({
    defaultSet: setName,
    sets: { [setName]: setCfg },
  }));
  writeFileSync(join(d, `config/llm-defaults.${setName}.json`), JSON.stringify(llmDefaults));
  return d;
}

function run(d: string, env: Record<string, string> = {}) {
  const r = spawnSync(NODE, [SCRIPT], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, EPAM_PROVIDER_SETS_FILE: join(d, 'config/provider-sets.json'), ...env },
  });
  let parsed: string[] = [];
  try { parsed = JSON.parse(r.stdout || '[]'); } catch { /* leave empty */ }
  return { raw: r.stdout, parsed };
}

describe('ladder-providers.js honours a set\'s declared credentials', () => {
  it('includes a vendor the set declares credentials for, even though its runner is a different name', () => {
    const d = fixture('openrouter', {
      settingsFile: 'llm-defaults.openrouter.json',
      credentials: [
        { env: 'EPAM_API_KEY_OPENROUTER', from: 'OPENROUTER_API_KEY', required: true },
        { env: 'EPAM_API_KEY_MINIMAX', from: 'MINIMAX_API_KEY', required: true },
      ],
    }, { runners: { claude: {} } });
    const { parsed } = run(d);
    expect(parsed).toContain('claude');
    expect(parsed, 'the set declares EPAM_API_KEY_MINIMAX but minimax is not routable').toContain('minimax');
    expect(parsed, 'the set declares EPAM_API_KEY_OPENROUTER but openrouter is not routable').toContain('openrouter');
    rmSync(d, { recursive: true, force: true });
  });

  it('does not invent a vendor for a set with no declared credentials', () => {
    const d = fixture('claude', { settingsFile: 'llm-defaults.claude.json' }, { runners: { claude: {} } });
    const { parsed } = run(d);
    expect(parsed).toEqual(['claude']);
    rmSync(d, { recursive: true, force: true });
  });

  it('ignores a malformed credentials entry rather than crashing', () => {
    const d = fixture('openrouter', {
      settingsFile: 'llm-defaults.openrouter.json',
      credentials: [{ from: 'OPENROUTER_API_KEY' }, { env: 123 }, null],
    }, { runners: { claude: {} } });
    const { parsed } = run(d);
    expect(parsed).toEqual(['claude']);
    rmSync(d, { recursive: true, force: true });
  });

  it('derives the vendor name by stripping EPAM_API_KEY_ and lowercasing, not by guessing', () => {
    const d = fixture('openrouter', {
      settingsFile: 'llm-defaults.openrouter.json',
      credentials: [{ env: 'EPAM_API_KEY_MINIMAX', from: 'MINIMAX_API_KEY', required: true }],
    }, { runners: { claude: {} } });
    const { parsed } = run(d);
    expect(parsed).toContain('minimax');
    expect(parsed).not.toContain('EPAM_API_KEY_MINIMAX');
    expect(parsed).not.toContain('MINIMAX');
    rmSync(d, { recursive: true, force: true });
  });
});

describe('ladder-providers.js, against the real openrouter set', () => {
  it('lists minimax and openrouter as routable, not just claude', () => {
    const r = spawnSync(NODE, [SCRIPT], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, EPAM_PROVIDER_SET: 'openrouter' },
    });
    const parsed = JSON.parse(r.stdout || '[]');
    expect(parsed, `stdout: ${r.stdout}`).toContain('claude');
    expect(parsed, `stdout: ${r.stdout}`).toContain('minimax');
    expect(parsed, `stdout: ${r.stdout}`).toContain('openrouter');
  });
});
