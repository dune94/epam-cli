/**
 * post-impl-tc-writer.sh --story <id> when the target story is (transiently)
 * absent from implementationOrder[phase].
 *
 * Root cause this fixes (found live, 2026-07-09, tier3-travel-app run):
 * run-agent-orchestration.sh's inline TC-writer gate (Step 1 loop) computes
 * "does $story need a TC" via a direct jq query against `.stories[]` — it
 * does NOT depend on implementationOrder. But post-impl-tc-writer.sh's OWN
 * internal queries (the "needs TC" filter, the STORY_CONTEXT builder, and
 * the final apply/validate block) all iterate
 * `phase_ids = implementationOrder[phase]` and silently exclude the
 * `--story`-targeted story whenever it isn't (yet) present there — e.g.
 * right after a mid-execution split, before implementationOrder has caught
 * up. The caller then logged "success" from the exit code alone (fixed
 * separately in run-agent-orchestration.sh — see the post-condition check
 * added right after the inline call).
 *
 * Live symptom: "Story SKY-003-test needs testCriteria — running TC writer
 * inline before it starts..." immediately followed by "[tc-writer] No test
 * stories need TCs in phase 'core' — skipping" and then a false
 * "SUCCESS TC writer populated testCriteria for SKY-003-test" — the PRD
 * confirms SKY-003-test never actually got a testCriteria field at all.
 *
 * Fix: all three phase_ids computations force-include the requested
 * `--story` target even when implementationOrder[phase] doesn't (yet)
 * contain it. Peer-file discovery is unaffected — it still iterates the
 * original implementationOrder-derived list.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const TC_WRITER_SH = join(REPO_ROOT, 'orchestrations/scripts/post-impl-tc-writer.sh');
const LOGS_DIR = join(REPO_ROOT, 'orchestrations/logs');

describe('post-impl-tc-writer.sh — target-story inclusion guard (static)', () => {
  const src = readFileSync(TC_WRITER_SH, 'utf8');

  it('the "needs TC" query force-includes the --story target when absent from implementationOrder[phase]', () => {
    const idx = src.indexOf('# ── Find test stories in this phase that need TCs');
    const block = src.slice(idx, idx + 1400);
    expect(block).toMatch(/if story_filter and story_filter not in phase_ids:/);
    expect(block).toMatch(/phase_ids = phase_ids \+ \[story_filter\]/);
  });

  it('the STORY_CONTEXT builder force-includes the --story target', () => {
    const idx = src.indexOf('# Build story context for the prompt');
    const block = src.slice(idx, idx + 1000);
    expect(block).toMatch(/if story_filter and story_filter not in phase_ids:/);
  });

  it('the final apply/validate block force-includes the --story target into the gating set, without changing peer-file discovery', () => {
    const idx = src.indexOf("phase_ids_list = prd.get('implementationOrder', {}).get(phase, [])");
    const block = src.slice(idx, idx + 600);
    expect(block).toMatch(/phase_ids = set\(phase_ids_list\)/);
    expect(block).toMatch(/if story_filter and story_filter not in phase_ids:/);
    expect(block).toMatch(/phase_ids = phase_ids \| \{story_filter\}/);
    // peer_ids_for must still iterate the ORIGINAL phase_ids_list, unaffected
    const peerIdx = src.indexOf('def peer_ids_for');
    const peerBlock = src.slice(peerIdx, peerIdx + 500);
    expect(peerBlock).toMatch(/for peer_id in phase_ids_list:/);
  });
});

describe('post-impl-tc-writer.sh — REAL execution, reproduces the exact live defect and proves the fix', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths.splice(0)) {
      rmSync(p, { force: true });
    }
  });

  function uniquePhase(label: string): string {
    return `test-tcnotinorder-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  function setupProject(phase: string, includeTargetInImplOrder: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'tc-writer-not-in-order-'));
    const prdPath = join(dir, 'prd.json');

    // SKY-003-test exists as a real, structurally-qualifying story (has a
    // .test.ts file, no existing facts) but — reproducing the live mid-
    // execution-split timing gap — is absent from implementationOrder[phase]
    // when includeTargetInImplOrder is false.
    const prd = {
      implementationOrder: {
        [phase]: includeTargetInImplOrder ? ['SKY-003-impl', 'SKY-003-test'] : ['SKY-003-impl'],
      },
      stories: [
        {
          id: 'SKY-003-impl',
          status: 'completed',
          completed: true,
          technicalNotes: { files: ['src/cli.ts'] },
        },
        {
          id: 'SKY-003-test',
          status: 'pending',
          technicalNotes: { files: ['src/cli.test.ts'] },
          acceptanceCriteria: ['cli tests pass'],
        },
      ],
    };
    writeFileSync(prdPath, JSON.stringify(prd, null, 2));

    const tcOutFile = join(LOGS_DIR, `tc-${phase}.json`);
    const tcLogFile = join(LOGS_DIR, `tc-writer-${phase}.log`);
    cleanupPaths.push(tcOutFile, tcLogFile);

    const stubPath = join(dir, 'epam-stub.sh');
    writeFileSync(
      stubPath,
      [
        '#!/usr/bin/env bash',
        `mkdir -p "${LOGS_DIR}"`,
        `cat > "${tcOutFile}" << 'STUBEOF'`,
        JSON.stringify({
          'SKY-003-test': {
            verifiedAt: new Date().toISOString(),
            sourceFiles: ['src/cli.ts'],
            facts: ['cli validates args before checking RAPIDAPI_KEY'],
            mockStrategy: 'vi.mock(...)',
            bannedPatterns: [],
          },
        }),
        'STUBEOF',
        'echo TC_WRITER_DONE',
        'exit 0',
      ].join('\n')
    );
    chmodSync(stubPath, 0o755);

    return { dir, prdPath, stubPath };
  }

  it('BEFORE understanding the defect: confirms the target story genuinely qualifies (sanity check on the fixture itself)', () => {
    const phase = uniquePhase('sanity');
    const { dir, prdPath } = setupProject(phase, true);
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    const story = prd.stories.find((s: any) => s.id === 'SKY-003-test');
    expect(story.technicalNotes.files[0]).toMatch(/\.test\.ts$/);
    expect(story.testCriteria).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('with the target story ABSENT from implementationOrder[phase], --story still gets it populated with testCriteria.facts (the fix)', () => {
    const phase = uniquePhase('fixed');
    const { dir, prdPath, stubPath } = setupProject(phase, false);

    let exitCode = -1;
    let stdout = '';
    try {
      stdout = execFileSync('bash', [
        TC_WRITER_SH,
        '--prd', prdPath,
        '--phase', phase,
        '--output-dir', dir,
        '--story', 'SKY-003-test',
      ], {
        encoding: 'utf8',
        env: { ...process.env, EPAM_BIN: stubPath },
      });
      exitCode = 0;
    } catch (e: any) {
      stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
      exitCode = e.status ?? -1;
    }

    expect(exitCode).toBe(0);
    // Before the fix, this printed "No test stories need TCs ... — skipping"
    // and the story was never actually populated.
    expect(stdout).not.toMatch(/No test stories need TCs/);

    const updatedPrd = JSON.parse(readFileSync(prdPath, 'utf8'));
    const story = updatedPrd.stories.find((s: any) => s.id === 'SKY-003-test');
    expect(story.testCriteria?.facts).toEqual(['cli validates args before checking RAPIDAPI_KEY']);

    rmSync(dir, { recursive: true, force: true });
  });

  it('with the target story present in implementationOrder[phase] (normal case), behavior is unchanged', () => {
    const phase = uniquePhase('normal');
    const { dir, prdPath, stubPath } = setupProject(phase, true);

    const stdout = execFileSync('bash', [
      TC_WRITER_SH,
      '--prd', prdPath,
      '--phase', phase,
      '--output-dir', dir,
      '--story', 'SKY-003-test',
    ], {
      encoding: 'utf8',
      env: { ...process.env, EPAM_BIN: stubPath },
    });

    expect(stdout).toMatch(/1 test story\/stories need TCs/);
    const updatedPrd = JSON.parse(readFileSync(prdPath, 'utf8'));
    const story = updatedPrd.stories.find((s: any) => s.id === 'SKY-003-test');
    expect(story.testCriteria?.facts).toEqual(['cli validates args before checking RAPIDAPI_KEY']);

    rmSync(dir, { recursive: true, force: true });
  });
});
