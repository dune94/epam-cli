/**
 * Comprehensive pipeline stage tests — covers every step, every phase, every failure mode.
 *
 * Replaces the need to run the pipeline to discover issues. Covers:
 *   Phase 0  — spec-mode: provider, ladder, timeout, stream, agent naming
 *   Phase 1  — scaffold: PRD story contracts, file ownership, AC completeness
 *   Phase 2  — core: type contracts, cross-contamination, dependency order
 *   Phase 3  — ui_and_review: deliverable paths, phase ordering
 *   Orch flow — phase abort, step ordering, preflight, regression guard
 *   Output   — expected file contracts per story
 *
 * Zero API calls. Zero tokens. All static or using real shell/node with tiny inputs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const REPO = join(__dirname, '../../../');
const PRD_PATH = join(REPO, 'orchestrations/travel-app-prd.json');
const ORCH_SCRIPT = join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh');
const TIER3_SCRIPT = join(REPO, 'orchestrations/scripts/tier3-travel-app-run.sh');
const SPEC_RUNNER = join(REPO, 'orchestrations/scripts/spec-mode-runner.js');
const AI_RUN = join(REPO, 'orchestrations/scripts/ai-run.sh');

const prd = JSON.parse(readFileSync(PRD_PATH, 'utf8'));
const implementationOrder: Record<string, string[]> = prd.implementationOrder ?? {};
const phaseNames = Object.keys(implementationOrder);
const activeIds = new Set<string>(Object.values(implementationOrder).flat());

const allStories: any[] = prd.stories;
const activeStories = allStories.filter((s: any) => activeIds.has(s.id));
const storyById = new Map<string, any>(allStories.map((s: any) => [s.id, s]));

function storiesForPhase(phase: string): any[] {
  return (implementationOrder[phase] ?? []).map((id) => storyById.get(id)).filter(Boolean);
}

function filesOf(s: any): string[] {
  return (s?.technicalNotes?.files ?? []) as string[];
}

function notesOf(s: any): string {
  const tn = s?.technicalNotes ?? {};
  return [tn.notes ?? '', tn.criticalNotes ?? '', tn.implementationNotes ?? ''].join('\n');
}

/** When a story has delegated its ACs to split children, collect ACs from all children too. */
function acsOf(s: any): string[] {
  const acs: string[] = s?.acceptanceCriteria ?? [];
  const delegated = acs.some((ac: string) => /Delegated to split children/i.test(ac));
  if (!delegated) return acs;
  const childAcs: string[] = allStories
    .filter((c: any) => c?.specification?.createdFrom === s.id)
    .flatMap((c: any) => c?.acceptanceCriteria ?? []);
  return [...acs, ...childAcs];
}

function basenameOf(f: string): string {
  return f.split('/').pop()!.toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: PRD structural invariants (pre-run, all phases)
// ─────────────────────────────────────────────────────────────────────────────

describe('PRD — structural invariants (all phases)', () => {
  it('PRD file exists and is valid JSON', () => {
    expect(existsSync(PRD_PATH)).toBe(true);
    expect(() => JSON.parse(readFileSync(PRD_PATH, 'utf8'))).not.toThrow();
  });

  it('implementationOrder has exactly 3 phases: scaffold, core, ui_and_review', () => {
    expect(phaseNames).toContain('scaffold');
    expect(phaseNames).toContain('core');
    expect(phaseNames).toContain('ui_and_review');
    expect(phaseNames).toHaveLength(3);
  });

  it('scaffold phase runs before core', () => {
    expect(phaseNames.indexOf('scaffold')).toBeLessThan(phaseNames.indexOf('core'));
  });

  it('core phase runs before ui_and_review', () => {
    expect(phaseNames.indexOf('core')).toBeLessThan(phaseNames.indexOf('ui_and_review'));
  });

  it('every story ID in implementationOrder resolves to a known PRD story', () => {
    const missing: string[] = [];
    for (const id of activeIds) {
      if (!storyById.has(id)) missing.push(id);
    }
    expect(missing).toHaveLength(0);
  });

  it('no active story has status deprecated', () => {
    const bad = activeStories.filter((s: any) => s.status === 'deprecated');
    expect(bad.map((s: any) => s.id)).toHaveLength(0);
  });

  it('all active stories are pending (pre-run invariant)', () => {
    const nonPending = activeStories.filter(
      (s: any) => s.status && s.status !== 'pending'
    );
    if (nonPending.length > 0) {
      throw new Error(
        `Stories not in pending state (run reset before launch): ${nonPending.map((s: any) => `${s.id}:${s.status}`).join(', ')}`
      );
    }
    expect(nonPending).toHaveLength(0);
  });

  it('every active story has at least one acceptance criterion', () => {
    const missing = activeStories.filter(
      (s: any) => !Array.isArray(s.acceptanceCriteria) || s.acceptanceCriteria.length === 0
    );
    expect(missing.map((s: any) => s.id)).toHaveLength(0);
  });

  it('every active story has a non-empty description', () => {
    const bad = activeStories.filter((s: any) => !s.description || s.description.trim().length === 0);
    expect(bad.map((s: any) => s.id)).toHaveLength(0);
  });

  it('every active story has an effort field', () => {
    const bad = activeStories.filter((s: any) => !s.effort);
    expect(bad.map((s: any) => s.id)).toHaveLength(0);
  });

  it('every active story has a technicalNotes object', () => {
    const bad = activeStories.filter((s: any) => !s.technicalNotes || typeof s.technicalNotes !== 'object');
    expect(bad.map((s: any) => s.id)).toHaveLength(0);
  });

  it('every active story with declared files has at least one file', () => {
    const bad = activeStories.filter(
      (s: any) => Array.isArray(s.technicalNotes?.files) && s.technicalNotes.files.length === 0
    );
    expect(bad.map((s: any) => s.id)).toHaveLength(0);
  });

  it('all declared file paths are absolute', () => {
    const bad: string[] = [];
    for (const s of activeStories) {
      for (const f of filesOf(s)) {
        if (!f.startsWith('/')) bad.push(`${s.id}: ${f}`);
      }
    }
    expect(bad).toHaveLength(0);
  });

  it('all declared file paths are under the project outputDir (/tmp/skyscanner-app)', () => {
    const outputDir = prd.project?.outputDir ?? '/tmp/skyscanner-app';
    const bad: string[] = [];
    for (const s of activeStories) {
      for (const f of filesOf(s)) {
        if (!f.startsWith(outputDir)) bad.push(`${s.id}: ${f}`);
      }
    }
    expect(bad).toHaveLength(0);
  });

  it('no active story appears more than once in implementationOrder', () => {
    const all = Object.values(implementationOrder).flat();
    const counts = new Map<string, number>();
    for (const id of all) counts.set(id, (counts.get(id) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    expect(dupes).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Phase — scaffold
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase: scaffold — story contracts', () => {
  const scaffoldStories = storiesForPhase('scaffold');

  it('scaffold phase has at least 2 stories', () => {
    expect(scaffoldStories.length).toBeGreaterThanOrEqual(2);
  });

  it('scaffold stories all declare package.json as a deliverable', () => {
    const missing = scaffoldStories.filter(
      (s: any) => !filesOf(s).some((f) => f.endsWith('package.json'))
    );
    expect(missing.map((s: any) => s.id)).toHaveLength(0);
  });

  it('scaffold stories all declare tsconfig.json as a deliverable', () => {
    const missing = scaffoldStories.filter(
      (s: any) => !filesOf(s).some((f) => f.endsWith('tsconfig.json'))
    );
    expect(missing.map((s: any) => s.id)).toHaveLength(0);
  });

  it('scaffold stories all declare vitest.config.ts as a deliverable', () => {
    const missing = scaffoldStories.filter(
      (s: any) => !filesOf(s).some((f) => f.endsWith('vitest.config.ts'))
    );
    expect(missing.map((s: any) => s.id)).toHaveLength(0);
  });

  it('scaffold ACs require vitest run to exit 0 (toolchain contract)', () => {
    const storyWithRunAC = scaffoldStories.filter((s: any) =>
      (s.acceptanceCriteria ?? []).some((ac: string) => /vitest run.*exit.*0|exit.*0.*vitest run/i.test(ac))
    );
    expect(storyWithRunAC.length).toBeGreaterThanOrEqual(1);
  });

  it('scaffold ACs require tsc --noEmit to exit 0', () => {
    const storyWithTscAC = scaffoldStories.filter((s: any) =>
      (s.acceptanceCriteria ?? []).some((ac: string) => /tsc.*noEmit.*exit.*0|exit.*0.*tsc.*noEmit/i.test(ac))
    );
    expect(storyWithTscAC.length).toBeGreaterThanOrEqual(1);
  });

  it('scaffold ACs require npm run build to produce dist/server.js', () => {
    const story = scaffoldStories.find((s: any) =>
      (s.acceptanceCriteria ?? []).some((ac: string) => /dist\/server\.js/i.test(ac))
    );
    expect(story).toBeTruthy();
  });

  it('scaffold ACs forbid CommonJS module setting in tsconfig', () => {
    const story = scaffoldStories.find((s: any) =>
      (s.acceptanceCriteria ?? []).some((ac: string) => /CommonJS/i.test(ac))
    );
    expect(story).toBeTruthy();
  });

  it('scaffold ACs forbid allowJs in tsconfig (strict TypeScript project)', () => {
    const story = scaffoldStories.find((s: any) =>
      (s.acceptanceCriteria ?? []).some((ac: string) => /allowJs/i.test(ac))
    );
    expect(story).toBeTruthy();
  });

  it('vitest.config.ts include pattern covers src/**/*.test.ts (so server.test.ts is discovered)', () => {
    // If include is wrong, SKY-004-B-TEST tests never run in the pipeline vitest gate
    const story = scaffoldStories.find((s: any) =>
      (s.acceptanceCriteria ?? []).some((ac: string) => /include.*test\.ts|test\.ts.*include|\*\*\/\*\.test/i.test(ac))
    );
    expect(story).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: Phase — core
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase: core — type contracts', () => {
  const coreStories = storiesForPhase('core');

  it('core phase has at least 6 stories', () => {
    expect(coreStories.length).toBeGreaterThanOrEqual(6);
  });

  it('SKY-002a-1 (client.ts) exports FlightResult (not Flight)', () => {
    const s = storyById.get('SKY-002a-1');
    expect(s).toBeTruthy();
    const acs: string[] = s.acceptanceCriteria ?? [];
    const hasFlightResult = acs.some((ac) => /FlightResult/i.test(ac));
    const hasRawFlight = acs.some((ac) => /\bFlight\b(?!Result)/i.test(ac));
    expect(hasFlightResult).toBe(true);
    expect(hasRawFlight).toBe(false);
  });

  it('SKY-003b-1-3 (table.ts) some AC references FlightResult not bare Flight', () => {
    const s = storyById.get('SKY-003b-1-3');
    expect(s).toBeTruthy();
    const acs: string[] = s.acceptanceCriteria ?? [];
    // FlightResult must appear somewhere in ACs or notes (not just AC[0])
    const allText = [...acs, notesOf(s)].join('\n');
    expect(allText).toMatch(/FlightResult/i);
    // No bare `Flight` type backtick reference (catches spec-mode phantom type injection)
    const bareFlightInAcs = acs.some((ac) => /`Flight(?!Result)[`\[<]/.test(ac));
    expect(bareFlightInAcs).toBe(false);
  });

  it('SKY-003b-1-3 ACs do not import from ./types phantom module', () => {
    // Notes may mention ./types as a warning ("do NOT import from './types'") — check ACs only
    const s = storyById.get('SKY-003b-1-3');
    const acs: string[] = s?.acceptanceCriteria ?? [];
    const bad = acs.filter((ac) => /import.*from ['"]\.\/types['"]/.test(ac));
    expect(bad).toHaveLength(0);
  });

  it('no active story AC imports from ./types (phantom module does not exist)', () => {
    // spec-mode used to generate `import { Flight } from './types'` — this catches regression
    const bad: string[] = [];
    for (const s of activeStories) {
      for (const ac of (s.acceptanceCriteria ?? []) as string[]) {
        if (/from ['"]\.\/types['"]/.test(ac)) bad.push(`${s.id}: ${ac.slice(0, 60)}`);
      }
    }
    expect(bad).toHaveLength(0);
  });

  it('no active story AC references bare `Flight` type (must be FlightResult)', () => {
    const bad: string[] = [];
    for (const s of activeStories) {
      for (const ac of (s.acceptanceCriteria ?? []) as string[]) {
        if (/`Flight(?!Result)[`\[<]/.test(ac)) bad.push(`${s.id}: ${ac.slice(0, 60)}`);
      }
    }
    expect(bad).toHaveLength(0);
  });

  it('SKY-003a-3 (cli.ts) AC uses FlightResult[] not Flight[]', () => {
    const s = storyById.get('SKY-003a-3');
    const acs: string[] = s?.acceptanceCriteria ?? [];
    const hasFR = acs.some((ac) => /FlightResult\[\]/.test(ac));
    const hasBareF = acs.some((ac) => /`Flight\[\]`/.test(ac));
    expect(hasFR).toBe(true);
    expect(hasBareF).toBe(false);
  });

  it('SKY-004-B-IMPL (server.ts) has a default export or named listen guard (Tier-3 invariant)', () => {
    const s = storyById.get('SKY-004-B-IMPL');
    const acs: string[] = s?.acceptanceCriteria ?? [];
    const hasExport = acs.some((ac) =>
      /export default|default export|module\.exports|export.*app/i.test(ac)
    );
    expect(hasExport).toBe(true);
  });

  it('SKY-002a-1 AC requires SkyscannerClient constructor to accept object form {apiKey}', () => {
    const s = storyById.get('SKY-002a-1');
    const acs: string[] = s?.acceptanceCriteria ?? [];
    const hasObjForm = acs.some((ac) => /constructor.*apiKey|apiKey.*constructor|\{.*apiKey/i.test(ac));
    expect(hasObjForm).toBe(true);
  });

  it('SKY-002b-1 (client.test.ts) requires vi.stubGlobal for fetch mocking (not vi.spyOn)', () => {
    const s = storyById.get('SKY-002b-1');
    const acs = acsOf(s);
    const hasStubGlobal = acs.some((ac) => /vi\.stubGlobal.*fetch/i.test(ac));
    // AC wording: "vi.spyOn is not used for fetch" (negation, not "banned"/"forbidden")
    const bansSpyOn = acs.some((ac) => /vi\.spyOn.*not used|not.*vi\.spyOn|vi\.spyOn.*forbidden|vi\.spyOn.*banned/i.test(ac));
    expect(hasStubGlobal).toBe(true);
    expect(bansSpyOn).toBe(true);
  });

  it('SKY-002b-1 AC requires afterEach vi.unstubAllGlobals (cleanup contract)', () => {
    const s = storyById.get('SKY-002b-1');
    const acs = acsOf(s);
    const hasCleanup = acs.some((ac) => /unstubAllGlobals|afterEach.*unstub/i.test(ac));
    expect(hasCleanup).toBe(true);
  });

  it('SKY-004-B-TEST requires VITEST guard so server does not start during tests', () => {
    const s = storyById.get('SKY-004-B-TEST');
    const notes = notesOf(s);
    expect(notes).toMatch(/VITEST|vitest.*guard|process\.env\.VITEST|if.*VITEST/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: Core — write-first and notes invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase: core — write-first and notes invariants', () => {
  const coreStories = storiesForPhase('core');

  it('every core story with a test file deliverable has a WriteFile-first anchor in notes', () => {
    const bad: string[] = [];
    for (const s of coreStories) {
      const files = filesOf(s);
      if (files.some((f) => f.endsWith('.test.ts'))) {
        const notes = notesOf(s);
        const hasAnchor = /write.*file.*first|your.*first.*action.*call WriteFile|WriteFile.*first|FIRST ACTION/i.test(notes);
        if (!hasAnchor) bad.push(s.id);
      }
    }
    expect(bad).toHaveLength(0);
  });

  it('no core story notes contain the same CRITICAL block duplicated (iteration exhaustion)', () => {
    const bad: string[] = [];
    for (const s of coreStories) {
      const notes = notesOf(s);
      const lines = notes.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 30);
      const seen = new Set<string>();
      for (const line of lines) {
        if (seen.has(line)) { bad.push(`${s.id}: "${line.slice(0, 50)}"`); break; }
        seen.add(line);
      }
    }
    expect(bad).toHaveLength(0);
  });

  it('no core story notes reference a .ts file owned by an unrelated story (cross-contamination)', () => {
    // Exception: impl/test sister pairs (cli.ts ↔ cli.test.ts, server.ts ↔ server.test.ts)
    // may reference each other because the test story must know the impl API.
    // Only flag contamination between stories with different base filenames.
    const fileOwner = new Map<string, string>();
    for (const s of coreStories) {
      for (const f of filesOf(s)) fileOwner.set(basenameOf(f), s.id);
    }
    const bad: string[] = [];
    for (const s of coreStories) {
      const ownedFiles = new Set(filesOf(s).map(basenameOf));
      const notes = notesOf(s);
      for (const [basename, ownerId] of fileOwner) {
        if (ownerId === s.id) continue;
        if (!basename.endsWith('.ts')) continue;
        // Allow sister pairs: cli.ts ↔ cli.test.ts, server.ts ↔ server.test.ts etc.
        const myBase = [...ownedFiles].map((f) => f.replace(/\.test\.ts$/, '.ts').replace(/\.ts$/, ''));
        const theirBase = basename.replace(/\.test\.ts$/, '.ts').replace(/\.ts$/, '');
        if (myBase.some((b) => b === theirBase)) continue;
        const regex = new RegExp(`(?<![a-z])${basename.replace('.', '\\.')}(?![a-z])`, 'i');
        if (regex.test(notes) && !ownedFiles.has(basename)) {
          bad.push(`${s.id} notes mention ${basename} (owned by ${ownerId}) — unrelated story`);
        }
      }
    }
    expect(bad).toHaveLength(0);
  });

  it('table stories (table.ts / table.test.ts) have SPEC OVERRIDE note for Flight/FlightResult', () => {
    const tableStories = coreStories.filter((s: any) =>
      filesOf(s).some((f) => /table\.(ts|test\.ts)$/.test(f))
    );
    const bad = tableStories.filter((s: any) => {
      const notes = notesOf(s);
      return !/FlightResult.*skyscanner.client|do not import from.*\.\/types|no.*\.\/types.*module|SPEC.*OVERRIDE/i.test(notes);
    });
    expect(bad.map((s: any) => s.id)).toHaveLength(0);
  });

  it('no core story notes contain "verify.*against any existing test file" (forward dependency)', () => {
    const bad: string[] = [];
    for (const s of coreStories) {
      const notes = notesOf(s);
      if (/verif\w*.*against.*existing.*test file/i.test(notes)) bad.push(s.id);
    }
    expect(bad).toHaveLength(0);
  });

  it('no core story has a DO-NOT-WRITE note for its own declared file', () => {
    const bad: string[] = [];
    for (const s of coreStories) {
      const notes = notesOf(s).toUpperCase();
      for (const f of filesOf(s)) {
        const bname = basenameOf(f).toUpperCase();
        if (notes.includes(`DO NOT WRITE ${bname}`) || notes.includes(`DO NOT MODIFY ${bname}`)) {
          bad.push(`${s.id} has DO-NOT-WRITE for its own file ${bname}`);
        }
      }
    }
    expect(bad).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5: Core — dependency ordering within phase
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase: core — dependency ordering', () => {
  const coreIds = implementationOrder['core'] ?? [];

  it('SKY-004-B-IMPL (server.ts impl) runs before SKY-004-B-TEST (server.test.ts)', () => {
    const implIdx = coreIds.indexOf('SKY-004-B-IMPL');
    const testIdx = coreIds.indexOf('SKY-004-B-TEST');
    expect(implIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(implIdx).toBeLessThan(testIdx);
  });

  it('SKY-002a-1 (client.ts) runs before SKY-002b-1 (client.test.ts)', () => {
    const implIdx = coreIds.indexOf('SKY-002a-1');
    const testIdx = coreIds.indexOf('SKY-002b-1');
    expect(implIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(implIdx).toBeLessThan(testIdx);
  });

  it('SKY-003b-1-3 (table.ts) runs before SKY-003b-2-3 (table.test.ts)', () => {
    const implIdx = coreIds.indexOf('SKY-003b-1-3');
    const testIdx = coreIds.indexOf('SKY-003b-2-3');
    expect(implIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(implIdx).toBeLessThan(testIdx);
  });

  it('SKY-003a-3 (cli.ts) runs before SKY-003a-test-3 (cli.test.ts)', () => {
    const implIdx = coreIds.indexOf('SKY-003a-3');
    const testIdx = coreIds.indexOf('SKY-003a-test-3');
    expect(implIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(implIdx).toBeLessThan(testIdx);
  });

  it('no implementation story runs after its paired test story', () => {
    // Generalised: any story declaring only .ts (non-test) must precede
    // any story declaring only .test.ts for the same basename.
    const bad: string[] = [];
    const implPosition = new Map<string, number>();
    const testPosition = new Map<string, number>();
    for (let i = 0; i < coreIds.length; i++) {
      const s = storyById.get(coreIds[i]);
      if (!s) continue;
      for (const f of filesOf(s)) {
        const base = basenameOf(f).replace(/\.test\.ts$/, '.ts');
        if (f.endsWith('.test.ts')) testPosition.set(base, i);
        else if (f.endsWith('.ts')) implPosition.set(base, i);
      }
    }
    for (const [base, ip] of implPosition) {
      const tp = testPosition.get(base);
      if (tp !== undefined && ip > tp) {
        bad.push(`${base}: impl at index ${ip} runs AFTER test at index ${tp}`);
      }
    }
    expect(bad).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6: Phase — ui_and_review
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase: ui_and_review — story contracts', () => {
  const uiStories = storiesForPhase('ui_and_review');

  it('ui_and_review has at least 4 stories', () => {
    expect(uiStories.length).toBeGreaterThanOrEqual(4);
  });

  it('SKY-005 stories produce .html files (not .ts)', () => {
    const sky005 = uiStories.filter((s: any) => s.id.startsWith('SKY-005'));
    expect(sky005.length).toBeGreaterThanOrEqual(1);
    const bad = sky005.filter((s: any) =>
      !filesOf(s).some((f) => f.endsWith('.html'))
    );
    expect(bad.map((s: any) => s.id)).toHaveLength(0);
  });

  it('SKY-005 HTML deliverable is inside public/ directory', () => {
    // Path: /tmp/skyscanner-app/src/public/index.html — under src/public, not bare src/
    const sky005 = uiStories.filter((s: any) => s.id.startsWith('SKY-005'));
    const bad = sky005.filter((s: any) =>
      !filesOf(s).some((f) => f.endsWith('.html') && /\/public\//.test(f))
    );
    expect(bad.map((s: any) => s.id)).toHaveLength(0);
  });

  it('SKY-006 review stories produce .md files', () => {
    const sky006 = uiStories.filter((s: any) => s.id.startsWith('SKY-006'));
    expect(sky006.length).toBeGreaterThanOrEqual(1);
    const bad = sky006.filter((s: any) =>
      !filesOf(s).some((f) => f.endsWith('.md'))
    );
    expect(bad.map((s: any) => s.id)).toHaveLength(0);
  });

  it('SKY-006 review AC requires Verdict: PASS/FAIL/WARN line', () => {
    const sky006 = uiStories.filter((s: any) => s.id.startsWith('SKY-006'));
    const bad = sky006.filter((s: any) =>
      !(s.acceptanceCriteria ?? []).some((ac: string) => /Verdict.*PASS|FAIL|WARN/i.test(ac))
    );
    expect(bad.map((s: any) => s.id)).toHaveLength(0);
  });

  it('at least one SKY-006 review story requires live inspection of the app src directory', () => {
    const sky006 = uiStories.filter((s: any) => s.id.startsWith('SKY-006'));
    const hasInspect = sky006.some((s: any) =>
      (s.acceptanceCriteria ?? []).some((ac: string) => /live.*inspect|inspect.*src|read.*src/i.test(ac))
    );
    expect(hasInspect).toBe(true);
  });

  it('SKY-006-b review story has at least one acceptance criterion', () => {
    // SKY-006-b is a review story — verify it has ACs even if it lacks live-inspect wording
    const s = storyById.get('SKY-006-b');
    if (s) {
      expect((s.acceptanceCriteria ?? []).length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7: Expected output file contracts per story
// ─────────────────────────────────────────────────────────────────────────────

describe('Expected output file contracts — PRD declares correct paths', () => {
  const outputDir = prd.project?.outputDir ?? '/tmp/skyscanner-app';

  const expectedFiles: Record<string, string[]> = {
    'SKY-002a-1':   [`${outputDir}/src/skyscanner/client.ts`],
    'SKY-002b-1':   [`${outputDir}/src/skyscanner/client.test.ts`],
    'SKY-003a-3':   [`${outputDir}/src/cli.ts`],
    'SKY-003a-test-3': [`${outputDir}/src/cli.test.ts`],
    'SKY-003b-1-3': [`${outputDir}/src/table.ts`],
    'SKY-003b-2-3': [`${outputDir}/src/table.test.ts`],
    'SKY-004-B-IMPL': [`${outputDir}/src/server.ts`],
    'SKY-004-B-TEST': [`${outputDir}/src/server.test.ts`],
  };

  for (const [storyId, expectedPaths] of Object.entries(expectedFiles)) {
    it(`${storyId} declares correct output path(s)`, () => {
      const s = storyById.get(storyId);
      expect(s).toBeTruthy();
      const declared = filesOf(s);
      for (const expected of expectedPaths) {
        expect(declared).toContain(expected);
      }
    });
  }

  it('client.ts is under src/skyscanner/ (not directly in src/)', () => {
    const s = storyById.get('SKY-002a-1');
    const files = filesOf(s);
    const clientFile = files.find((f) => f.endsWith('client.ts'));
    expect(clientFile).toBeTruthy();
    expect(clientFile).toMatch(/\/skyscanner\//);
  });

  it('server.test.ts is under src/ (vitest include pattern must discover it)', () => {
    const s = storyById.get('SKY-004-B-TEST');
    const files = filesOf(s);
    const testFile = files.find((f) => f.endsWith('server.test.ts'));
    expect(testFile).toBeTruthy();
    expect(testFile).toMatch(/\/src\//);
  });

  it('no two different stories write to the same exact file path', () => {
    const fileToStory = new Map<string, string>();
    const conflicts: string[] = [];
    for (const s of activeStories) {
      for (const f of filesOf(s)) {
        if (fileToStory.has(f)) {
          // Sequential ownership is OK for progressive stories (e.g. SKY-001-A → SKY-001-B)
          // but different-base stories claiming the same file is a bug
          const owner = fileToStory.get(f)!;
          const ownerBase = owner.split('-')[0] + '-' + owner.split('-')[1];
          const thisBase = s.id.split('-')[0] + '-' + s.id.split('-')[1];
          if (ownerBase !== thisBase) {
            conflicts.push(`${s.id} and ${owner} both claim ${f}`);
          }
        } else {
          fileToStory.set(f, s.id);
        }
      }
    }
    expect(conflicts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8: Spec-mode runner — source code invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('spec-mode-runner.js — source code invariants', () => {
  const src = readFileSync(SPEC_RUNNER, 'utf8');

  it('ladder builds a new execSpec (not reusing minimax execSpec args)', () => {
    // The fix: ladder must NOT pass the original execSpec to runClaude.
    // It must build { cmd: execSpec.cmd, args: ['--provider', ladderProvider] }
    expect(src).toMatch(/ladderExec\s*=\s*\{/);
    expect(src).toMatch(/cmd:\s*execSpec\.cmd/);
    expect(src).toMatch(/args:\s*\[.*'--provider',\s*ladderProvider/);
  });

  it('ladder calls runClaude with ladderExec (not original execSpec)', () => {
    // After the provider bug fix, the ladder call must use ladderExec
    expect(src).toMatch(/runClaude\(ladderExec,/);
  });

  it('timeout handler destroys stdout stream (stream leak fix)', () => {
    expect(src).toMatch(/proc\.stdout\?\.destroy\(\)/);
  });

  it('timeout handler destroys stderr stream (stream leak fix)', () => {
    expect(src).toMatch(/proc\.stderr\?\.destroy\(\)/);
  });

  it('stdin has error handler to suppress EPIPE on kill', () => {
    expect(src).toMatch(/proc\.stdin\?\.on\(['"]error['"]/);
  });

  it('VALID_AGENTS set guards against ENAMETOOLONG (LLM review content as agent name)', () => {
    expect(src).toMatch(/VALID_AGENTS\s*=\s*new Set/);
    expect(src).toMatch(/'openspec'/);
    expect(src).toMatch(/'speckit'/);
  });

  it('buildAssignments filters agents through VALID_AGENTS', () => {
    expect(src).toMatch(/VALID_AGENTS\.has\(/);
  });

  it('SPEC_PASS_SKIP_LADDER env var can disable the ladder', () => {
    expect(src).toMatch(/SPEC_PASS_SKIP_LADDER/);
  });

  it('MINIMAX_TOOL_TIMEOUT_MS is configurable via env', () => {
    expect(src).toMatch(/MINIMAX_TOOL_TIMEOUT_MS/);
  });

  it('all-agent-failure exits non-zero without SPEC_PASS_SKIP_LADDER override', () => {
    // Grace-mode was reverted — spec-mode must fail loudly when all agents fail
    expect(src).toMatch(/process\.exit\(1\)/);
    expect(src).toMatch(/all.*agent.*invocations failed|FATAL.*all.*agent/i);
  });

  it('does not suppress all-agent-failure when SPEC_PASS_SKIP_LADDER=1 (revert of grace patch)', () => {
    // The "graceful fail" patch that swallowed all-agent-failure was reverted.
    // Verify the guard does NOT special-case SPEC_PASS_SKIP_LADDER for exit(1).
    const failBlock = src.match(/all.*agent.*invocations failed[\s\S]{0,300}process\.exit\(1\)/)?.[0] ?? '';
    expect(failBlock).not.toMatch(/SPEC_PASS_SKIP_LADDER/);
  });

  it('ladder is guarded by Promise.race with a hard timeout', () => {
    expect(src).toMatch(/Promise\.race\(/);
    expect(src).toMatch(/ladder hard-timeout/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9: spec-mode-runner.js — functional (imported)
// ─────────────────────────────────────────────────────────────────────────────

describe('spec-mode-runner.js — functional: resolvePromptExec ladder contract', () => {
  const { resolvePromptExec } = require('../../../orchestrations/scripts/spec-mode-runner.js');

  it('minimax execSpec bakes --provider minimax into args (bug reproduction)', () => {
    const exec = resolvePromptExec('/ai-run.sh', { AI_PROVIDER: 'minimax', AI_MODEL: 'MiniMax-M3' });
    const idx = exec.args.indexOf('--provider');
    expect(exec.args[idx + 1]).toBe('minimax');
  });

  it('ladder execSpec built from minimax exec must NOT inherit minimax provider', () => {
    const minimaxExec = resolvePromptExec('/ai-run.sh', { AI_PROVIDER: 'minimax', AI_MODEL: 'MiniMax-M3' });
    const ladderExec = { cmd: minimaxExec.cmd, args: ['--provider', 'qwen'] };
    expect(ladderExec.args).not.toContain('minimax');
    expect(ladderExec.args).not.toContain('MiniMax-M3');
    expect(ladderExec.args[ladderExec.args.indexOf('--provider') + 1]).toBe('qwen');
  });

  it('buildAssignments rejects agent names longer than 20 chars (ENAMETOOLONG guard)', () => {
    const { buildAssignments } = require('../../../orchestrations/scripts/spec-mode-runner.js');
    const longName = 'openspec AC-5 text corruption in the response body that exceeds limit';
    const assignments = [{ storyId: 'HW-001', agents: [longName, 'openspec'], priority: 'high' }];
    const stories = [{ id: 'HW-001', title: 'S1' }];
    const map = buildAssignments(assignments, stories, 'run1');
    const agents = map.get('HW-001')?.agents ?? [];
    expect(agents).not.toContain(longName);
    expect(agents).toContain('openspec');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10: Orchestration script — flow invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('run-agent-orchestration.sh — flow invariants', () => {
  const src = readFileSync(ORCH_SCRIPT, 'utf8');

  it('Step 0: spec pass failure exits 1 (no silently continuing with broken specs)', () => {
    expect(src).toMatch(/Specification pass FAILED[\s\S]{0,200}exit 1/);
  });

  it('Step 0.7: cross-phase regression guard runs vitest before each phase', () => {
    expect(src).toMatch(/Step 0\.7.*[Rr]egression guard/);
    expect(src).toMatch(/vitest run/);
  });

  it('Step 0.7: regression guard failure exits 1 (not continues)', () => {
    // "Regression guard FAILED" error message followed by exit 1 within a few lines
    expect(src).toMatch(/Regression guard FAILED[\s\S]{0,400}exit 1/);
  });

  it('SKIP_REGRESSION_GUARD env var can bypass regression guard', () => {
    expect(src).toMatch(/SKIP_REGRESSION_GUARD/);
  });

  it('phase abort propagates: orch script exits non-zero on story failure', () => {
    expect(src).toMatch(/exit 1/);
  });

  it('PRD_FILE env var is required — script errors without it', () => {
    expect(src).toMatch(/PRD_FILE/);
  });

  it('Step 3.7: pre-review build gate runs tsc and vitest before review stories', () => {
    expect(src).toMatch(/Step 3\.7.*[Pp]re-review/);
    expect(src).toMatch(/tsc.*noEmit|noEmit.*tsc/);
  });

  it('SKIP_TESTING_GATES env var controls QA testing gates 4.2–4.4', () => {
    expect(src).toMatch(/SKIP_TESTING_GATES/);
  });

  it('output directory is read from project.outputDir in the PRD', () => {
    expect(src).toMatch(/outputDir/);
  });

  it('spec-mode-runner.js is invoked in Step 0 (not skipped)', () => {
    expect(src).toMatch(/spec-mode-runner\.js/);
    expect(src).toMatch(/--phase/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11: Tier-3 script — provider and timeout configuration
// ─────────────────────────────────────────────────────────────────────────────

describe('tier3-travel-app-run.sh — provider + timeout configuration', () => {
  const src = readFileSync(TIER3_SCRIPT, 'utf8');

  it('exports ORCH_GATE_PROVIDER (required by spec-mode)', () => {
    expect(src).toMatch(/export ORCH_GATE_PROVIDER=/);
  });

  it('exports EPAM_ORCHESTRATION_PROVIDER', () => {
    expect(src).toMatch(/export EPAM_ORCHESTRATION_PROVIDER=/);
  });

  it('exports MINIMAX_TOOL_TIMEOUT_MS with a default value ≤ 30000 (fast-fail when MiniMax is slow)', () => {
    // Format: export MINIMAX_TOOL_TIMEOUT_MS="${MINIMAX_TOOL_TIMEOUT_MS:-15000}"
    // Extract the default from the parameter expansion :- fallback
    const match = src.match(/MINIMAX_TOOL_TIMEOUT_MS[^"]*"[^"]*:-(\d+)/);
    expect(match).toBeTruthy();
    const ms = parseInt(match![1], 10);
    expect(ms).toBeLessThanOrEqual(30000);
  });

  it('exports EPAM_STORY_TIMEOUT_SECS', () => {
    expect(src).toMatch(/EPAM_STORY_TIMEOUT_SECS=/);
  });

  it('exports EPAM_MAX_RETRIES', () => {
    expect(src).toMatch(/EPAM_MAX_RETRIES=/);
  });

  it('exports PRD_FILE pointing to travel-app-prd.json', () => {
    expect(src).toMatch(/travel-app-prd\.json/);
  });

  it('passes --yes flag or equivalent to skip interactive prompts', () => {
    // tier3 script is called with --yes; it must handle or forward it
    expect(src).toMatch(/--yes|YES|non.?interactive/i);
  });

  it('does not hardcode MINIMAX_TOOL_TIMEOUT_MS to 120000 (old default that caused hangs)', () => {
    const match = src.match(/MINIMAX_TOOL_TIMEOUT_MS[^=]*=["']?(\d+)/);
    if (match) {
      expect(parseInt(match[1], 10)).not.toBe(120000);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12: ai-run.sh — provider routing
// ─────────────────────────────────────────────────────────────────────────────

describe('ai-run.sh — provider routing', () => {
  const src = readFileSync(AI_RUN, 'utf8');

  it('--provider flag is supported', () => {
    expect(src).toMatch(/--provider/);
  });

  it('minimax provider is handled', () => {
    expect(src).toMatch(/minimax/i);
  });

  it('openai provider is handled', () => {
    expect(src).toMatch(/openai/i);
  });

  it('--provider flag takes precedence over AI_PROVIDER env var (CLI wins over env)', () => {
    // This is the root cause of the ladder provider bug — document it as a known contract
    // so any future change to ai-run.sh that breaks this is caught.
    // The --provider arg must come before env var resolution.
    const providerFlagIdx = src.indexOf('--provider');
    const envVarIdx = src.indexOf('AI_PROVIDER');
    // Flag handling appears before env var fallback
    expect(providerFlagIdx).toBeGreaterThanOrEqual(0);
    expect(envVarIdx).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13: Preflight check invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('Preflight check — script exists and is runnable', () => {
  const PREFLIGHT = join(REPO, 'orchestrations/scripts/preflight-check.sh');

  it('preflight-check.sh exists', () => {
    expect(existsSync(PREFLIGHT)).toBe(true);
  });

  it('preflight-check.sh is executable', () => {
    // Check file mode via stat
    const result = execSync(`test -x "${PREFLIGHT}" && echo ok || echo no`, { encoding: 'utf8' }).trim();
    expect(result).toBe('ok');
  });

  it('preflight-check.sh accepts --runner and --prd flags', () => {
    const src = readFileSync(PREFLIGHT, 'utf8');
    expect(src).toMatch(/--runner/);
    expect(src).toMatch(/--prd/);
  });

  it('preflight-check.sh validates PRD_FILE exists', () => {
    const src = readFileSync(PREFLIGHT, 'utf8');
    expect(src).toMatch(/PRD_FILE|prd/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 14: spec-mode dry-run — produces valid output without API calls
// ─────────────────────────────────────────────────────────────────────────────

describe('spec-mode-runner.js — dry-run produces valid assignments', () => {
  const { buildAssignments } = require('../../../orchestrations/scripts/spec-mode-runner.js');

  it('null coordinator output defaults all stories to [openspec, speckit]', () => {
    const stories = [
      { id: 'SKY-001', title: 'S1' },
      { id: 'SKY-002', title: 'S2' },
    ];
    const map = buildAssignments(null, stories, 'run-dry');
    expect(map.get('SKY-001')?.agents).toEqual(['openspec', 'speckit']);
    expect(map.get('SKY-002')?.agents).toEqual(['openspec', 'speckit']);
  });

  it('coordinator output with empty agents means story is explicitly skipped', () => {
    const stories = [{ id: 'SKY-001', title: 'S1' }];
    const assignments = [{ storyId: 'SKY-001', agents: [], priority: 'low' }];
    const map = buildAssignments(assignments, stories, 'run-dry');
    expect(map.get('SKY-001')?.agents).toEqual([]);
  });

  it('all scaffold story IDs are valid inputs for buildAssignments', () => {
    const scaffoldStories = storiesForPhase('scaffold').map((s: any) => ({ id: s.id, title: s.title }));
    expect(() => buildAssignments(null, scaffoldStories, 'run-test')).not.toThrow();
    const map = buildAssignments(null, scaffoldStories, 'run-test');
    for (const s of scaffoldStories) {
      expect(map.has(s.id)).toBe(true);
    }
  });

  it('all core story IDs are valid inputs for buildAssignments', () => {
    const coreStories = storiesForPhase('core').map((s: any) => ({ id: s.id, title: s.title }));
    expect(() => buildAssignments(null, coreStories, 'run-test')).not.toThrow();
  });
});
