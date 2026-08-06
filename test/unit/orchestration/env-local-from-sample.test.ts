/**
 * .env.local is DERIVED from the codeline's own .env.local.sample, never a
 * hand-maintained engine-side list.
 *
 * orchestrations/projects/metrolinx/env-vars.json (added 2026-08-02, commit 359f7fa) hand-
 * picked CONTENTSTACK_API_KEY/DELIVERY_TOKEN/ENVIRONMENT/BRANCH and the Cloudinary vars
 * because those were the ones throwing "Missing required environment variables" at the
 * time. It never included MANAGEMENT_TOKEN, and nothing kept it in sync as the client
 * codeline's own requirements changed — discovered 2026-08-05 when AMSD-2041 (Contentstack
 * Live Preview) needed exactly that var and the engine-side list didn't have it.
 *
 * The codeline ALREADY declares its full set in its own .env.local.sample. Deriving from
 * that file means a new var the client adds is picked up on the next run with zero edits
 * to this repo — the property every fix in this session has been establishing for other
 * facts (node version, service URLs, PRD templates).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SCRIPT_SRC = readFileSync(SCRIPT, 'utf8');

function extractFunctionBody(name: string): string {
  const start = SCRIPT_SRC.indexOf(`${name}() {`);
  const end = SCRIPT_SRC.indexOf('\n}', start) + 2;
  return SCRIPT_SRC.slice(start, end);
}
const FN_BODY = extractFunctionBody('provision_env_local_from_sample');

/** Runs the extracted function body — not a reimplementation — against a fixture codeline. */
function provision(sampleContent: string | null) {
  const codelineDir = mkdtempSync(join(tmpdir(), 'cl-'));
  if (sampleContent !== null) {
    writeFileSync(join(codelineDir, '.env.local.sample'), sampleContent);
  }
  const dest = join(codelineDir, '.env.local');
  const script = `
    set -uo pipefail
    ${FN_BODY}
    provision_env_local_from_sample '${codelineDir}' '${dest}'
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000 });
  return {
    dest,
    exists: existsSync(dest),
    content: existsSync(dest) ? readFileSync(dest, 'utf8') : '',
    stderr: r.stderr || '',
  };
}

describe('provision_env_local_from_sample', () => {
  it('THE BUG: a var the sample declares but the old engine-side list never had is provisioned', () => {
    const r = provision('API_KEY=\nDELIVERY_TOKEN=\nMANAGEMENT_TOKEN=\nMANAGEMENT_TOKEN_LIVE=\n');
    expect(
      r.content,
      'MANAGEMENT_TOKEN was never in orchestrations/projects/metrolinx/env-vars.json — ' +
        'this is the exact gap that blocked AMSD-2041',
    ).toMatch(/^MANAGEMENT_TOKEN=\S+/m);
    expect(r.content).toMatch(/^MANAGEMENT_TOKEN_LIVE=\S+/m);
  });

  it('every key from the sample gets a non-empty placeholder value', () => {
    const r = provision('API_KEY=\nDELIVERY_TOKEN=\nENVIRONMENT=dev\n');
    const lines = r.content.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const [key, value] = line.split('=');
      expect(value, `${key} must not be empty — some client apps throw at import time on an absent var`).toBeTruthy();
    }
  });

  it('placeholders are DERIVED per key, not a hardcoded per-var table', () => {
    const r = provision('FOO_BAR_BAZ=\n');
    expect(r.content).toMatch(/^FOO_BAR_BAZ=sandbox-placeholder-foo-bar-baz$/m);
  });

  it('comments and blank lines in the sample are ignored, not turned into vars', () => {
    const r = provision('# a comment\n\nAPI_KEY=\n');
    expect(r.content.trim().split('\n')).toHaveLength(1);
  });

  it('a codeline with no .env.local.sample gets no .env.local at all', () => {
    const r = provision(null);
    expect(
      r.exists,
      'inventing keys nobody declared would be the same mistake in the other direction',
    ).toBe(false);
  });

  it('never writes real values — every value is a placeholder string, not the sample\'s own content', () => {
    // A client might paste a real (leaked) value into their own sample by mistake; this
    // function must never propagate it into a run's .env.local.
    const r = provision('API_KEY=sk-live-something-real\n');
    expect(r.content).not.toMatch(/sk-live-something-real/);
    expect(r.content).toMatch(/^API_KEY=sandbox-placeholder-api-key$/m);
  });
});

describe('the engine no longer ships a hand-maintained per-codeline env list', () => {
  it('env-vars.json is gone', () => {
    expect(existsSync(join(__dirname, '../../../orchestrations/projects/metrolinx/env-vars.json'))).toBe(false);
  });

  it('nothing LIVE in the pipeline references env-vars.json anymore — only history in a comment', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const liveLines = src.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(liveLines.join('\n')).not.toMatch(/env-vars\.json/);
  });
});
