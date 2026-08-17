/**
 * NO PROMPT MAY CARRY A PROJECT FACT. THIS CHECKS EVERY TEMPLATE, MECHANICALLY.
 *
 * Nine templates named the stack in their prompt BODIES:
 *
 *   "files without *.test.ts, agentRole \"typescript-engineer\""
 *   "NEVER modify package.json, tsconfig.json, vitest.config.ts"
 *
 * So every agent on every project was told the world is TypeScript, vitest and npm. On a Rust,
 * Python, Go or Ruby codeline the split rules and the protected-file list are simply wrong — and
 * an agent follows them anyway, because a prompt is not a suggestion.
 *
 * A template MAY carry a placeholder filled from configuration at render time; that is the
 * sanctioned mechanism, and lib/handlers/stack-facts.js supplies the values from the ecosystem
 * registry and the project's own minted roster. What it may not do is state the fact itself.
 *
 * THIS TEST EXISTS SO THE RULE IS ENFORCED RATHER THAN TRUSTED. A human audit of 100+ templates
 * cannot be repeated on every change; this can, and it fails the build instead of a launch.
 *
 * Scope note: only the rendered BODY is scanned. The `$why` block is documentation FOR A HUMAN
 * about what was removed and why — it must be able to quote the defect verbatim, or the record of
 * the fix becomes unwritable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATES = join(__dirname, '../../../orchestrations/prompts/templates');

/**
 * Facts that belong to a project, never to the engine.
 *
 * Each is paired with the placeholder that replaces it, so a failure tells the reader what to do
 * rather than only what is wrong.
 */
const FORBIDDEN: Array<{ pattern: RegExp; what: string; use: string }> = [
  { pattern: /\bvitest\b/i,            what: 'a test runner',        use: '__TEST_COMMAND__' },
  { pattern: /\bjest\b/i,              what: 'a test runner',        use: '__TEST_COMMAND__' },
  { pattern: /\bpytest\b/i,            what: 'a test runner',        use: '__TEST_COMMAND__' },
  { pattern: /\bnpm\b/i,               what: 'a package manager',    use: '__TEST_COMMAND__ / __PROTECTED_FILES__' },
  { pattern: /\byarn\b|\bpnpm\b/i,     what: 'a package manager',    use: '__TEST_COMMAND__' },
  { pattern: /package\.json/i,         what: 'a manifest file',      use: '__MANIFEST_FILE__ / __PROTECTED_FILES__' },
  { pattern: /tsconfig\.json/i,        what: 'a build config file',  use: '__PROTECTED_FILES__' },
  { pattern: /Cargo\.toml|go\.mod|pyproject\.toml|Gemfile/i, what: 'a manifest file', use: '__MANIFEST_FILE__' },
  { pattern: /\*?\.test\.ts\b|\*?\.spec\.ts\b/i, what: 'one test-file convention', use: '__TEST_FILE_CONVENTIONS__' },
  { pattern: /node_modules/i,          what: 'a vendored directory', use: '__PROTECTED_FILES__' },
  { pattern: /typescript-engineer|test-engineer\b/i, what: 'a role name', use: '__IMPL_ROLE__ / __TEST_ROLE__' },
  // Client and project identities. A prompt naming one of these is the most direct form of this
  // defect: it is not merely stack-specific, it is customer-specific.
  { pattern: /\bmetrolinx\b/i,         what: 'a client name',        use: 'a value injected at render time' },
  { pattern: /\bskyscanner\b/i,        what: 'a client name',        use: 'a value injected at render time' },
  { pattern: /\bgotransit\b/i,         what: 'a client name',        use: 'a value injected at render time' },
  { pattern: /\bcontentstack\b/i,      what: 'a vendor name',        use: 'a value injected at render time' },
  { pattern: /\bmock[0-9]\b/i,         what: 'a project name',       use: 'a value injected at render time' },
  { pattern: /\b(AMSD|SKY)-[0-9]+/i,   what: 'a ticket id',          use: 'a value injected at render time' },
];

/** Only what a model actually receives: body / bodies. Never $why, which documents the removal. */
function renderedText(doc: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof doc.body === 'string') parts.push(doc.body);
  if (doc.bodies && typeof doc.bodies === 'object') {
    for (const v of Object.values(doc.bodies as Record<string, unknown>)) {
      if (typeof v === 'string') parts.push(v);
    }
  }
  return parts.join('\n');
}

describe('no template names a project fact', () => {
  const files = readdirSync(TEMPLATES).filter((f) => f.endsWith('.json'));

  it('finds the templates — it is not scanning nothing', () => {
    expect(files.length, 'no templates found; this whole file would pass vacuously')
      .toBeGreaterThan(50);
  });

  it('every template body is free of stack, client and role literals', () => {
    const offences: string[] = [];

    for (const f of files) {
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8'));
      } catch (err) {
        offences.push(`${f}: not valid JSON (${(err as Error).message})`);
        continue;
      }
      const text = renderedText(doc);
      if (!text) continue;

      for (const { pattern, what, use } of FORBIDDEN) {
        const hit = pattern.exec(text);
        if (hit) offences.push(`${f}: names ${what} ("${hit[0]}") — inject ${use} instead`);
      }
    }

    expect(offences,
      `${offences.length} template(s) state a fact that belongs to the project. A prompt may carry `
      + 'a PLACEHOLDER filled at render time (lib/handlers/stack-facts.js supplies the values from '
      + 'the ecosystem registry and the project roster); it may not state the fact:',
    ).toEqual([]);
  });

  it('the values source answers for an ecosystem that is not Node', () => {
    // The guard above only proves the literals are gone. This proves something correct arrives in
    // their place — otherwise the fix is a deletion, and the agent is told nothing at all.
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const { mkdtempSync, writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');

    const dir = mkdtempSync(join(tmpdir(), 'stack-facts-'));
    try {
      writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "r"\n');
      const r = spawnSync(process.execPath, [
        join(__dirname, '../../../orchestrations/scripts/lib/handlers/stack-facts.js'), dir,
      ], { encoding: 'utf8' });
      expect(r.status, `stack-facts failed: ${r.stderr}`).toBe(0);

      const facts = JSON.parse(r.stdout);
      expect(facts.__TEST_COMMAND__, 'a Rust codeline was not told how to run its tests')
        .toMatch(/cargo test/);
      expect(facts.__PROTECTED_FILES__, 'a Rust codeline was given Node files to protect')
        .toMatch(/Cargo\.toml/);
      expect(facts.__PROTECTED_FILES__).not.toMatch(/package\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
