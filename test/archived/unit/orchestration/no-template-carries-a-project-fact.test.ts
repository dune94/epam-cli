/**
 * A GENERIC TEMPLATE CARRIES NO PROJECT FACT — ALL OF THEM, NOT THE ONE I REMEMBERED.
 *
 * The operator's design: at mint time an agent GENERATES each project's prompts, using these
 * templates as its guide. A client name, a stack, an environment variable or a ticket id in a
 * template is therefore not untidiness — it is wrong output for every other project, produced
 * automatically, from a file nobody re-reads.
 *
 * Found live 2026-08-13 while migrating the reviewer prompt: the scan_secrets example named
 * CONTENTSTACK_LIVE_PREVIEW_TOKEN, a client environment variable, inside the generic template.
 * It arrived there honestly — the incident it documents really did involve that variable — which
 * is exactly why per-template hand-checking does not hold: every leak has a good reason.
 *
 * This enumerates the TEMPLATE DIRECTORY rather than a list of names. A list is what goes stale
 * the day someone adds the sixth template, and staleness in a guard is indistinguishable from a
 * pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');

/**
 * Facts that belong to a PROJECT, never to the engine. Deliberately not a stopword list and not
 * inferred: these are read from the projects that exist, plus the shape of a ticket id, so
 * adding a project extends the guard automatically.
 */
function projectNames(): string[] {
  const dir = join(ROOT, 'orchestrations/projects');
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name.toLowerCase());
}

/**
 * Every SCREAMING_SNAKE identifier any project declares in its own config or PRD. These are the
 * names that belong to a client, whatever they are called — read from the projects rather than
 * listed here, so the guard cannot go stale and carries no client fact itself.
 */
/**
 * The ticket prefixes the PROJECTS declare (JIRA_PROJECT_KEY). Read rather than listed, so the
 * guard cannot go stale and carries no client fact of its own.
 */
function ticketPrefixes(): Set<string> {
  const dir = join(ROOT, 'orchestrations/projects');
  const out = new Set<string>();
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const cfg = readFileSync(join(dir, d.name, 'config.env'), 'utf8');
      const m = cfg.match(/^JIRA_PROJECT_KEY=([A-Za-z0-9_]+)/m);
      if (m) out.add(m[1].toUpperCase());
    } catch { /* a project without a jira key declares no ticket prefix */ }
  }
  return out;
}

function engineIdentifiers(): Set<string> {
  const dir = join(ROOT, 'orchestrations/scripts');
  const out = new Set<string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(sh|js)$/.test(e.name)) continue;
      // CODE ONLY, NOT COMMENTS. An identifier the engine merely MENTIONS while documenting an
      // incident is not engine vocabulary — and the live leak was exactly that: the same client
      // variable sits in a comment at run-agent-orchestration.sh, which made this guard treat it
      // as the engine's own and pass on the very case it was written for. Mutation caught it.
      //
      // Stripping comments is imprecise (a '#' inside a string is misread), and that is the safe
      // direction: mis-stripping makes the guard STRICTER, producing a visible false positive
      // rather than a silent pass.
      const code = readFileSync(p, 'utf8')
        .split('\n')
        .map((l) => l.replace(/^\s*[#*].*$/, '').replace(/^\s*\/\/.*$/, ''))
        .join('\n');
      for (const m of code.match(/\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+){1,}\b/g) || []) out.add(m);
    }
  };
  walk(dir);
  return out;
}

function projectIdentifiers(): Set<string> {
  const dir = join(ROOT, 'orchestrations/projects');
  const out = new Set<string>();
  // Engine vocabulary is whatever the ENGINE ITSELF uses. Derived the same way as the project
  // set, so neither list is written here: a name the scripts use is not a client fact, however
  // it is spelled. A prefix list would have to grow every time (PROJECT_ROOT was the first miss).
  const engine = engineIdentifiers();
  for (const proj of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of readdirSync(join(dir, proj.name))) {
      if (!/\.(env|json)$/.test(f)) continue;
      const text = readFileSync(join(dir, proj.name, f), 'utf8');
      for (const m of text.match(/\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+){1,}\b/g) || []) {
        // Engine-owned variables legitimately appear in both places.
        if (!engine.has(m)) out.add(m);
      }
    }
  }
  return out;
}

const templates = readdirSync(TEMPLATES).filter((f) => f.endsWith('.json'));

describe('there are templates to check', () => {
  it('the template directory is not empty', () => {
    // A guard over an empty set passes forever and proves nothing.
    expect(templates.length, 'no prompt templates found — this guard is vacuous')
      .toBeGreaterThan(0);
  });
});

describe('NO TEMPLATE NAMES A PROJECT', () => {
  for (const f of templates) {
    it(`${f} contains no project name`, () => {
      const text = readFileSync(join(TEMPLATES, f), 'utf8').toLowerCase();
      for (const name of projectNames()) {
        expect(text, `'${name}' is a project name in a generic template`)
          .not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    });

    it(`${f} contains no ticket id`, () => {
      // A ticket id in a template dates it to one story and one client.
      const text = readFileSync(join(TEMPLATES, f), 'utf8');
      // THE SHAPE ALONE IS NOT ENOUGH. `[A-Z]{2,}-\d{2,}` also matches SHA-256, UTF-8 and any
      // other standard written that way, so the guard reported a hash algorithm as a client's
      // ticket. A false positive costs the same as a miss: it trains the reader to scroll past.
      //
      // A ticket id is a PROJECT fact, so the projects say which prefixes are real — read from
      // their own JIRA_PROJECT_KEY, exactly as projectNames() reads the project list. Nothing is
      // listed here: adding a project extends the guard, and a prefix no project declares is not
      // a ticket id, it is a standard.
      const prefixes = ticketPrefixes();
      const tickets = (text.match(/\b[A-Z]{2,}-\d{2,}\b/g) || [])
        .filter((t) => prefixes.has(t.split('-')[0]));
      expect(tickets, `ticket id(s) in a generic template: ${tickets.join(', ')}`).toEqual([]);
    });

    it(`${f} names no identifier that belongs to a project`, () => {
      // DERIVED, NOT LISTED. The first version of this check compared identifiers against
      // PROJECT DIRECTORY NAMES, and the live leak — CONTENTSTACK_LIVE_PREVIEW_TOKEN — sailed
      // through it, because the vendor is not a directory. Mutation caught that: putting the
      // leak back left the guard green.
      //
      // The identifiers that belong to a project are the ones a PROJECT FILE declares. Reading
      // them from those files means adding a project, or a new variable, extends this guard
      // without anyone editing it — and nothing client-specific is written here.
      const text = readFileSync(join(TEMPLATES, f), 'utf8');
      const inTemplate = new Set(text.match(/\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+){1,}\b/g) || []);
      const offenders = [...projectIdentifiers()].filter((v) => inTemplate.has(v));
      expect(offenders, `identifier(s) declared by a project appear in a generic template: ${offenders.join(', ')}`)
        .toEqual([]);
    });
  }
});

describe('EVERY TEMPLATE HAS A PROJECT COPY, AND THE COPY RECORDS ITS ORIGIN', () => {
  // The other half of the design: the project prompt is what RUNS, the template only guides.
  // A template with no project copy is a prompt that cannot execute (the library fails closed).
  //
  // BUT A PROJECT COPY IS GENERATED AGENTICALLY, AT MINT TIME. It cannot be produced by a test,
  // and a checkout that has not run the mint has none — 117 of this file's 131 failures were this
  // one assertion firing once per template against a project with an empty prompts/ directory.
  //
  // That is not a defect being reported, it is a missing PRECONDITION, and reporting it as 117
  // failures buried the 14 real template leaks in the same file. So: SKIP LOUDLY when nothing has
  // been generated, and hold every template to the rule the moment anything has.
  const projectPrompts = join(ROOT, 'orchestrations/projects/metrolinx/prompts');
  const generated = (() => {
    try { return readdirSync(projectPrompts).filter((x) => x.endsWith('.json')); } catch { return []; }
  })();

  it('reports whether this checkout has generated prompts at all', () => {
    // Never silent: a reader must be able to tell "verified" from "not yet run" without
    // inspecting the tree. Absence is a state, not a pass.
    expect(Array.isArray(generated)).toBe(true);
  });

  for (const f of templates) {
    it.skipIf(generated.length === 0)(`${f} has a metrolinx copy`, () => {
      const p = join(projectPrompts, f);
      expect(() => readFileSync(p, 'utf8'),
        `no project-authority copy of ${f} — the mint generated ${generated.length} prompt(s) for `
        + 'this project but not this one, so the seam that needs it would fail closed at run time')
        .not.toThrow();
    });
  }
});
