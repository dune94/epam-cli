/**
 * Canonical invariants for profiles.json and prd.json.
 *
 * These tests enforce two guarantees before every run:
 *  1. profiles.json contains every agentRole referenced in the active PRD stories
 *     (missing profile = silent prompt degradation for that agent).
 *  2. prd.json stories[] contains ONLY stories referenced in implementationOrder
 *     (orphan stories = dead weight that confuses tooling and inflates file size).
 *  3. profiles.json.original contains all CORE agent profiles
 *     (the canonical minimum floor; restored from before each run).
 *
 * Core agents are the permanent set needed for any orchestration run.
 * Non-core agents are project-specific additions (e.g. generator for scaffolding,
 * review-ranger/sast-sentinel for quality gates). Both must be present in
 * profiles.json; only core must be present in profiles.json.original.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ORCH_DIR = join(__dirname, '../../../orchestrations');
const PRD_PATH = join(ORCH_DIR, 'travel-app-prd.json');
const PROFILES_PATH = join(ORCH_DIR, 'agents/profiles.json');
const PROFILES_ORIGINAL_PATH = join(ORCH_DIR, 'agents/profiles.json.original');

// Core agents: the permanent minimum required for any orchestration run.
// Add here when a new permanent agent is introduced to the system.
const CORE_AGENT_PROFILES = [
  // Step 1 — main-branch stories (agentRole in PRD stories)
  'typescript-engineer',
  'test-engineer',
  'review-agent',
  'team-lead-agent',
  'generator',
  // Step 0 — spec pass (spec-mode-runner.js looks these up by profile key)
  'spec-coordinator-agent',
  'openspec-agent',
  'speckit-agent',
  // Step 1.6 — TC writer gate (post-impl-tc-writer.sh)
  'tc-writer-agent',
  // Step 4.2a–4.4b — quality gates (run-agent-orchestration.sh + ai-run.sh)
  'sast-sentinel',
  'spec-validator',
  'review-ranger',
  'mutant-hunter',
  'fuzz-weaver',
  'perf-sentinel',
  // Step 4.6 — browser E2E (jq-looked-up from profiles_file in run-agent-orchestration.sh)
  'lightpanda-agent',
  'playwright-agent',
  'test-coordinator-agent',
  // Self-healing remediation pipeline (run-agent-orchestration.sh)
  'gate-finding-analyst',
  'story-ac-remediator',
  'profile-augmentor',
];

const prd = JSON.parse(readFileSync(PRD_PATH, 'utf8'));
const profiles: Record<string, unknown> = JSON.parse(readFileSync(PROFILES_PATH, 'utf8'));
const implementationOrder: Record<string, string[]> = prd.implementationOrder ?? {};
const activeIds = new Set(Object.values(implementationOrder).flat());

describe('profiles.json — canonical invariants', () => {
  it('profiles.json exists and is valid JSON with at least one entry', () => {
    expect(Object.keys(profiles).length).toBeGreaterThan(0);
  });

  it('profiles.json.original exists', () => {
    expect(existsSync(PROFILES_ORIGINAL_PATH)).toBe(true);
  });

  it('profiles.json.original contains all core agent profiles', () => {
    const original: Record<string, unknown> = JSON.parse(
      readFileSync(PROFILES_ORIGINAL_PATH, 'utf8'),
    );
    const missing = CORE_AGENT_PROFILES.filter((p) => !(p in original));
    expect(missing, `Missing core profiles in profiles.json.original: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('profiles.json contains all core agent profiles', () => {
    const missing = CORE_AGENT_PROFILES.filter((p) => !(p in profiles));
    expect(missing, `Missing core profiles in profiles.json: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('profiles.json contains every agentRole referenced in active PRD stories', () => {
    const referencedRoles = new Set<string>();
    for (const story of prd.stories) {
      if (activeIds.has(story.id)) {
        const role: string | undefined = story.agentRole;
        if (role) referencedRoles.add(role);
      }
    }
    const missing = [...referencedRoles].filter((r) => !(r in profiles));
    expect(
      missing,
      `Active PRD stories reference agentRoles not in profiles.json: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });

  it('profiles.json is a superset of profiles.json.original (original is the floor)', () => {
    const original: Record<string, unknown> = JSON.parse(
      readFileSync(PROFILES_ORIGINAL_PATH, 'utf8'),
    );
    const missing = Object.keys(original).filter((k) => !(k in profiles));
    expect(
      missing,
      `profiles.json is missing entries that exist in profiles.json.original: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });
});

describe('prd.json — stories[] canonical invariants', () => {
  it('stories[] contains only stories referenced in implementationOrder (no orphans)', () => {
    const orphans = prd.stories.filter((s: { id: string }) => !activeIds.has(s.id));
    expect(
      orphans.map((s: { id: string }) => s.id),
      `Orphan stories in stories[] not in implementationOrder: ${orphans.map((s: { id: string }) => s.id).join(', ')}`,
    ).toHaveLength(0);
  });

  it('stories[] count equals total stories in implementationOrder', () => {
    expect(prd.stories).toHaveLength(activeIds.size);
  });

  it('implementationOrder references no story IDs absent from stories[]', () => {
    const storyIds = new Set(prd.stories.map((s: { id: string }) => s.id));
    const missing = [...activeIds].filter((id) => !storyIds.has(id));
    expect(
      missing,
      `implementationOrder references stories not in stories[]: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });
});
