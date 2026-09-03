import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * .env.example USED TO BE HAND-MAINTAINED AND WENT STALE. Root .env.example listed only an MCP
 * URL block, a GitHub token and one Claude key — nothing about EPAM_PROVIDER_SET, JIRA_TOKEN, or
 * the openrouter set's own required OPENROUTER_API_KEY/MINIMAX_API_KEY (both declared in
 * provider-sets.json, neither mentioned in the template an operator was told to copy and fill in).
 * launch-dashboard/.env.example was worse: it still said EPAM_PROVIDER_SET was "REQUIRED" after
 * that requirement was removed from config.js entirely.
 *
 * generate_env_example() reads the same declared sources the rest of the pipeline already reads
 * (provider-sets.json's credentials, env-vars.json for the handful of vars no set owns) so a
 * credential added to either needs no template edit anywhere.
 */
const LIB = path.resolve(__dirname, '../../../orchestrations-installer/lib/generate-env-example.sh');
const NODE_BIN = process.execPath;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-env-')); });

function write(name: string, obj: unknown) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function generate(providerSets: unknown, envVars: unknown | null) {
  const psFile = write('provider-sets.json', providerSets);
  const evFile = envVars === null ? path.join(dir, 'does-not-exist.json') : write('env-vars.json', envVars);
  const out = path.join(dir, '.env.example');
  const r = spawnSync('bash', ['-c',
    `NODE_BIN=${JSON.stringify(NODE_BIN)}; . ${JSON.stringify(LIB)}; generate_env_example "$1" "$2" "$3"`,
    '--', psFile, evFile, out], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, body: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null };
}

describe('generate_env_example', () => {
  it('lists a required credential from a provider set, as an empty value', () => {
    const r = generate({
      sets: { openrouter: { credentials: [{ env: 'EPAM_API_KEY_OPENROUTER', from: 'OPENROUTER_API_KEY', required: true }] } },
    }, null);
    expect(r.body, `stderr: ${r.stderr}`).toBeTruthy();
    expect(r.body).toMatch(/^OPENROUTER_API_KEY=\s*$/m);
  });

  it('names which set(s) need a credential, so the operator knows why it is there', () => {
    const r = generate({
      sets: { openrouter: { credentials: [{ env: 'EPAM_API_KEY_OPENROUTER', from: 'OPENROUTER_API_KEY', required: true }] } },
    }, null);
    expect(r.body).toMatch(/openrouter/);
  });

  it('a set with no credentials contributes nothing — never a placeholder entry for it', () => {
    const r = generate({ sets: { claude: { credentials: [] }, codemie: {} } }, null);
    expect(r.body).not.toMatch(/EPAM_API_KEY/);
  });

  it('a credential declared by TWO sets is listed once, naming both', () => {
    const r = generate({
      sets: {
        a: { credentials: [{ env: 'EPAM_API_KEY_X', from: 'SHARED_KEY', required: true }] },
        b: { credentials: [{ env: 'EPAM_API_KEY_X', from: 'SHARED_KEY', required: true }] },
      },
    }, null);
    const occurrences = (r.body!.match(/^SHARED_KEY=/gm) || []).length;
    expect(occurrences, 'the same var was listed more than once').toBe(1);
    expect(r.body).toMatch(/a/);
    expect(r.body).toMatch(/b/);
  });

  it('includes the feature-scoped vars from env-vars.json when present', () => {
    const r = generate({ sets: {} }, {
      vars: [{ name: 'JIRA_TOKEN', feature: 'Jira ticket ingestion' }],
    });
    expect(r.body).toMatch(/^JIRA_TOKEN=\s*$/m);
    expect(r.body).toMatch(/Jira ticket ingestion/);
  });

  it('does not fail when env-vars.json is absent — it is an addition, not a dependency', () => {
    const r = generate({ sets: {} }, null);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
  });

  it('a provider added to provider-sets.json ALONE — no installer code change — appears in the template', () => {
    const r = generate({
      sets: { 'a-fabricated-vendor': { credentials: [{ env: 'EPAM_API_KEY_FAB', from: 'FABRICATED_API_KEY', required: true }] } },
    }, null);
    expect(r.body, 'the fabricated provider never reached the generated template').toMatch(/FABRICATED_API_KEY=/);
  });

  it('states it is generated, so nobody hand-edits a file the next install overwrites', () => {
    const r = generate({ sets: {} }, null);
    expect(r.body).toMatch(/generated/i);
  });
});
