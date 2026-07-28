/**
 * The SHARED agent profiles must not carry one project's specifics.
 *
 * `orchestrations/agents/profiles.json` is a single global file, injected into
 * every agent on every project. On 2026-07-28, mid-way through the first
 * multi-codeline Metrolinx run, it was found to contain — committed, for months:
 *
 *   typescript-engineer:
 *     "For the Skyscanner API client and server stories (SKY-002, SKY-003,
 *      SKY-004): ... Understand RapidAPI as a gateway service: requests require
 *      X-RapidAPI-Key ... SKY-003 must read RAPIDAPI_KEY from process.env ..."
 *   review-agent:
 *     "For the Skyscanner mini-app review (SKY-006): ... verify RAPIDAPI_KEY is
 *      never logged ..."
 *   spike-agent, failure-analyst: likewise.
 *
 * 8 Skyscanner references and 16 RapidAPI references, plus hard-coded SKY-*
 * story IDs — the exact thing [[feedback_no_hardcoded_story_ids]] forbids,
 * sitting in the file that instructs every agent the pipeline runs.
 *
 * HOW IT GOT THERE: the pre-phase assessment appends "Post-Spec Skill Addendum"
 * sections to this shared file. Run it on travel-app and every future run of
 * every other project inherits travel-app's API client, its CLI parser and its
 * environment variables. During the Metrolinx run the assessment proposed
 * appending MORE of the same (RAPIDAPI_KEY / SKYSCANNER_API_KEY guidance to a
 * Next.js CMS ticket), which is how it was noticed.
 *
 * WHY IT MATTERS beyond tidiness: these are instructions, not comments. A
 * brownfield agent working on next.gotransit.com was being told to reach for
 * `process.env.RAPIDAPI_KEY` and to implement a `SkyscannerClient`. That is a
 * confident, well-evidenced push toward the wrong design — the same failure
 * class as a detective naming the wrong fix site.
 *
 * This test guards the SHARED file only. Project-specific knowledge is
 * legitimate — it just belongs in a project-scoped profiles file, never here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROFILES = join(__dirname, '../../../orchestrations/agents/profiles.json');
const raw = readFileSync(PROFILES, 'utf8');
const profiles: Record<string, unknown> = JSON.parse(raw);

/**
 * The CANONICAL file is what actually propagates.
 *
 * tier3-metrolinx-run.sh restores profiles.json from profiles.json.original at
 * the start of every run, so a clean base is worthless if the canonical it is
 * restored FROM is dirty. That is exactly how this survived months: the
 * canonical is created once, ever (`if [ ! -f "$profiles_backup" ]` in
 * run_pre_phase_assessment), so it snapshotted whatever happened to be in
 * profiles.json the first time — by then already carrying travel-app's
 * addenda — and every run since restored that pollution faithfully.
 *
 * Guarding the base alone would have caught nothing.
 */
const CANONICAL = join(__dirname, '../../../orchestrations/agents/profiles.json.original');

/** Roles whose text matches a pattern, with a short excerpt for the failure message. */
function offenders(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const [role, body] of Object.entries(profiles)) {
    const text = String(body);
    const m = pattern.exec(text);
    if (m) {
      const at = Math.max(0, m.index - 40);
      out.push(`${role}: "...${text.slice(at, m.index + 120).replace(/\s+/g, ' ')}..."`);
    }
    pattern.lastIndex = 0;
  }
  return out;
}

describe('the shared profiles carry no single project\'s vocabulary', () => {
  it('names no client or third-party product', () => {
    // Not a blocklist of "bad words" — these are the concrete leaks found live.
    // A new project leaking its own vendor names is caught by the story-ID and
    // addendum rules below, which are structural rather than name-based.
    const found = offenders(/skyscanner|rapidapi/i);
    expect(found,
      `the shared profiles instruct every agent on every project about another ` +
      `project's API:\n  ${found.join('\n  ')}`)
      .toEqual([]);
  });

  it('names no story IDs from a project PRD', () => {
    // Standing rule: zero hard-coded story IDs. A profile citing SKY-002 or
    // AMSD-1820 puts one project's (or one CLIENT's) work into every other
    // project's agents.
    //
    // The pipeline's OWN scaffold identifiers are excluded deliberately —
    // INIT-001, DASH-002, SKILLS-001, STORY-007 name epam-cli's internal gates
    // and are legitimately part of those agents' instructions. A first version
    // of this rule matched them too, and "cleaning" to satisfy it deleted 18
    // sentences of real operating instructions from agent-skills-agent. A guard
    // that forces damage is worse than the leak it guards.
    const PIPELINE_OWN = /^(INIT|DASH|SKILLS|STORY)-/;
    const found: string[] = [];
    for (const [role, body] of Object.entries(profiles)) {
      const ids = (String(body).match(/\b[A-Z]{2,6}-\d{3,4}[a-z]?\b/g) || [])
        .filter((id) => !PIPELINE_OWN.test(id));
      if (ids.length) found.push(`${role}: ${[...new Set(ids)].join(', ')}`);
    }
    expect(found,
      `the shared profiles reference project/client story IDs:\n  ${found.join('\n  ')}`)
      .toEqual([]);
  });

  it('carries no per-run "Post-Spec Skill Addendum" SECTION', () => {
    // This is the MECHANISM, not just the symptom: the pre-phase assessment
    // appends these sections to the shared file, so one project's run
    // permanently teaches every other project.
    //
    // Matches a heading AT LINE START, not the phrase anywhere:
    // agent-skills-agent is legitimately INSTRUCTED to write such a section and
    // quotes the heading inline as an example ("append a '## Post-Spec Skill
    // Addendum' section"). Flagging that would force deleting the description of
    // the mechanism itself — the same over-matching that nearly gutted this
    // role's instructions once already.
    const found = offenders(/^##\s*Post-Spec Skill Addendum/im);
    expect(found,
      `a run appended project-specific skills to the SHARED profiles:\n  ${found.join('\n  ')}`)
      .toEqual([]);
  });

  it('names no phase from a specific project\'s PRD', () => {
    const found = offenders(/ui_and_review phase|Scaffold Phase -/i);
    expect(found, `shared profiles cite another project's phases:\n  ${found.join('\n  ')}`)
      .toEqual([]);
  });
});

describe('the CANONICAL copy is clean — it is what every run restores from', () => {
  const canonicalRaw = readFileSync(CANONICAL, 'utf8');
  const canonical: Record<string, unknown> = JSON.parse(canonicalRaw);

  it('names no client or third-party product', () => {
    const found = Object.entries(canonical)
      .filter(([, v]) => /skyscanner|rapidapi/i.test(String(v)))
      .map(([k]) => k);
    expect(found,
      `the canonical restored at every run start is polluted, so cleaning the ` +
      `base achieves nothing — roles: ${found.join(', ')}`)
      .toEqual([]);
  });

  it('names no story IDs from a project PRD', () => {
    const PIPELINE_OWN = /^(INIT|DASH|SKILLS|STORY)-/;
    const found: string[] = [];
    for (const [role, body] of Object.entries(canonical)) {
      const ids = (String(body).match(/\b[A-Z]{2,6}-\d{3,4}[a-z]?\b/g) || [])
        .filter((id) => !PIPELINE_OWN.test(id));
      if (ids.length) found.push(`${role}: ${[...new Set(ids)].join(', ')}`);
    }
    expect(found, `canonical references project/client story IDs:\n  ${found.join('\n  ')}`)
      .toEqual([]);
  });

  it('carries no per-run addendum sections', () => {
    const found = Object.entries(canonical)
      .filter(([, v]) => /^##\s*Post-Spec Skill Addendum/im.test(String(v)))
      .map(([k]) => k);
    expect(found, `canonical carries run-appended addenda: ${found.join(', ')}`).toEqual([]);
  });

  it('holds the same roles as the base, so a restore cannot silently drop one', () => {
    expect(Object.keys(canonical).sort()).toEqual(Object.keys(profiles).sort());
  });
});

describe('the file is still a usable profiles registry after cleaning', () => {
  it('is valid JSON with flat string values', () => {
    // The registry contract: role -> string. Cleaning must not restructure it.
    for (const [role, body] of Object.entries(profiles)) {
      expect(typeof body, `${role} is not a string`).toBe('string');
    }
  });

  it('keeps the roles the pipeline actually invokes', () => {
    // Guard against over-zealous cleaning deleting a role wholesale.
    for (const role of ['typescript-engineer', 'test-engineer', 'review-agent',
                        'sast-sentinel', 'review-ranger', 'mutant-hunter',
                        'spec-validator', 'team-lead-agent']) {
      expect(profiles[role], `role ${role} is missing`).toBeTruthy();
    }
  });

  it('leaves the generic engineering guidance intact', () => {
    // typescript-engineer's value is its stack-agnostic rules; removing the
    // travel-app addenda must not gut it.
    const ts = String(profiles['typescript-engineer'] || '');
    expect(ts.length, 'typescript-engineer was emptied by cleaning').toBeGreaterThan(1500);
    expect(ts, 'the dependency-check rule was lost').toMatch(/DEPENDENCY CHECK/i);
  });
});
