/**
 * Story AC Framework Integrity — TDD tests for how the orchestration framework
 * processes, validates, and heals acceptance criteria.
 *
 * Principle: we test the FRAMEWORK, not the travel app.
 * - All data is mock/generated in this file
 * - No reads from travel-app-prd.canonical.json for AC content checks
 * - Tests verify framework behavior: can it read ACs? apply patches? validate structure?
 *
 * The travel app's specific ACs are validated at run time (the app either works or it doesn't).
 * We test here that the framework machinery handles ACs correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const CLAUDE_SH     = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const MOCK_PRD      = join(__dirname, '../../fixtures/mock-prd.json');
const MOCK_PROFILES = join(__dirname, '../../fixtures/mock-profiles.json');

const claudeSrc  = readFileSync(CLAUDE_SH, 'utf8');
const mockPrd    = JSON.parse(readFileSync(MOCK_PRD, 'utf8'));
const mockProfiles = JSON.parse(readFileSync(MOCK_PROFILES, 'utf8'));

// ── 1. Framework reads ACs from the PRD correctly ─────────────────────────────
describe('failure analyst — reads story ACs from PRD (mock data)', () => {
  it('failure analyst prompt template contains __STORY_ACS__ placeholder', () => {
    expect(claudeSrc).toMatch(/__STORY_ACS__/);
  });

  it('jq query extracts acceptanceCriteria array from story by id', () => {
    // The analyst uses this jq pattern to build the numbered AC list
    expect(claudeSrc).toMatch(/acceptanceCriteria.*to_entries.*map.*AC|STORY_ACS.*jq/is);
  });

  it('ACs are numbered (AC1, AC2...) so the analyst can reference them in patches', () => {
    expect(claudeSrc).toMatch(/to_entries.*map.*"AC|AC.*key.*1/is);
  });

  it('every story in mock PRD has at least one AC (framework needs ACs to self-heal)', () => {
    for (const story of mockPrd.stories) {
      expect(
        (story.acceptanceCriteria as string[]).length,
        `Story ${story.id} has no ACs — failure analyst needs ACs to diagnose failures`
      ).toBeGreaterThan(0);
    }
  });
});

// ── 2. Framework applies AC patches safely ────────────────────────────────────
describe('failure analyst — applies AC patches to prd.json using mock data', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync('/tmp/ac-patch-test-');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('python3 AC patch script replaces AC at given index in mock PRD', () => {
    const prdPath   = join(tmpDir, 'prd.json');
    const storyId   = 'MOCK-001';
    const patchIdx  = 0;
    const newAcText = 'Updated via framework self-healing: tsc --noEmit must exit 0';

    writeFileSync(prdPath, JSON.stringify(mockPrd, null, 2));

    // Run the same python3 patch logic the failure analyst uses
    execSync(`python3 - "${newAcText}" << 'PYEOF'
import json, sys
prd_path = '${prdPath}'
story_id = '${storyId}'
idx = ${patchIdx}
new_text = sys.argv[1]
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        acs = s.get('acceptanceCriteria', [])
        if 0 <= idx < len(acs):
            acs[idx] = new_text
        break
with open(prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
PYEOF`);

    const patched = JSON.parse(readFileSync(prdPath, 'utf8'));
    const story   = patched.stories.find((s: any) => s.id === storyId);
    expect(story.acceptanceCriteria[0]).toBe(newAcText);
  });

  it('python3 AC patch does NOT modify other stories', () => {
    const prdPath = join(tmpDir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify(mockPrd, null, 2));

    const originalMock002ACs = mockPrd.stories.find((s: any) => s.id === 'MOCK-002')?.acceptanceCriteria ?? [];

    execSync(`python3 - "new AC text" << 'PYEOF'
import json, sys
prd_path = '${prdPath}'
story_id = 'MOCK-001'
idx = 0
new_text = sys.argv[1]
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        acs = s.get('acceptanceCriteria', [])
        if 0 <= idx < len(acs):
            acs[idx] = new_text
        break
with open(prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
PYEOF`);

    const patched  = JSON.parse(readFileSync(prdPath, 'utf8'));
    const mock002  = patched.stories.find((s: any) => s.id === 'MOCK-002');
    expect(mock002.acceptanceCriteria).toEqual(originalMock002ACs);
  });

  it('python3 AC patch is idempotent — same text twice leaves one copy', () => {
    const prdPath = join(tmpDir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify(mockPrd, null, 2));
    const newText = 'Idempotent AC text';

    for (let i = 0; i < 2; i++) {
      execSync(`python3 - "${newText}" << 'PYEOF'
import json, sys
prd_path = '${prdPath}'
story_id = 'MOCK-001'
idx = 0
new_text = sys.argv[1]
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        s.get('acceptanceCriteria', [])[0] = new_text
        break
with open(prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
PYEOF`);
    }

    const patched = JSON.parse(readFileSync(prdPath, 'utf8'));
    const story   = patched.stories.find((s: any) => s.id === 'MOCK-001');
    expect(story.acceptanceCriteria[0]).toBe(newText);
    expect(story.acceptanceCriteria.filter((ac: string) => ac === newText)).toHaveLength(1);
  });
});

// ── 3. Framework persists skill notes to agent profiles ────────────────────────
describe('failure analyst — skill note persistence to profiles.json (mock data)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync('/tmp/profile-patch-test-');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('python3 profile patch appends skill note to existing addendum', () => {
    const profilesPath = join(tmpDir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify(mockProfiles, null, 2));
    const role     = 'typescript-engineer';
    const skillNote = 'Never use backtick template literals in test files';

    execSync(`python3 - << 'PYEOF'
import json
profiles_path = '${profilesPath}'
role = '${role}'
note = '[Self-Heal] ${skillNote}'
with open(profiles_path) as f:
    profiles = json.load(f)
if role in profiles.get('profiles', {}):
    existing = profiles['profiles'][role].get('addendum', '')
    sep = '\\n\\n' if existing else ''
    profiles['profiles'][role]['addendum'] = existing + sep + note
    with open(profiles_path, 'w') as f:
        json.dump(profiles, f, indent=2)
PYEOF`);

    const updated  = JSON.parse(readFileSync(profilesPath, 'utf8'));
    const addendum = updated.profiles[role].addendum as string;
    expect(addendum).toContain('[Self-Heal]');
    expect(addendum).toContain(skillNote);
  });

  it('python3 profile patch preserves existing addendum content', () => {
    const profilesPath = join(tmpDir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify(mockProfiles, null, 2));
    const originalAddendum = mockProfiles.profiles['typescript-engineer'].addendum;

    execSync(`python3 - << 'PYEOF'
import json
profiles_path = '${profilesPath}'
role = 'typescript-engineer'
note = '[Self-Heal] New skill note from analyst'
with open(profiles_path) as f:
    profiles = json.load(f)
if role in profiles.get('profiles', {}):
    existing = profiles['profiles'][role].get('addendum', '')
    sep = '\\n\\n' if existing else ''
    profiles['profiles'][role]['addendum'] = existing + sep + note
    with open(profiles_path, 'w') as f:
        json.dump(profiles, f, indent=2)
PYEOF`);

    const updated  = JSON.parse(readFileSync(profilesPath, 'utf8'));
    const addendum = updated.profiles['typescript-engineer'].addendum as string;
    expect(addendum).toContain(originalAddendum);
  });

  it('python3 profile patch does NOT modify other profiles', () => {
    const profilesPath = join(tmpDir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify(mockProfiles, null, 2));
    const originalFrontendAddendum = mockProfiles.profiles['frontend-engineer'].addendum;

    execSync(`python3 - << 'PYEOF'
import json
profiles_path = '${profilesPath}'
role = 'typescript-engineer'
note = '[Self-Heal] Only affects typescript-engineer'
with open(profiles_path) as f:
    profiles = json.load(f)
if role in profiles.get('profiles', {}):
    existing = profiles['profiles'][role].get('addendum', '')
    sep = '\\n\\n' if existing else ''
    profiles['profiles'][role]['addendum'] = existing + sep + note
    with open(profiles_path, 'w') as f:
        json.dump(profiles, f, indent=2)
PYEOF`);

    const updated = JSON.parse(readFileSync(profilesPath, 'utf8'));
    expect(updated.profiles['frontend-engineer'].addendum).toBe(originalFrontendAddendum);
  });
});

// ── 4. Analyst JSON output schema contract ────────────────────────────────────
describe('failure analyst — expected JSON output schema', () => {
  it('analyst prompt requires a JSON object output (no markdown fences)', () => {
    expect(claudeSrc).toMatch(/Output ONLY a single JSON object/i);
  });

  it('analyst JSON must have "diagnosis" field', () => {
    expect(claudeSrc).toMatch(/"diagnosis"/);
  });

  it('analyst JSON must have "target" field with prd|skill|none values', () => {
    expect(claudeSrc).toMatch(/"target".*prd\|skill\|none|target.*prd.*skill.*none/is);
  });

  it('analyst JSON must have "ac_patches" field (array for prd patches)', () => {
    expect(claudeSrc).toMatch(/"ac_patches"/);
  });

  it('analyst JSON must have "skill_note" field', () => {
    expect(claudeSrc).toMatch(/"skill_note"/);
  });

  it('analyst JSON must have "reason" field (why this fix prevents recurrence)', () => {
    expect(claudeSrc).toMatch(/"reason"/);
  });

  it('python3 JSON extraction handles non-JSON prose before the object', () => {
    // The analyst model may produce prose before the JSON — python3 extracts first object
    expect(claudeSrc).toMatch(/python3.*json.*depth|depth.*json.*python3/is);
  });
});

// ── 5. Mock PRD structural properties (framework contract) ────────────────────
describe('mock PRD fixture — structural framework contract', () => {
  it('mock PRD is valid JSON with stories array', () => {
    expect(Array.isArray(mockPrd.stories)).toBe(true);
    expect(mockPrd.stories.length).toBeGreaterThan(0);
  });

  it('mock PRD has implementationOrder with at least 2 phases', () => {
    const phases = Object.keys(mockPrd.implementationOrder as Record<string, string[]>);
    expect(phases.length).toBeGreaterThanOrEqual(2);
  });

  it('all mock story IDs in implementationOrder resolve to a story', () => {
    const byId   = new Map(mockPrd.stories.map((s: any) => [s.id, s]));
    const allIds = Object.values(mockPrd.implementationOrder as Record<string, string[]>).flat();
    for (const id of allIds) {
      expect(byId.has(id), `${id} referenced in implementationOrder but not in stories`).toBe(true);
    }
  });

  it('every mock story has agentProfile for failure analyst to read skill addendum', () => {
    for (const story of mockPrd.stories) {
      expect(story.agentProfile, `Story ${story.id} missing agentProfile`).toBeTruthy();
    }
  });

  it('every mock story has at least one AC for the analyst to patch', () => {
    for (const story of mockPrd.stories) {
      expect(
        (story.acceptanceCriteria as string[]).length,
        `Story ${story.id} has empty ACs`
      ).toBeGreaterThan(0);
    }
  });
});

// ── 6. Mock profiles structural properties ────────────────────────────────────
describe('mock profiles fixture — structural framework contract', () => {
  it('mock profiles has profiles object', () => {
    expect(typeof mockProfiles.profiles).toBe('object');
  });

  it('all roles referenced in mock PRD exist in mock profiles', () => {
    const profileRoles = new Set(Object.keys(mockProfiles.profiles));
    for (const story of mockPrd.stories) {
      expect(
        profileRoles.has(story.agentProfile),
        `Story ${story.id} agentProfile="${story.agentProfile}" not in mock-profiles.json`
      ).toBe(true);
    }
  });

  it('every mock profile has an addendum field for skill note persistence', () => {
    for (const [role, profile] of Object.entries(mockProfiles.profiles as Record<string, any>)) {
      expect(
        typeof profile.addendum,
        `Profile [${role}] missing addendum field`
      ).toBe('string');
    }
  });
});
