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

/**
 * THE SAME FABRICATION, IN THE PLACES THIS SUITE DID NOT LOOK.
 *
 * The guard above scans orchestrations/projects/* only. The identical claim — "live_preview
 * uses preview_token, NOT management_token" — also lives in the agent KNOWLEDGE BASE and in
 * engine source comments, and neither was covered. So on 2026-08-04 it was read, believed,
 * and re-encoded into a new hard gate within a day of the original incident. The relapse
 * did not come from project config; it came from here.
 *
 * DISPROVEN BY DISCOVERY, not by opinion. dependency_contract, run against the installed
 * package in the codeline, reports with file:line evidence:
 *
 *   live_preview      consumed   contentstack/config.js:13
 *   enable            consumed   contentstack/config.js:14
 *   host              consumed   contentstack/config.js:3
 *   management_token  consumed   contentstack/dist/web/contentstack.js:2
 *   preview_token     ABSENT     — appears nowhere in the package
 *
 * `preview_token` would compile, look right, and silently do nothing at runtime — the exact
 * failure mode the dependency_contract tool exists to prevent. The writer used
 * management_token and was CORRECT; the reviewer confirmed it against the same tool.
 *
 * KB.md matters most of the three: it is injected into agent prompts, so a false entry
 * there actively teaches every future writer the wrong answer.
 *
 * The rule is not "never mention this key". It is: do not ASSERT a vendor's API contract
 * from memory. State it as discoverable, or point at the tool that discovers it.
 */
describe('the fabricated live-preview claim is not taught anywhere', () => {
  const SOURCES = [
    'orchestrations/agents/KB.md',
    'orchestrations/scripts/claude.sh',
    'orchestrations/scripts/lib/story-guards.sh',
  ];

  /** A prescriptive claim that one key is right and the other wrong. */
  const PRESCRIPTIVE = [
    /use\s+`?preview_token`?\s*\(\s*NOT\s+`?management_token`?/i,
    /`?preview_token`?\s*,?\s*not\s+`?management_token`?/i,
    /the\s+correct\s+fix\s+uses\s+`?preview_token`?/i,
    /at\s+runtime\s+the\s+SDK\s+actually\s+reads\s+`?preview_token`?/i,
    /prescribed\s+`?preview_token`?/i,
  ];

  it('the sources exist (guard against a vacuous pass)', () => {
    for (const rel of SOURCES) {
      expect(existsSync(join(REPO_ROOT, rel)), `${rel} not found — the scan proves nothing`)
        .toBe(true);
    }
  });

  /**
   * Comment prose WRAPS. "…instead of the prescribed\n# `preview_token`…" is one claim
   * split across two comment lines, and a naive \s+ will not bridge the "# ". An earlier
   * version of this test matched KB.md (unwrapped markdown) and silently passed both shell
   * files that carried the identical assertion — a green run that proved nothing.
   */
  const normalise = (t: string) =>
    t.replace(/\r/g, '').split('\n').map((l) => l.replace(/^\s*#\s?/, '')).join(' ')
      .replace(/\s+/g, ' ');

  it.each(SOURCES)('%s does not assert preview_token over management_token', (rel) => {
    const text = normalise(readFileSync(join(REPO_ROOT, rel), 'utf8'));
    const hits = PRESCRIPTIVE.filter((re) => re.test(text)).map((re) => String(re));
    expect(
      hits,
      `${rel} states a vendor API fact that dependency_contract disproves: preview_token is ` +
        'ABSENT from the installed package, management_token is consumed ' +
        '(contentstack/dist/web/contentstack.js:2). An agent reading this is taught to write ' +
        'a key that silently does nothing. Say it is discoverable, or name the tool that ' +
        `discovers it.\nmatched: ${hits.join(', ')}`,
    ).toEqual([]);
  });

  it('the knowledge base does not brand the correct answer a "false diagnosis"', () => {
    const kb = readFileSync(join(REPO_ROOT, 'orchestrations/agents/KB.md'), 'utf8');
    expect(
      /false\s+diagnosis[\s\S]{0,200}management_token|management_token[\s\S]{0,200}false\s+diagnosis/i.test(kb),
      'KB.md calls the management_token finding a false diagnosis. It is the key the ' +
        'installed SDK actually reads; the entry inverts the truth for every future agent.',
    ).toBe(false);
  });
});
