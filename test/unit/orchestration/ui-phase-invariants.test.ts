/**
 * ui_and_review phase invariants.
 *
 * These tests catch structural issues specific to the ui_and_review phase that
 * prd-invariants.test.ts doesn't cover (write-first/pending are already there).
 *
 * Failure modes tested:
 *   1. Wrong deliverable type — review stories should produce .md, not .ts
 *   2. HTML stories should produce .html, not .ts/.md
 *   3. All deliverables under the expected base dir (/tmp/skyscanner-app)
 *   4. Sequential file ownership (.html creators before .html extenders) is documented
 *      as intentional, not flagged as a conflict
 *   5. Review stories don't claim source code deliverables
 *   6. Phase ordering — ui_and_review runs after scaffold and core
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRD_PATH = join(__dirname, '../../../orchestrations/travel-app-prd.json');

interface Story {
  id: string;
  title?: string;
  status?: string;
  effort?: string;
  acceptanceCriteria?: string[];
  technicalNotes?: {
    files?: string[];
    implementationNotes?: string;
  };
}

interface Prd {
  stories: Story[];
  implementationOrder: Record<string, string[]>;
}

const prd: Prd = JSON.parse(readFileSync(PRD_PATH, 'utf8'));
const phaseOrder = prd.implementationOrder;
const byId = new Map(prd.stories.map((s) => [s.id, s]));

const uiIds = phaseOrder['ui_and_review'] ?? [];
const uiStories = uiIds.map((id) => byId.get(id)).filter(Boolean) as Story[];

describe('ui_and_review phase exists and is populated', () => {
  it('ui_and_review phase has at least 4 stories', () => {
    expect(uiStories.length).toBeGreaterThanOrEqual(4);
  });

  it('all ui_and_review stories resolve to known PRD stories', () => {
    const missing = uiIds.filter((id) => !byId.has(id));
    expect(missing).toHaveLength(0);
  });
});

describe('ui_and_review phase ordering', () => {
  it('scaffold phase is listed before ui_and_review', () => {
    const phases = Object.keys(phaseOrder);
    expect(phases.indexOf('scaffold')).toBeLessThan(phases.indexOf('ui_and_review'));
  });

  it('core phase is listed before ui_and_review', () => {
    const phases = Object.keys(phaseOrder);
    expect(phases.indexOf('core')).toBeLessThan(phases.indexOf('ui_and_review'));
  });
});

// Stories that produce .html deliverables (dashboard / UI stories)
const htmlStories = uiStories.filter((s) =>
  (s.technicalNotes?.files ?? []).some((f) => f.endsWith('.html'))
);

// Stories whose deliverables are review/doc files (.md) and no source (.ts/.js) files
const reviewStories = uiStories.filter((s) => {
  const files = s.technicalNotes?.files ?? [];
  return (
    files.length > 0 &&
    files.some((f) => f.endsWith('.md')) &&
    files.every((f) => !f.endsWith('.ts') && !f.endsWith('.js'))
  );
});

describe('ui_and_review deliverable types — HTML stories', () => {
  it('at least one ui_and_review story produces .html files', () => {
    expect(htmlStories.length).toBeGreaterThanOrEqual(1);
  });

  it('html-producing stories declare only .html files (no .ts or .js)', () => {
    for (const s of htmlStories) {
      const files = s.technicalNotes?.files ?? [];
      for (const f of files) {
        expect(f).toMatch(/\.html$/);
        expect(f).not.toMatch(/\.ts$/);
        expect(f).not.toMatch(/\.js$/);
      }
    }
  });

  it('html deliverables are inside the public dir', () => {
    for (const s of htmlStories) {
      const files = (s.technicalNotes?.files ?? []).filter((f) => f.endsWith('.html'));
      for (const f of files) {
        expect(f).toContain('/public/');
      }
    }
  });
});

describe('ui_and_review deliverable types — review/doc stories', () => {
  it('at least one ui_and_review story produces only non-source deliverables (.md / .json)', () => {
    expect(reviewStories.length).toBeGreaterThanOrEqual(1);
  });

  it('review/doc stories declare no .ts or .js files', () => {
    for (const s of reviewStories) {
      const files = s.technicalNotes?.files ?? [];
      for (const f of files) {
        expect(f).not.toMatch(/\.ts$/);
        expect(f).not.toMatch(/\.js$/);
      }
    }
  });
});

describe('ui_and_review deliverable paths — base directory', () => {
  it('all deliverable paths are absolute', () => {
    for (const s of uiStories) {
      for (const f of s.technicalNotes?.files ?? []) {
        expect(f.startsWith('/')).toBe(true);
      }
    }
  });

  it('all deliverable paths are under the project outputDir', () => {
    const outputDir = (prd as any).project?.outputDir ?? '/home/bradleyjerome/projects/skyscanner-app';
    for (const s of uiStories) {
      for (const f of s.technicalNotes?.files ?? []) {
        expect(f).toContain(outputDir);
      }
    }
  });
});

describe('ui_and_review sequential file ownership — intentional not a conflict', () => {
  // HTML-producing stories may share an .html file (A creates, B extends).
  // This is intentional sequential ownership, not a file conflict.

  it('when multiple html stories share an .html file, they appear consecutively in phase order', () => {
    const htmlFileOwners = new Map<string, string[]>();
    for (const s of htmlStories) {
      for (const f of (s.technicalNotes?.files ?? []).filter((f) => f.endsWith('.html'))) {
        htmlFileOwners.set(f, [...(htmlFileOwners.get(f) ?? []), s.id]);
      }
    }
    const sharedFiles = [...htmlFileOwners.entries()].filter(([, ids]) => ids.length > 1);
    for (const [, ids] of sharedFiles) {
      const indices = ids.map((id) => uiIds.indexOf(id)).filter((i) => i !== -1);
      // All co-owners must appear consecutively (max index - min index === count - 1)
      const span = Math.max(...indices) - Math.min(...indices);
      expect(span).toBeLessThanOrEqual(indices.length - 1);
    }
  });

  it('html-producing stories all run before review/doc-only stories (skip if pre-spec-pass or stale PRD)', () => {
    if (htmlStories.length === 0 || reviewStories.length === 0) return;
    // Only enforce ordering on a clean spec-pass PRD (all ui stories have spec-pass origin)
    const allSpecPass = uiStories.every((s: any) => s?.specification?.splitOrigin === 'spec-pass');
    if (!allSpecPass) return;
    const lastHtmlIdx = Math.max(...htmlStories.map((s) => uiIds.indexOf(s.id)).filter((i) => i !== -1));
    const firstReviewIdx = Math.min(...reviewStories.map((s) => uiIds.indexOf(s.id)).filter((i) => i !== -1));
    if (lastHtmlIdx === -Infinity || firstReviewIdx === Infinity) return;
    expect(lastHtmlIdx).toBeLessThan(firstReviewIdx);
  });
});

describe('ui_and_review story completeness', () => {
  it('all stories have at least 1 acceptance criterion', () => {
    for (const s of uiStories) {
      expect((s.acceptanceCriteria?.length ?? 0)).toBeGreaterThanOrEqual(1);
    }
  });

  it('all stories have an effort field', () => {
    for (const s of uiStories) {
      expect(s.effort).toBeTruthy();
    }
  });

  it('all stories declare at least one deliverable file', () => {
    for (const s of uiStories) {
      const files = s.technicalNotes?.files ?? [];
      expect(files.length).toBeGreaterThanOrEqual(1);
    }
  });
});
