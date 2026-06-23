/**
 * PRD invariant tests — structural guarantees that must hold before every run.
 *
 * These tests prevent the class of failures where an agent exits 0 but never
 * writes its declared file because the implementation prompt didn't instruct it
 * to write first. Every story with technicalNotes.files must have the write-first
 * instruction so the agent writes immediately rather than planning.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRD_PATH = join(__dirname, '../../../orchestrations/travel-app-prd.json');
const WRITE_FIRST_MARKER = 'WRITE THE FILE FIRST';

interface Story {
  id: string;
  status?: string;
  technicalNotes?: {
    files?: unknown[];
    implementationNotes?: string;
  };
}

interface Prd {
  stories: Story[];
}

const prd: Prd = JSON.parse(readFileSync(PRD_PATH, 'utf8'));

// Only check stories that are in the execution order (active leaf stories).
// Epics, deprecated stories, and parent stories are excluded.
const implementationOrder: Record<string, string[]> = (prd as any).implementationOrder ?? {};
const activeIds = new Set(Object.values(implementationOrder).flat());

const implStories = prd.stories.filter(
  (s) =>
    activeIds.has(s.id) &&
    Array.isArray(s.technicalNotes?.files) &&
    (s.technicalNotes?.files ?? []).length > 0
);

describe('PRD write-first invariant', () => {
  it('every story with declared files has WRITE THE FILE FIRST in implementationNotes', () => {
    const missing = implStories.filter(
      (s) => !s.technicalNotes?.implementationNotes?.includes(WRITE_FIRST_MARKER)
    );
    if (missing.length > 0) {
      const ids = missing.map((s) => s.id).join(', ');
      throw new Error(
        `${missing.length} story/stories declare files but missing write-first instruction: ${ids}`
      );
    }
    expect(missing).toHaveLength(0);
  });

  it('every story with declared files has at least one file path', () => {
    const empty = implStories.filter(
      (s) => (s.technicalNotes?.files ?? []).length === 0
    );
    expect(empty).toHaveLength(0);
  });

  it('no test story claims an implementation file owned by an impl story', () => {
    // Sequential stories claiming the same file is intentional (speckit progressions).
    // The genuine bug is a test story (*.test.ts outputs) also claiming a non-test
    // implementation file that a separate impl story owns.
    const conflicts: string[] = [];
    for (const s of implStories) {
      const files = (s.technicalNotes?.files ?? []) as string[];
      const hasTestFile = files.some((f) => f.endsWith('.test.ts'));
      const hasImplFile = files.some((f) => !f.endsWith('.test.ts') && f.endsWith('.ts'));
      if (hasTestFile && hasImplFile) {
        const implFiles = files.filter((f) => !f.endsWith('.test.ts') && f.endsWith('.ts'));
        // Check if any of those impl files are also claimed by a pure impl story
        for (const implFile of implFiles) {
          const otherOwners = implStories
            .filter((other) => other.id !== s.id)
            .filter((other) => (other.technicalNotes?.files ?? []).includes(implFile as never));
          if (otherOwners.length > 0) {
            conflicts.push(`${s.id} (test story) claims ${implFile} also owned by: ${otherOwners.map((o) => o.id).join(', ')}`);
          }
        }
      }
    }
    if (conflicts.length > 0) {
      throw new Error(`Test story claiming impl file owned by another story:\n  ${conflicts.join('\n  ')}`);
    }
    expect(conflicts).toHaveLength(0);
  });

  it('all stories have a non-empty id', () => {
    const bad = prd.stories.filter((s) => !s.id || typeof s.id !== 'string');
    expect(bad).toHaveLength(0);
  });

  it('all active stories start as pending before a run (no leftover completed/failed status)', () => {
    const nonPending = prd.stories.filter(
      (s) => activeIds.has(s.id) && s.status && s.status !== 'pending'
    );
    if (nonPending.length > 0) {
      const summary = nonPending.map((s) => `${s.id}:${s.status}`).join(', ');
      throw new Error(
        `${nonPending.length} story/stories not in pending state — run reset before launching: ${summary}`
      );
    }
    expect(nonPending).toHaveLength(0);
  });
});
