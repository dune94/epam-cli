/**
 * A BUDGET BELONGS TO THE ARTEFACT, NOT TO ONE SEAM.
 *
 * Live 2026-08-24, AMSD-1919, second run. roster-specialiser's maxOutputTokens was raised to 65536
 * that morning so it could emit all 57 canonical agents in one file — the roster contract refuses a
 * subset. Every seam that HANDLES that same roster was left at 32768.
 *
 * project-roster-review then truncated mid-JSON: batch2 at 62,648 bytes and batch6 at 38,432, both
 * cut off part-way through a finding object. A truncated reply is indistinguishable from a
 * malformed one, so 3 of 6 batches were reported "not examined", the judge was retried identically,
 * and it failed the same way every time. The run burned roster attempts and was killed.
 *
 * The reviewer needs MORE room than the writer, not less: the writer emits derived text alone,
 * while the reviewer quotes canonical text AND derived text AND its own findings.
 *
 * Nothing here is a list of numbers to maintain. The rule is relational — a seam handling the
 * roster is sized from the seam that writes it — so raising the writer again cannot silently leave
 * its readers behind.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY = join(__dirname, '../../../orchestrations/agents/invocation-profiles.json');

interface Seam { name: string; profile: Record<string, unknown> }

const seams = (): Seam[] => {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const out: Seam[] = [];
  (function walk(o: Record<string, unknown>) {
    for (const k of Object.keys(o)) {
      const v = o[k] as Record<string, unknown>;
      if (v && typeof v === 'object') {
        if (typeof v.template === 'string') out.push({ name: k, profile: v });
        walk(v);
      }
    }
  }((reg.profiles || reg) as Record<string, unknown>));
  return out;
};

const ALL = seams();
const byName = (n: string) => ALL.find((s) => s.name === n);
const budget = (n: string) => Number(byName(n)?.profile.maxOutputTokens);

/** Seams whose declared `consumes` names a roster of any kind. */
const rosterConsumers = () => ALL.filter((s) => {
  const c = s.profile.consumes;
  return Array.isArray(c) && c.some((x) => /roster/i.test(String((x as { kind?: string })?.kind)));
});

describe('the roster writer and everything that handles its output are sized together', () => {
  it('the writer is on the raised budget — the premise of this suite', () => {
    expect(budget('roster-specialiser'),
      'roster-specialiser no longer carries the raised budget; this suite would compare against the wrong number')
      .toBeGreaterThanOrEqual(65536);
  });

  it('there are consumers to check', () => {
    expect(rosterConsumers().length).toBeGreaterThan(1);
  });

  for (const s of rosterConsumers()) {
    it(`${s.name} is sized for the roster it handles`, () => {
      const writer = budget('roster-specialiser');
      expect(Number(s.profile.maxOutputTokens),
        `${s.name} handles the roster but has a smaller output budget than the seam that writes it. `
        + 'Its reply will truncate mid-JSON, which reads as "did not examine" and retries identically.')
        .toBeGreaterThanOrEqual(writer);
    });
  }

  it('the reviewer that truncated is specifically covered', () => {
    // The seam this defect was found in. Named so a future refactor of `consumes` cannot drop it
    // from the set above and quietly stop checking the one that actually failed.
    expect(budget('project-roster-review')).toBeGreaterThanOrEqual(budget('roster-specialiser'));
  });

  it('a seam that does NOT handle the roster is left alone', () => {
    // The rule must not become "raise everything".
    //
    // This case originally pinned agent-mint, on the reasoning that it proposes from tickets and
    // never reads the roster. That reasoning was wrong in a way worth recording: the mint MERGES
    // into the roster, and it was being told what already exists by a hardcoded list of 21 names
    // against a canonical 57 — so 39 agents were invisible to it, test-engineer among them, and a
    // reviewer raised a blocking "no test agent was minted" gap for an agent that existed. The
    // mint now reads the roster and is sized with the seams that handle it.
    //
    // So the guard moves to a seam that genuinely does not touch the roster at all.
    expect(budget('ac-elaboration'),
      'ac-elaboration consumes a ticket and never the roster; raising it would mean the rule has '
      + 'degraded into raising every seam').toBe(32768);
  });
});
