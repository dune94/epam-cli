/**
 * post-impl-tc-writer.sh --story scoping — real end-to-end execution tests.
 *
 * Root cause this fixes (found live, 2026-07-08, tier3-travel-app run): the
 * NEW inline TC-writer call site added to run-agent-orchestration.sh's Step 1
 * loop (see npm-test-fallback-scope.test.ts's sibling fix,
 * tc-writer-gate.test.ts's "inline TC writer check" tests) invokes this
 * script right before ONE specific story runs. Without scoping, the script
 * processes EVERY test story in the phase's implementationOrder — including
 * ones whose impl hasn't run yet. The agent correctly refuses to fabricate
 * facts for a story whose source file doesn't exist and writes `null` for
 * it, but the script's final "still missing TCs" check iterated over the
 * WHOLE phase and treated that unrelated, legitimately-null story as a hard
 * gate failure — aborting the entire phase even though the ONE story the
 * caller actually needed (e.g. SKY-002-test) got its TCs written fine.
 *
 * Live symptom: "Inline TC writer gate FAILED for SKY-002-test — cannot
 * proceed" while the actual tc-writer-core.log showed SKY-002-test was never
 * even mentioned — only an unrelated SKY-003-test (impl not yet run) was.
 *
 * Fix: --story <id> scopes all three of the script's phase-iteration points
 * (the "needs TC" query, the prompt's STORY_CONTEXT builder, and the final
 * "still missing" validation) down to just that one story. Peer-file lookup
 * (for split-topology impl/test pairs) still searches the FULL phase list,
 * since a test story's paired impl can be a sibling ID.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const TC_WRITER_SH = join(REPO_ROOT, 'orchestrations/scripts/post-impl-tc-writer.sh');
const LOGS_DIR = join(REPO_ROOT, 'orchestrations/logs');

describe('post-impl-tc-writer.sh — --story flag wiring (static)', () => {
  const src = readFileSync(TC_WRITER_SH, 'utf8');

  it('accepts a --story argument', () => {
    expect(src).toMatch(/--story\)\s*STORY="\$2";/);
  });

  it('the "needs TC" query loop is filtered by story_filter when set', () => {
    const idx = src.indexOf('# ── Find test stories in this phase that need TCs');
    const block = src.slice(idx, idx + 1400);
    expect(block).toMatch(/story_filter = '\$STORY'/);
    expect(block).toMatch(/if story_filter and sid != story_filter:/);
  });

  it('the STORY_CONTEXT builder loop is filtered by story_filter when set', () => {
    const idx = src.indexOf('# Build story context for the prompt');
    const block = src.slice(idx, idx + 1200);
    expect(block).toMatch(/story_filter = '\$STORY'/);
    expect(block).toMatch(/if story_filter and sid != story_filter:/);
  });

  it('the final "still missing TCs" validation is scoped to --story when set, not the whole phase', () => {
    const idx = src.indexOf('# Verify all needed stories got TCs');
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/check_ids = \[story_filter\] if story_filter else phase_ids/);
    expect(block).toMatch(/for sid in check_ids:/);
  });
});

describe('inline TC writer gate (shared lib) — call passes --story', () => {
  it('run_inline_tc_writer_gate scopes post-impl-tc-writer.sh to --story "$story_id"', () => {
    const gateSrc = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/lib/tc-writer-gate.sh'), 'utf8');
    const tcIdx = gateSrc.indexOf('post-impl-tc-writer.sh');
    const block = gateSrc.slice(tcIdx, tcIdx + 600);
    expect(block).toMatch(/--story "\$story_id"/);
  });

  it('every lane (main-branch Step 1, worktree Step 3a/3b) calls the same shared gate function', () => {
    const orchSrc = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
    const claudeSrc = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    expect(orchSrc).toContain('run_inline_tc_writer_gate "$story" "$PHASE"');
    expect(claudeSrc).toContain('run_inline_tc_writer_gate "$story_id" "$_wt_tc_phase"');
  });
});

describe('post-impl-tc-writer.sh — REAL execution, reproduces the exact live bug and proves the fix', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths.splice(0)) {
      rmSync(p, { force: true });
    }
  });

  // TC_OUT_FILE and LOG_FILE are both computed by the real script as
  // ${SCRIPT_DIR}/../logs/tc-${PHASE}.json — a REPO-relative path, not
  // relative to the temp OUTPUT_DIR. Use a unique phase name per test so
  // nothing collides with real logs, and always clean those two files up.
  function uniquePhase(label: string): string {
    return `test-tcscope-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  function setupProject(phase: string, tcResponses: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), 'tc-writer-story-scope-'));
    const prdPath = join(dir, 'prd.json');

    const prd = {
      implementationOrder: {
        [phase]: ['STORY-READY-impl', 'STORY-READY-test', 'STORY-NOTREADY-test'],
      },
      stories: [
        {
          id: 'STORY-READY-impl',
          status: 'completed',
          completed: true,
          technicalNotes: { files: ['src/ready.ts'] },
        },
        {
          id: 'STORY-READY-test',
          status: 'pending',
          technicalNotes: { files: ['src/ready.test.ts'] },
          acceptanceCriteria: ['ready story works'],
        },
        {
          id: 'STORY-NOTREADY-test',
          status: 'pending',
          technicalNotes: { files: ['src/notready.test.ts'] },
          acceptanceCriteria: ['not-ready story works'],
        },
      ],
    };
    writeFileSync(prdPath, JSON.stringify(prd, null, 2));

    const tcOutFile = join(LOGS_DIR, `tc-${phase}.json`);
    const tcLogFile = join(LOGS_DIR, `tc-writer-${phase}.log`);
    cleanupPaths.push(tcOutFile, tcLogFile);

    // Stub `epam` binary: ignores its actual args/prompt entirely (this test
    // is about the shell-level --story scoping, not agent prompting) and
    // just writes the fixed response the test wants, mimicking exactly what
    // a real agent does — including correctly writing `null` for a story
    // whose source file doesn't exist, per its own protocol.
    const stubPath = join(dir, 'epam-stub.sh');
    writeFileSync(
      stubPath,
      [
        '#!/usr/bin/env bash',
        `mkdir -p "${LOGS_DIR}"`,
        `cat > "${tcOutFile}" << 'STUBEOF'`,
        JSON.stringify(tcResponses),
        'STUBEOF',
        'echo TC_WRITER_DONE',
        'exit 0',
      ].join('\n')
    );
    chmodSync(stubPath, 0o755);

    return { dir, prdPath, stubPath, tcOutFile, tcLogFile };
  }

  it('REPRODUCES the exact live bug: without --story, an unrelated not-ready test story fails the WHOLE gate', () => {
    const phase = uniquePhase('bug');
    const { dir, prdPath, stubPath } = setupProject(phase, {
      'STORY-READY-test': {
        verifiedAt: new Date().toISOString(),
        sourceFiles: ['src/ready.ts'],
        facts: ['ready fact'],
        mockStrategy: 'vi.mock(...)',
        bannedPatterns: [],
      },
      'STORY-NOTREADY-test': null, // agent correctly refuses to fabricate
    });

    let exitCode = 0;
    try {
      execFileSync('bash', [
        TC_WRITER_SH,
        '--prd', prdPath,
        '--phase', phase,
        '--output-dir', dir,
      ], {
        encoding: 'utf8',
        env: { ...process.env, EPAM_BIN: stubPath },
      });
    } catch (e: any) {
      exitCode = e.status ?? -1;
    }

    // Bug reproduced: the whole gate fails because of the unrelated story.
    expect(exitCode).not.toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('FIX: with --story STORY-READY-test, the gate passes and applies TCs, ignoring the not-ready story', () => {
    const phase = uniquePhase('fixed');
    const { dir, prdPath, stubPath } = setupProject(phase, {
      'STORY-READY-test': {
        verifiedAt: new Date().toISOString(),
        sourceFiles: ['src/ready.ts'],
        facts: ['ready fact'],
        mockStrategy: 'vi.mock(...)',
        bannedPatterns: [],
      },
      // The stub still might emit this if the prompt happened to ask about
      // it, but with --story scoping the STORY_CONTEXT should only ever
      // request STORY-READY-test — this key existing in the stub response
      // and being harmlessly ignored proves the final check is scoped too.
      'STORY-NOTREADY-test': null,
    });

    let exitCode = -1;
    let stdout = '';
    try {
      stdout = execFileSync('bash', [
        TC_WRITER_SH,
        '--prd', prdPath,
        '--phase', phase,
        '--output-dir', dir,
        '--story', 'STORY-READY-test',
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
    expect(stdout).toMatch(/Gate PASSED/);

    const updatedPrd = JSON.parse(readFileSync(prdPath, 'utf8'));
    const readyStory = updatedPrd.stories.find((s: any) => s.id === 'STORY-READY-test');
    const notReadyStory = updatedPrd.stories.find((s: any) => s.id === 'STORY-NOTREADY-test');
    expect(readyStory.testCriteria?.facts).toEqual(['ready fact']);
    // The not-ready story must NOT have been touched or treated as a failure.
    expect(notReadyStory.testCriteria).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it('--story scoping only counts/lists the requested story as needing TCs, not the other test story', () => {
    const phase = uniquePhase('promptscope');
    const { dir, prdPath, stubPath } = setupProject(phase, {
      'STORY-READY-test': {
        verifiedAt: new Date().toISOString(),
        sourceFiles: ['src/ready.ts'],
        facts: ['ready fact'],
        mockStrategy: 'vi.mock(...)',
        bannedPatterns: [],
      },
    });

    const stdout = execFileSync('bash', [
      TC_WRITER_SH,
      '--prd', prdPath,
      '--phase', phase,
      '--output-dir', dir,
      '--story', 'STORY-READY-test',
    ], {
      encoding: 'utf8',
      env: { ...process.env, EPAM_BIN: stubPath },
    });

    // The "Phase 'x': N test story/stories need TCs" summary (and the
    // per-story listing under it) is printed directly to stdout before the
    // stub is invoked — must list only the requested story.
    expect(stdout).toMatch(/1 test story\/stories need TCs/);
    expect(stdout).toMatch(/- STORY-READY-test/);
    expect(stdout).not.toMatch(/STORY-NOTREADY-test/);

    rmSync(dir, { recursive: true, force: true });
  });
});
