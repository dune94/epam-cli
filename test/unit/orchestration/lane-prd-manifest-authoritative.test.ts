/**
 * A lane's PRD must carry that lane's RESOLVED manifest — not the declared one.
 *
 * THE DEFECT. buildPerCodelineManifest() already resolves every declared path against
 * each codeline's real checkout and stores the result in
 * technicalNotes.perCodeline.<lane>.files. But the flat technicalNotes.files keeps the
 * DECLARED spelling, and _filtered_prd() copies the story into each lane's PRD verbatim.
 * So every consumer downstream — writer, reviewer, gates, TC writer, failure analyst —
 * reads a manifest naming a file that may not exist, while a corrected one sits beside it.
 *
 * Live 2026-08-04 that produced two spellings of one file in the writer prompt
 * (ContentstackContext.tsx vs contentstackContext.tsx, 9 references each). The writer
 * assumed two files, created the phantom, deleted it, declared the real one out of scope,
 * and every retry then failed tsc on fields its own edits required: 120 iterations,
 * ~2M input tokens, 4 writes.
 *
 * The first fix for that rewrote paths at PROMPT-RENDER time. That was a hack: it
 * corrected the one reader being looked at and left the bad data in the PRD for everyone
 * else — including the reviewer, which is then asked to review a manifest it cannot
 * verify. The correction belongs where the lane's PRD is BUILT, once, so there is a
 * single source of truth.
 *
 * GENERIC: no project, codeline, vendor or real filename appears here. The rule is
 * structural — a lane's manifest names files that lane actually has.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH, 'utf8');
const NODE = process.execPath;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Extract the real _filtered_prd body and run it. */
function runFilteredPrd(prd: unknown, lane: string) {
  const i = orchSrc.indexOf('  _filtered_prd() {');
  expect(i, '_filtered_prd() not found').toBeGreaterThan(-1);
  const lines = orchSrc.slice(i).split('\n');
  const end = lines.findIndex((l, k) => k > 0 && l === '  }');
  const body = lines.slice(0, end + 1).join('\n').replace(/^ {2}/gm, '');

  const dir = mkdtempSync(join(tmpdir(), 'lane-prd-'));
  dirs.push(dir);
  const src = join(dir, 'src.json');
  const out = join(dir, 'out.json');
  writeFileSync(src, JSON.stringify(prd));

  const script = join(dir, 'probe.sh');
  writeFileSync(
    script,
    ['#!/usr/bin/env bash', 'set -uo pipefail', `NODE_BIN=${JSON.stringify(NODE)}`, body,
      `_filtered_prd ${JSON.stringify(lane)} ${JSON.stringify(out)} ${JSON.stringify(src)}`].join('\n'),
  );
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
  expect(r.status, `_filtered_prd failed: ${r.stdout}${r.stderr}`).toBe(0);
  return JSON.parse(readFileSync(out, 'utf8'));
}

/** One story, three lanes, each resolving the same declared file to its own real name. */
const LANES = ['alpha', 'beta', 'gamma'] as const;
function spanningPrd() {
  return {
    project: {
      outputDirs: LANES.map((l) => ({ codeline: l, path: `/repos/${l}` })),
    },
    stories: [
      {
        id: 'ST-1',
        title: 'spanning',
        codelines: [...LANES],
        technicalNotes: {
          // DECLARED — matches none of the lanes exactly.
          files: ['src/Thing.tsx', 'src/shared.ts'],
          perCodeline: {
            alpha: { files: ['src/thing.tsx', 'src/shared.ts'], resolved: [], unresolved: [] },
            beta: { files: ['src/Thing.ts', 'src/shared.ts'], resolved: [], unresolved: [] },
            gamma: { files: ['src/thingy.tsx', 'src/shared.ts'], resolved: [], unresolved: [] },
          },
        },
      },
    ],
  };
}

describe("a lane's PRD carries that lane's resolved manifest", () => {
  it('REPRODUCES THE DEFECT: technicalNotes.files holds the LANE spelling, not the declared one', () => {
    const out = runFilteredPrd(spanningPrd(), 'alpha');
    expect(
      out.stories[0].technicalNotes.files,
      "the lane's PRD kept the declared manifest, so every downstream consumer — writer, " +
        'reviewer, gates — reads a path this lane may not have',
    ).toEqual(['src/thing.tsx', 'src/shared.ts']);
  });

  it('each lane gets ITS OWN resolved list', () => {
    expect(runFilteredPrd(spanningPrd(), 'beta').stories[0].technicalNotes.files)
      .toEqual(['src/Thing.ts', 'src/shared.ts']);
    expect(runFilteredPrd(spanningPrd(), 'gamma').stories[0].technicalNotes.files)
      .toEqual(['src/thingy.tsx', 'src/shared.ts']);
  });

  it('the DECLARED spelling is gone from the lane PRD entirely — one source of truth', () => {
    const raw = JSON.stringify(runFilteredPrd(spanningPrd(), 'alpha'));
    expect(
      raw.includes('src/Thing.tsx'),
      'the declared name survives somewhere in the lane PRD; a consumer reading it still ' +
        'sees a second, wrong spelling',
    ).toBe(false);
  });

  it('a story with NO perCodeline entry is left untouched (single-codeline runs)', () => {
    const prd = {
      project: { outputDirs: [{ codeline: 'alpha', path: '/repos/alpha' }] },
      stories: [{ id: 'ST-1', codeline: 'alpha', technicalNotes: { files: ['src/plain.ts'] } }],
    };
    expect(runFilteredPrd(prd, 'alpha').stories[0].technicalNotes.files).toEqual(['src/plain.ts']);
  });

  it('a lane missing from perCodeline keeps the declared list rather than emptying it', () => {
    const prd = spanningPrd();
    delete (prd.stories[0].technicalNotes.perCodeline as Record<string, unknown>).gamma;
    expect(
      runFilteredPrd(prd, 'gamma').stories[0].technicalNotes.files,
      'a missing lane entry silently blanked the manifest — the writer would be told to ' +
        'change nothing',
    ).toEqual(['src/Thing.tsx', 'src/shared.ts']);
  });

  it('still filters stories by codeline — existing behaviour intact', () => {
    const prd = {
      project: { outputDirs: LANES.map((l) => ({ codeline: l, path: `/repos/${l}` })) },
      stories: [
        { id: 'A', codeline: 'alpha', technicalNotes: { files: ['a.ts'] } },
        { id: 'B', codeline: 'beta', technicalNotes: { files: ['b.ts'] } },
      ],
    };
    const out = runFilteredPrd(prd, 'alpha');
    expect(out.stories.map((s: { id: string }) => s.id)).toEqual(['A']);
  });
});
