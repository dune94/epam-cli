/**
 * ANTI-RELAPSE GUARD — no project config may carry a hand-authored answer key.
 *
 * The rule (standing, restated 2026-08-03): a fact the pipeline needs is CONFIGURABLE
 * (genuine standing project policy), DETERMINABLE (discovered at runtime by a plugin), or
 * an LLM judgment. It is never a rule someone wrote down *after watching a specific
 * ticket fail* — that is an answer key wearing config's clothes, it cannot help any other
 * project, and it is the same violation as baking the answer into acceptanceCriteria.
 *
 * The decision procedure this test enforces: could this rule have been written BEFORE any
 * failure was observed, from the project's standing setup? "This repo uses jest" — yes.
 * "Library X's `foo` option must be `bar`" — no; that is discoverable from the installed
 * package (see the dependency_contract plugin) and must be discovered, not transcribed.
 *
 * What went wrong (2026-08-03): a `management_token` regex encoding one vendor's
 * known-wrong config key was added to a project's anti-patterns.json after watching a
 * live failure, and was defended twice as "project config, not hardcoding". It taught a
 * gate rather than the writer, it could never generalise to another SDK, and by the time
 * it was caught it had four production consumers. The replacement is the dependency_contract
 * plugin, which reads the installed package and reports which keys it actually consumes.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECTS_DIR = join(__dirname, '../../../orchestrations/projects');

function projectDirs(): string[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  return readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(PROJECTS_DIR, d.name));
}

describe('project config carries no hand-authored, failure-derived rules', () => {
  it('no project ships an anti-patterns.json rule list', () => {
    const offenders: string[] = [];
    for (const dir of projectDirs()) {
      const file = join(dir, 'anti-patterns.json');
      if (!existsSync(file)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        offenders.push(`${file} (unparseable)`);
        continue;
      }
      const rules = Array.isArray(parsed) ? parsed : [];
      if (rules.length > 0) offenders.push(`${file} (${rules.length} rule(s))`);
    }
    expect(
      offenders,
      'A hand-written "known wrong pattern" rule is an answer key, not configuration: it was ' +
        'authored after watching one ticket fail and cannot help any other project or SDK. ' +
        'Discover the fact instead — see orchestrations/plugins/dependency-contract-tools.js, ' +
        'which reports which option keys an installed package actually consumes.',
    ).toEqual([]);
  });

  /**
   * codeline-facts.json legitimately holds STANDING operational facts — "pre-commit
   * hooks need these env vars", "CI runs in UTC", "this dep resolves from a local
   * override". Those could all have been written before any failure occurred.
   *
   * What it must NOT hold is a failure-derived ANSWER. The tell is an emphatic
   * correction between two identifiers — "use preview_token, NOT management_token" —
   * which is only ever written after watching something break, applies to exactly one
   * vendor, and is precisely what the dependency_contract plugin discovers by reading
   * the installed package. Same violation as the deleted anti-patterns.json rule; it
   * merely survived in a second file, injected into EVERY writer prompt via claude.sh's
   * codeline_facts_block.
   *
   * LIMITATION, stated: this catches the emphatic-correction shape, not every possible
   * smuggled answer. It is a tripwire for the known pattern, not a proof of absence.
   */
  it('no codeline fact encodes an emphatic "use X, NOT Y" correction — that is a discovered fact, not config', () => {
    const offenders: string[] = [];
    const correction = /\bNOT\s+`?[a-z][a-z0-9_]{3,}`?\b/;
    for (const dir of projectDirs()) {
      const file = join(dir, 'codeline-facts.json');
      if (!existsSync(file)) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      for (const [codeline, entry] of Object.entries(parsed)) {
        const facts: unknown[] = Array.isArray(entry)
          ? entry
          : Array.isArray((entry as { facts?: unknown[] })?.facts)
            ? (entry as { facts: unknown[] }).facts
            : [];
        for (const fact of facts) {
          if (typeof fact === 'string' && correction.test(fact)) {
            offenders.push(`  ${file} [${codeline}]: ${fact.slice(0, 110)}…`);
          }
        }
      }
    }
    expect(
      offenders,
      'An emphatic correction between two identifiers is an answer learned from a failure, ' +
        'not a standing project fact — it cannot help any other project and it is ' +
        'discoverable at runtime. Use the dependency_contract plugin instead:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('the discovered replacement exists and is registered by any project that needs it', () => {
    // The guard above only bites if there is somewhere better for the knowledge to live.
    const plugin = join(__dirname, '../../../orchestrations/plugins/dependency-contract-tools.js');
    expect(existsSync(plugin), 'the dependency_contract plugin must exist as the replacement').toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tools } = require(plugin) as { tools: Array<{ name: string }> };
    expect(tools.map(t => t.name)).toContain('dependency_contract');
  });
});
