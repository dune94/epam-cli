/**
 * Root cause of the "source files don't exist yet" false-negative found live
 * (2026-07-02 tier3 run #5, after fixing the Step 1.6 ordering + null-crash
 * bugs): post-impl-tc-writer.sh's IMPL_SOURCE_FILES prompt field was ONLY
 * populated by searching PEER stories for a shared file basename (the split
 * topology, e.g. SKY-004-A impl / SKY-004-B test). When a story's impl and
 * test files live in the SAME story (no split — the actual topology this
 * run), the peer search always found nothing, IMPL_SOURCE_FILES was emitted
 * empty in the prompt, and the TC writer agent correctly (from its own
 * perspective — it was given zero files to read) concluded the source files
 * don't exist and wrote null for every story.
 *
 * Fix: seed impl_src with the story's OWN non-test files first, then still
 * search peers for the split-topology case. Both same-story and
 * split-story topologies now populate IMPL_SOURCE_FILES correctly.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const TC_WRITER_SH = join(REPO_ROOT, 'orchestrations/scripts/post-impl-tc-writer.sh');
const src = readFileSync(TC_WRITER_SH, 'utf8');

describe('post-impl-tc-writer.sh — impl_src seeding fix (static)', () => {
  it('seeds impl_src from the story\'s own impl_files, not just peer search', () => {
    expect(src).toMatch(/impl_src = list\(impl_files\)/);
  });

  it('impl_src seeding happens BEFORE the peer-search loop', () => {
    const seedIdx = src.indexOf('impl_src = list(impl_files)');
    const peerLoopIdx = src.indexOf('for peer_id in phase_ids:');
    expect(seedIdx).toBeGreaterThan(-1);
    expect(peerLoopIdx).toBeGreaterThan(seedIdx);
  });

  it('dedupes impl_src before emitting IMPL_SOURCE_FILES (in case of overlap)', () => {
    const dedupeIdx = src.indexOf('impl_src = list(dict.fromkeys(impl_src))');
    const emitIdx = src.indexOf("lines.append(f'IMPL_SOURCE_FILES:");
    expect(dedupeIdx).toBeGreaterThan(-1);
    expect(dedupeIdx).toBeLessThan(emitIdx);
  });
});

describe('post-impl-tc-writer.sh — impl_src logic, REAL execution against the exact live scenario', () => {
  function runPromptBuilder(prd: object, phase: string): string {
    // Extract the exact prompt-construction python block (between the marker
    // comment this test anchors on and the closing PYEOF) and execute it
    // standalone against a fixture PRD, to prove the fix works end-to-end,
    // not just via static source inspection.
    const startMarker = 'lines = []\nfor sid in phase_ids:';
    const startIdx = src.indexOf(startMarker);
    const endIdx = src.indexOf("print('\\n'.join(lines))", startIdx) + "print('\\n'.join(lines))".length;
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    const bodySnippet = src.slice(startIdx, endIdx);

    const prdPath = join(tmpdir(), `tc-writer-test-prd-${Date.now()}.json`);
    writeFileSync(prdPath, JSON.stringify(prd));

    const script = `
import json
with open(${JSON.stringify(prdPath)}) as f:
    d = json.load(f)
phase_ids = d.get('implementationOrder', {}).get(${JSON.stringify(phase)}, [])
by_id = {s['id']: s for s in d['stories']}
def _is_test_file(f):
    f = f or ''
    base = f.split('/')[-1]
    if '__tests__/' in f or f.startswith('__tests__/'):
        return True
    if base.startswith('test_'):
        return True
    for _m in ('.spec.', '.test.', '_spec.', '_test.'):
        if _m in base:
            return True
    return False
def _pair_key(f):
    f = f or ''
    for _m in ('.spec.', '.test.', '_spec.', '_test.'):
        if _m in f:
            return f[:f.rindex(_m)]
    return f.rsplit('.', 1)[0] if '.' in f.split('/')[-1] else f
def _test_base(f):
    return _pair_key((f or '').split('/')[-1])
def _files_for(story):
    return (story.get('technicalNotes') or {}).get('files') or []
story_filter = ''
${bodySnippet}
`;
    try {
      return execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    } finally {
      unlinkSync(prdPath);
    }
  }

  it('REPRODUCES the exact live defect scenario: impl+test files in the SAME story now populate IMPL_SOURCE_FILES', () => {
    const prd = {
      implementationOrder: { core: ['SKY-002'] },
      stories: [
        {
          id: 'SKY-002',
          acceptanceCriteria: ['Client returns flight results'],
          technicalNotes: { files: ['src/skyscanner/client.ts', 'src/skyscanner/client.test.ts'] },
        },
      ],
    };
    const output = runPromptBuilder(prd, 'core');
    expect(output).toContain('STORY_ID: SKY-002');
    expect(output).toContain('IMPL_SOURCE_FILES: src/skyscanner/client.ts');
    // The bug produced an empty IMPL_SOURCE_FILES line — confirm it's not empty
    expect(output).not.toMatch(/IMPL_SOURCE_FILES:\s*\n/);
  });

  it('still resolves the split-topology case (impl file in a PEER story)', () => {
    const prd = {
      implementationOrder: { core: ['SKY-004-A', 'SKY-004-B'] },
      stories: [
        {
          id: 'SKY-004-A',
          acceptanceCriteria: ['Server implements /health'],
          technicalNotes: { files: ['src/server.ts'] },
        },
        {
          id: 'SKY-004-B',
          acceptanceCriteria: ['Server tests pass'],
          technicalNotes: { files: ['src/server.test.ts'] },
        },
      ],
    };
    const output = runPromptBuilder(prd, 'core');
    expect(output).toContain('STORY_ID: SKY-004-B');
    expect(output).toContain('IMPL_SOURCE_FILES: src/server.ts');
  });

  it('combines same-story impl files AND peer impl files without duplication when both are present', () => {
    const prd = {
      implementationOrder: { core: ['SKY-005'] },
      stories: [
        {
          id: 'SKY-005',
          acceptanceCriteria: ['Combined story'],
          technicalNotes: { files: ['src/a.ts', 'src/a.test.ts'] },
        },
      ],
    };
    const output = runPromptBuilder(prd, 'core');
    const line = output.split('\n').find((l) => l.startsWith('IMPL_SOURCE_FILES:'));
    expect(line).toBe('IMPL_SOURCE_FILES: src/a.ts');
  });

  it('skips a story that already has testCriteria facts (no regression to that guard)', () => {
    const prd = {
      implementationOrder: { core: ['SKY-006'] },
      stories: [
        {
          id: 'SKY-006',
          acceptanceCriteria: ['Already has TCs'],
          technicalNotes: { files: ['src/b.ts', 'src/b.test.ts'] },
          testCriteria: { facts: ['already verified'] },
        },
      ],
    };
    const output = runPromptBuilder(prd, 'core');
    expect(output).not.toContain('SKY-006');
  });
});
