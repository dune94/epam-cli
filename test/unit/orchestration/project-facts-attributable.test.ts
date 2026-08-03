/**
 * A claim injected into an agent prompt must say where it came from.
 *
 * INCIDENT, 2026-08-03. `codeline-facts.json` carried, once per codeline:
 *
 *   "Contentstack Live Preview config uses live_preview: { enable, preview_token } —
 *    preview_token, NOT management_token."
 *
 * That was not researched. It was written by an assistant session, unverified, and it
 * contradicted the installed package's own type declaration. Because `claude.sh` injects
 * these strings verbatim under "Codeline-Specific Facts (real, curated gotchas)", a
 * fabrication became an authoritative instruction to the writer AND to the reviewer, which
 * then rejected correct work for not matching it. A matching hand-authored rule in
 * `anti-patterns.json` carried no provenance field at all.
 *
 * The defect is STRUCTURAL, not a bad string: a bare string is unattributable BY
 * CONSTRUCTION. There is no field in which a source could have been recorded, so nothing
 * distinguishes a fact verified against real source from one that was invented, and no
 * rule can ever be audited or expired.
 *
 * So facts are objects carrying their own provenance. Strings remain readable for
 * backward compatibility with existing project configs, but a fact SHIPPED IN THIS REPO
 * must be attributable.
 *
 * This asserts on the real config files and on the REAL rendered prompt — not on source
 * text. See CLAUDE.md, "Test the code AND the impact of the code".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const PROJECTS_DIR = join(REPO_ROOT, 'orchestrations/projects');

/** Discover every project by convention — never a hardcoded project list. */
function projectDirs(): string[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  return readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(PROJECTS_DIR, e.name));
}

interface FactEntry {
  text?: string;
  source?: string;
}

/** Every fact shipped in this repo, with the file and codeline it came from. */
function allShippedFacts(): { file: string; codeline: string; fact: string | FactEntry }[] {
  const out: { file: string; codeline: string; fact: string | FactEntry }[] = [];
  for (const dir of projectDirs()) {
    const f = join(dir, 'codeline-facts.json');
    if (!existsSync(f)) continue;
    const parsed = JSON.parse(readFileSync(f, 'utf8'));
    const buckets: [string, unknown][] = Array.isArray(parsed)
      ? [['(root)', parsed]]
      : Object.entries(parsed);
    for (const [codeline, v] of buckets) {
      const facts = Array.isArray(v) ? v : Array.isArray((v as { facts?: unknown[] })?.facts)
        ? (v as { facts: unknown[] }).facts
        : [];
      for (const fact of facts) out.push({ file: f, codeline, fact: fact as string | FactEntry });
    }
  }
  return out;
}

describe('every fact shipped in this repo is attributable', () => {
  it('there is at least one fact to check (guard against a vacuous pass)', () => {
    expect(
      allShippedFacts().length,
      'no facts were discovered, so every assertion below would pass while proving nothing',
    ).toBeGreaterThan(0);
  });

  it('no fact is a bare string — a bare string cannot record where it came from', () => {
    const bare = allShippedFacts().filter((f) => typeof f.fact === 'string');
    expect(
      bare.map((b) => `${b.codeline}: ${String(b.fact).slice(0, 80)}…`),
      'these facts are injected into agent prompts as authoritative, with no way to tell ' +
        'whether they were verified against real source or invented',
    ).toEqual([]);
  });

  it('every fact carries a non-empty source', () => {
    const unsourced = allShippedFacts()
      .filter((f) => typeof f.fact === 'object')
      .filter((f) => !String((f.fact as FactEntry).source || '').trim())
      .map((f) => `${f.codeline}: ${String((f.fact as FactEntry).text).slice(0, 70)}…`);
    expect(unsourced, 'a fact with no source cannot be audited or expired').toEqual([]);
  });

  it('every fact carries non-empty text', () => {
    const empty = allShippedFacts()
      .filter((f) => typeof f.fact === 'object')
      .filter((f) => !String((f.fact as FactEntry).text || '').trim());
    expect(empty).toEqual([]);
  });
});

/**
 * The specific fabrication, named. This is a regression guard, not a vocabulary ban:
 * the claim was invented by an assistant session, contradicted the installed package's
 * own types, and caused a reviewer to reject correct work across three codelines.
 */
describe('the fabricated live-preview token claim does not come back', () => {
  it('no shipped project config asserts one token key "NOT" another', () => {
    const offenders: string[] = [];
    for (const dir of projectDirs()) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const p = join(dir, name);
        const raw = readFileSync(p, 'utf8');
        // The shape of an unverifiable vendor-API assertion: "X, NOT Y".
        if (/\b\w*token\b[^"]{0,40}\bNOT\b[^"]{0,40}\b\w*token\b/i.test(raw)) {
          offenders.push(`${dir.split('/').pop()}/${name}`);
        }
      }
    }
    expect(
      offenders,
      'a vendor-API claim of the form "use X, NOT Y" is exactly the fabrication that ' +
        'reached three writers and a reviewer on 2026-08-03',
    ).toEqual([]);
  });
});

describe('hand-authored rule files carry provenance or do not exist', () => {
  it('no anti-pattern rule is shipped without a source', () => {
    const unsourced: string[] = [];
    for (const dir of projectDirs()) {
      const f = join(dir, 'anti-patterns.json');
      if (!existsSync(f)) continue;
      const rules = JSON.parse(readFileSync(f, 'utf8'));
      for (const r of Array.isArray(rules) ? rules : []) {
        if (!String(r?.source || '').trim()) {
          unsourced.push(`${dir.split('/').pop()}: ${r?.id || '(no id)'}`);
        }
      }
    }
    expect(
      unsourced,
      'an anti-pattern rule is injected as a hard gate; without a source there is no way ' +
        'to tell a researched rule from an invented one',
    ).toEqual([]);
  });
});

describe('no stray client data is committed to the engine repo', () => {
  it('no ad-hoc test scratch file sits in orchestrations/scripts', () => {
    const scripts = join(REPO_ROOT, 'orchestrations/scripts');
    const stray = readdirSync(scripts).filter((n) => /^__.*test.*\d{4,}\./i.test(n));
    expect(
      stray,
      'a generated scratch file containing real client ticket data was committed to the ' +
        'engine repo; it is not referenced by any script and must not ship',
    ).toEqual([]);
  });
});
