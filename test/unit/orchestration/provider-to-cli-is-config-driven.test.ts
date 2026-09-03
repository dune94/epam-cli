// provider_to_cli() (claude.sh) USED TO BE A HARDCODED `case` STATEMENT NAMING EVERY VENDOR.
//
// change-log/SEAM-CONSISTENCY-ANALYSIS.md, Section 5: this is an engine-branch on a vendor
// literal — the "HARDCODING: engine NO, plugin YES, config is the source" rule says the engine
// must derive, never enumerate. providers.json already exists as the single declared list of
// known providers; provider_to_cli() carried a second, independently-maintained mapping from
// provider name to CLI binary. Two lists drift; this collapses them into one.
//
// This test EXECUTES the real function (extracted from claude.sh, sourced against a REAL,
// unmodified providers.json, and — for the strongest proof — against a TEMP providers.json with
// a fabricated provider that could not possibly be known to any hardcoded case arm). If
// provider_to_cli() only works for vendors it happens to have a case arm for, adding a provider
// to providers.json alone would NOT make it runnable — proving the mapping still lives in code.
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const realProviders = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/providers.json'), 'utf8'));

function fnText(name: string): string {
  const start = claudeSrc.indexOf(`${name}() {`);
  expect(start, `${name} not found in claude.sh`).toBeGreaterThan(-1);
  const end = claudeSrc.indexOf('\n}', start);
  return claudeSrc.slice(start, end + 2);
}

function runProviderToCli(provider: string, providersJsonPath: string, epamCli = 'epam') {
  const script = `
SCRIPT_DIR="$(dirname "${JSON.stringify(providersJsonPath)}")"
PROVIDERS_JSON=${JSON.stringify(providersJsonPath)}
EPAM_CLI=${JSON.stringify(epamCli)}
error() { echo "ERROR: $*" >&2; }
${fnText('provider_to_cli')}
provider_to_cli ${JSON.stringify(provider)}
`;
  const r = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  return r.trim();
}

function runProviderToCliExpectError(provider: string, providersJsonPath: string) {
  const script = `
PROVIDERS_JSON=${JSON.stringify(providersJsonPath)}
EPAM_CLI="epam"
error() { echo "ERROR: $*" >&2; return 1; }
${fnText('provider_to_cli')}
provider_to_cli ${JSON.stringify(provider)}
`;
  try {
    execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { failed: false, stderr: '' };
  } catch (e: any) {
    return { failed: true, stderr: String(e.stderr || '') };
  }
}

describe('provider_to_cli() is config-driven, not a hardcoded vendor case statement', () => {
  it('resolves a REAL provider exactly as providers.json declares — executed, not read', () => {
    const cli = runProviderToCli('codex', join(ROOT, 'orchestrations/config/providers.json'));
    expect(cli).toBe('codex');
  });

  it('a provider added to providers.json ALONE — no code change — becomes runnable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'providers-cli-'));
    try {
      const cfg = { ...realProviders, cliBinary: { ...(realProviders.cliBinary || {}), fabricatedvendor: 'fabricated-cli' } };
      const p = join(dir, 'providers.json');
      writeFileSync(p, JSON.stringify(cfg));
      const cli = runProviderToCli('fabricatedvendor', p);
      expect(cli, 'provider_to_cli only ran a provider it had a hardcoded case arm for').toBe('fabricated-cli');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('routes the $EPAM_CLI-wrapped providers through the real EPAM_CLI value, not a duplicated literal', () => {
    const cli = runProviderToCli('openrouter', join(ROOT, 'orchestrations/config/providers.json'), 'my-custom-epam-binary');
    expect(cli).toBe('my-custom-epam-binary');
  });

  it('still refuses an unknown provider — no silent fallback', () => {
    const { failed, stderr } = runProviderToCliExpectError('not-a-real-vendor', join(ROOT, 'orchestrations/config/providers.json'));
    expect(failed, 'an unknown provider must not silently succeed').toBe(true);
    expect(stderr).toMatch(/Unknown aiProvider/);
  });

  it('does NOT contain a hardcoded per-vendor case arm — the mapping lives in providers.json', () => {
    const body = fnText('provider_to_cli');
    // Negative assertion: none of the REAL known providers may appear as a literal case pattern
    // (e.g. "codex)") inside the function body — that would mean the mapping is still in code.
    for (const p of realProviders.known as string[]) {
      const pattern = new RegExp(`\\b${p}\\)`);
      expect(body, `found a hardcoded case arm for "${p}" inside provider_to_cli()`).not.toMatch(pattern);
    }
  });
});
