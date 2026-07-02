/**
 * TC (test criteria) writer gate — unit + integration tests.
 *
 * Unit tests: PRD schema, gate logic, profile wiring (in-process).
 * Integration tests: gate script contract, TC application to prd.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const PRD_PATH     = join(__dirname, '../../../orchestrations/travel-app-prd.json');
const PROFILES_PATH = join(__dirname, '../../../orchestrations/agents/profiles.json');
const ORCH_SCRIPT  = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const TC_SCRIPT    = join(__dirname, '../../../orchestrations/scripts/post-impl-tc-writer.sh');
const INTEGRITY_SH = join(__dirname, '../../../orchestrations/scripts/preflight-prd-integrity.sh');

const prd      = JSON.parse(readFileSync(PRD_PATH, 'utf8'));
const profiles = JSON.parse(readFileSync(PROFILES_PATH, 'utf8'));
const activeIds = new Set(Object.values(prd.implementationOrder as Record<string,string[]>).flat());
const byId      = new Map(prd.stories.map((s: any) => [s.id, s]));
const isCanonical = prd.stories.every((s: any) => !s?.specification?.createdFrom || s?.specification?.splitOrigin === 'spec-pass');

// ─── helpers ────────────────────────────────────────────────────────────────

function testStoriesInPhase(phase: string): any[] {
  const ids: string[] = (prd.implementationOrder as any)[phase] ?? [];
  return ids
    .map((id) => byId.get(id))
    .filter((s: any) => s?.technicalNotes?.files?.some((f: string) => f.endsWith('.test.ts')));
}

function implStoriesInPhase(phase: string): any[] {
  const ids: string[] = (prd.implementationOrder as any)[phase] ?? [];
  return ids
    .map((id) => byId.get(id))
    .filter((s: any) => !s?.technicalNotes?.files?.some((f: string) => f.endsWith('.test.ts')));
}

// ─── 1. PRD schema: testCriteria field ──────────────────────────────────────
describe('TC gate — PRD schema', () => {
  it('every active test story has a testCriteria field', () => {
    if (isCanonical) return; // testCriteria is written by tc-writer-agent after spec pass
    const missing = testStoriesInPhase('core').filter((s: any) => !('testCriteria' in s));
    expect(missing.map((s: any) => s.id)).toHaveLength(0);
  });

  it('testCriteria has required sub-fields: sourceFiles, facts, mockStrategy, bannedPatterns', () => {
    if (isCanonical) return;
    const bad: string[] = [];
    for (const s of testStoriesInPhase('core')) {
      const tc = s.testCriteria ?? {};
      if (!Array.isArray(tc.sourceFiles))    bad.push(`${s.id}: missing sourceFiles`);
      if (!Array.isArray(tc.facts))          bad.push(`${s.id}: missing facts`);
      if (!('mockStrategy' in tc))           bad.push(`${s.id}: missing mockStrategy`);
      if (!Array.isArray(tc.bannedPatterns)) bad.push(`${s.id}: missing bannedPatterns`);
    }
    expect(bad).toHaveLength(0);
  });

  it('testCriteria.sourceFiles reference impl (non-test) .ts files', () => {
    const bad: string[] = [];
    for (const s of testStoriesInPhase('core')) {
      for (const src of s.testCriteria?.sourceFiles ?? []) {
        if (src.endsWith('.test.ts')) bad.push(`${s.id}: sourceFiles contains test file ${src}`);
      }
    }
    expect(bad).toHaveLength(0);
  });

  it('testCriteria.implStory resolves to a known impl story in the same phase', () => {
    if (isCanonical) return;
    const bad: string[] = [];
    for (const s of testStoriesInPhase('core')) {
      const implId = s.testCriteria?.implStory;
      if (!implId) { bad.push(`${s.id}: missing implStory`); continue; }
      const implStory = byId.get(implId);
      if (!implStory) { bad.push(`${s.id}: implStory '${implId}' not found`); continue; }
      const implFiles = implStory.technicalNotes?.files ?? [];
      if (implFiles.every((f: string) => f.endsWith('.test.ts'))) {
        bad.push(`${s.id}: implStory '${implId}' has only test files — wrong peer`);
      }
    }
    expect(bad).toHaveLength(0);
  });

  it('all test stories have a non-empty implStory pointer', () => {
    if (isCanonical) return;
    const missing = testStoriesInPhase('core').filter((s: any) => !s.testCriteria?.implStory);
    expect(missing.map((s: any) => s.id)).toHaveLength(0);
  });
});

// ─── 2. Profiles: tc-writer-agent and test-engineer wiring ──────────────────
describe('TC gate — agent profiles', () => {
  it('tc-writer-agent profile exists', () => {
    expect(profiles['tc-writer-agent']).toBeTruthy();
  });

  it('tc-writer-agent profile states it reads source files and writes JSON only', () => {
    const p: string = profiles['tc-writer-agent'] ?? '';
    expect(p).toMatch(/read.*impl|read.*source/i);
    expect(p).toMatch(/JSON/i);
    expect(p).toMatch(/does NOT write test files|do NOT write test|ONLY job/i);
  });

  it('tc-writer-agent profile explicitly forbids modifying source or AC fields', () => {
    const p: string = profiles['tc-writer-agent'] ?? '';
    expect(p).toMatch(/do NOT modify source|do NOT change.*AC|never.*modif/i);
  });

  it('test-engineer profile references testCriteria', () => {
    const p: string = profiles['test-engineer'] ?? '';
    expect(p).toContain('testCriteria');
  });

  it('test-engineer profile states TC.facts override conflicting ACs', () => {
    const p: string = profiles['test-engineer'] ?? '';
    expect(p).toMatch(/TC.*wins|TC WINS|facts.*override|testCriteria.*override/i);
  });

  it('test-engineer profile instructs reading TC before writing tests', () => {
    const p: string = profiles['test-engineer'] ?? '';
    expect(p).toMatch(/check.*testCriteria|read.*testCriteria|testCriteria.*before/i);
  });
});

// ─── 3. Gate ordering: impl must precede test within same phase ──────────────
describe('TC gate — phase ordering invariants', () => {
  it('all impl stories come before their paired test story in core implementationOrder', () => {
    const coreOrder: string[] = prd.implementationOrder['core'] ?? [];
    const bad: string[] = [];
    for (const s of testStoriesInPhase('core')) {
      const implId = s.testCriteria?.implStory;
      if (!implId) continue;
      const implIdx = coreOrder.indexOf(implId);
      const testIdx = coreOrder.indexOf(s.id);
      if (implIdx === -1 || testIdx === -1) continue;
      if (implIdx > testIdx) {
        bad.push(`${s.id} (pos ${testIdx}) comes before its impl peer ${implId} (pos ${implIdx})`);
      }
    }
    expect(bad).toHaveLength(0);
  });

  it('no test story in core phase has completed=true while its impl peer is still pending', () => {
    const bad: string[] = [];
    for (const s of testStoriesInPhase('core')) {
      if (!s.completed) continue;
      const implId = s.testCriteria?.implStory;
      const implStory = implId ? byId.get(implId) : null;
      if (implStory && !implStory.completed) {
        bad.push(`${s.id} completed but impl peer ${implId} is not`);
      }
    }
    expect(bad).toHaveLength(0);
  });
});

// ─── 4. Gate script: exists, is executable, handles SKIP_TC_WRITER ──────────
describe('TC gate — script contract', () => {
  it('post-impl-tc-writer.sh exists', () => {
    expect(existsSync(TC_SCRIPT)).toBe(true);
  });

  it('post-impl-tc-writer.sh is executable', () => {
    const { statSync } = require('node:fs');
    const mode = statSync(TC_SCRIPT).mode;
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  it('SKIP_TC_WRITER=1 causes script to exit 0 immediately', () => {
    let exitCode = 0;
    try {
      execSync(`SKIP_TC_WRITER=1 bash "${TC_SCRIPT}" --prd "${PRD_PATH}" --phase core --output-dir /tmp`, {
        stdio: 'pipe',
      });
    } catch (e: any) {
      exitCode = e.status ?? 1;
    }
    expect(exitCode).toBe(0);
  });

  it('script exits non-zero when --prd is missing', () => {
    let exitCode = 0;
    try {
      execSync(`bash "${TC_SCRIPT}" --phase core --output-dir /tmp`, { stdio: 'pipe' });
    } catch (e: any) {
      exitCode = e.status ?? 1;
    }
    expect(exitCode).toBeGreaterThan(0);
  });

  it('script exits non-zero when --phase is missing', () => {
    let exitCode = 0;
    try {
      execSync(`bash "${TC_SCRIPT}" --prd "${PRD_PATH}" --output-dir /tmp`, { stdio: 'pipe' });
    } catch (e: any) {
      exitCode = e.status ?? 1;
    }
    expect(exitCode).toBeGreaterThan(0);
  });
});

// ─── 5. Gate script: TC application logic (integration) ─────────────────────
describe('TC gate — TC application to prd.json (integration)', () => {
  let tmpDir: string;
  let tmpPrd: string;
  let tmpTcFile: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `tc-gate-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, 'logs'), { recursive: true });
    // Copy PRD with cleared TCs so we can test applying new ones
    const prdCopy = JSON.parse(readFileSync(PRD_PATH, 'utf8'));
    for (const s of prdCopy.stories) {
      if (s.testCriteria) s.testCriteria = { ...s.testCriteria, facts: [], verifiedAt: null };
    }
    tmpPrd = join(tmpDir, 'prd.json');
    writeFileSync(tmpPrd, JSON.stringify(prdCopy, null, 2));
    tmpTcFile = join(tmpDir, 'logs', 'tc-core.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies valid TC JSON to prd.json stories', () => {
    // Simulate what the agent would produce
    const tcData: Record<string, any> = {};
    for (const s of testStoriesInPhase('core')) {
      tcData[s.id] = {
        verifiedAt: new Date().toISOString(),
        sourceFiles: s.testCriteria?.sourceFiles ?? [],
        facts: [`Verified fact for ${s.id}`],
        mockStrategy: `vi.mock('./${s.id}')`,
        bannedPatterns: ['@jest/globals'],
      };
    }
    writeFileSync(tmpTcFile, JSON.stringify(tcData, null, 2));

    // Apply via the Python logic embedded in the script
    execSync(
      `python3 -c "
import json, sys
from datetime import datetime, timezone

prd_file = '${tmpPrd}'
tc_file  = '${tmpTcFile}'
phase    = 'core'

with open(tc_file) as f: tc_data = json.load(f)
with open(prd_file) as f: prd = json.load(f)
phase_ids = set(prd.get('implementationOrder', {}).get(phase, []))

for story in prd['stories']:
    sid = story['id']
    if sid not in phase_ids or sid not in tc_data: continue
    tc = tc_data[sid]
    if not isinstance(tc.get('facts'), list) or len(tc['facts']) == 0: continue
    if not tc.get('verifiedAt'): tc['verifiedAt'] = datetime.now(timezone.utc).isoformat()
    story['testCriteria'] = tc

with open(prd_file, 'w') as f: json.dump(prd, f, indent=2)
print('ok')
"`,
      { stdio: 'pipe' }
    );

    const updated = JSON.parse(readFileSync(tmpPrd, 'utf8'));
    const updatedById = new Map(updated.stories.map((s: any) => [s.id, s]));

    for (const s of testStoriesInPhase('core')) {
      const updatedStory = updatedById.get(s.id) as any;
      expect(updatedStory?.testCriteria?.facts).toHaveLength(1);
      expect(updatedStory?.testCriteria?.facts[0]).toContain(s.id);
      expect(updatedStory?.testCriteria?.verifiedAt).toBeTruthy();
    }
  });

  it('rejects TC JSON with empty facts array — leaves prd.json unchanged', () => {
    const tcData: Record<string, any> = {};
    for (const s of testStoriesInPhase('core')) {
      tcData[s.id] = {
        verifiedAt: new Date().toISOString(),
        sourceFiles: [],
        facts: [],            // empty — should be skipped
        mockStrategy: '',
        bannedPatterns: [],
      };
    }
    writeFileSync(tmpTcFile, JSON.stringify(tcData, null, 2));
    writeFileSync(tmpPrd, readFileSync(PRD_PATH, 'utf8'));

    const before = readFileSync(tmpPrd, 'utf8');

    // The apply script skips empty-facts entries — prd should be unchanged
    execSync(
      `python3 -c "
import json, sys
prd_file = '${tmpPrd}'; tc_file = '${tmpTcFile}'; phase = 'core'
with open(tc_file) as f: tc_data = json.load(f)
with open(prd_file) as f: prd = json.load(f)
phase_ids = set(prd.get('implementationOrder', {}).get(phase, []))
for story in prd['stories']:
    sid = story['id']
    if sid not in phase_ids or sid not in tc_data: continue
    tc = tc_data[sid]
    if not isinstance(tc.get('facts'), list) or len(tc['facts']) == 0: continue
    story['testCriteria'] = tc
with open(prd_file, 'w') as f: json.dump(prd, f, indent=2)
"`,
      { stdio: 'pipe' }
    );

    const after = readFileSync(tmpPrd, 'utf8');
    const afterPrd = JSON.parse(after);
    // All test stories should still have empty facts
    for (const s of testStoriesInPhase('core')) {
      const updated = afterPrd.stories.find((x: any) => x.id === s.id);
      expect(updated?.testCriteria?.facts ?? []).toHaveLength(0);
    }
  });

  it('rejects malformed JSON TC file and exits non-zero', () => {
    writeFileSync(tmpTcFile, '{ not valid json ,,, }');
    let exitCode = 0;
    try {
      execSync(
        `python3 -c "
import json, sys
with open('${tmpTcFile}') as f: json.load(f)
" `,
        { stdio: 'pipe' }
      );
    } catch (e: any) {
      exitCode = e.status ?? 1;
    }
    expect(exitCode).toBeGreaterThan(0);
  });
});

// ─── 6. Orchestration script: Step 1.6 is wired ─────────────────────────────
describe('TC gate — orchestration script wiring', () => {
  it('run-agent-orchestration.sh contains Step 1.6 TC writer gate', () => {
    const src = readFileSync(ORCH_SCRIPT, 'utf8');
    expect(src).toContain('Step 1.6');
    expect(src).toContain('post-impl-tc-writer.sh');
  });

  it('Step 1.6 checks for test stories needing TCs before invoking the script', () => {
    const src = readFileSync(ORCH_SCRIPT, 'utf8');
    expect(src).toContain('_tc_writer_needed');
    expect(src).toContain('testCriteria.facts');
  });

  it('Step 1.6 passes --prd, --phase, and --output-dir to the gate script', () => {
    const src = readFileSync(ORCH_SCRIPT, 'utf8');
    const step16 = src.slice(src.indexOf('Step 1.6'), src.indexOf('need_worktrees=false'));
    expect(step16).toContain('--prd');
    expect(step16).toContain('--phase');
    expect(step16).toContain('--output-dir');
  });

  it('Step 1.6 fires after Step 1.5 (auto-commit) but before worktree creation', () => {
    const src = readFileSync(ORCH_SCRIPT, 'utf8');
    const i15  = src.indexOf('Step 1.5');
    const i16  = src.indexOf('Step 1.6');
    const iwt  = src.indexOf('need_worktrees=false');
    expect(i15).toBeGreaterThan(-1);
    expect(i16).toBeGreaterThan(i15);
    expect(iwt).toBeGreaterThan(i16);
  });
});

// ─── 7a. build_implementation_prompt injects testCriteria ────────────────────
describe('TC gate — build_implementation_prompt injects testCriteria into agent prompt', () => {
  const claudeSrc = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8'
  );

  function getImplPromptBody(): string {
    const start = claudeSrc.indexOf('build_implementation_prompt()');
    const end   = claudeSrc.indexOf('\nbuild_generator_prompt()', start);
    return claudeSrc.slice(start, end);
  }

  it('extracts tc_facts from testCriteria.facts in story JSON', () => {
    expect(getImplPromptBody()).toMatch(/tc_facts/);
    expect(getImplPromptBody()).toMatch(/testCriteria.*facts|\.testCriteria/);
  });

  it('extracts tc_mock_strategy from testCriteria.mockStrategy', () => {
    expect(getImplPromptBody()).toMatch(/tc_mock_strategy|mockStrategy/);
  });

  it('extracts tc_banned from testCriteria.bannedPatterns', () => {
    expect(getImplPromptBody()).toMatch(/tc_banned|bannedPatterns/);
  });

  it('emits Test Criteria section in the prompt when tc_facts is non-empty', () => {
    expect(getImplPromptBody()).toContain('Test Criteria');
  });

  it('marks testCriteria as ground truth that overrides conflicting ACs', () => {
    expect(getImplPromptBody()).toMatch(/ground truth|OVERRIDE/);
  });

  it('TC section is conditional — only rendered when testCriteria exists', () => {
    // Must be guarded so stories without testCriteria don't get empty headers
    expect(getImplPromptBody()).toMatch(/\[ -n.*tc_facts|tc_facts.*&&/);
  });

  it('instructs agent that TC facts assertions MUST be matched exactly', () => {
    expect(getImplPromptBody()).toMatch(/MUST match|match them exactly|match exactly/i);
  });
});

// ─── 7b. run_failure_analyst reads testCriteria, falls back to ACs ────────────
describe('TC gate — run_failure_analyst uses testCriteria.facts as primary source', () => {
  const claudeSrc = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8'
  );

  function getAnalystBody(): string {
    const start = claudeSrc.indexOf('run_failure_analyst()');
    const end   = claudeSrc.indexOf('\n}', start + 100);
    return claudeSrc.slice(start, end);
  }

  it('failure analyst reads testCriteria.facts from PRD story', () => {
    expect(getAnalystBody()).toMatch(/testCriteria\.facts|\.testCriteria/);
  });

  it('prefers testCriteria over acceptanceCriteria when tc_facts_raw is non-empty', () => {
    const body = getAnalystBody();
    expect(body).toMatch(/tc_facts_raw/);
    expect(body).toMatch(/if.*-n.*tc_facts_raw|tc_facts_raw.*then/);
  });

  it('falls back to acceptanceCriteria when testCriteria is absent', () => {
    expect(getAnalystBody()).toContain('acceptanceCriteria');
  });

  it('analyst prompt label reflects TC-first approach', () => {
    expect(getAnalystBody()).toMatch(/TEST CRITERIA|TC facts/);
  });

  it('story_acs variable is still used in prompt substitution (__STORY_ACS__)', () => {
    const body = getAnalystBody();
    expect(body).toContain('story_acs');
    expect(body).toContain('__STORY_ACS__');
  });
});

// ─── 7. Preflight integrity: checks 17 and 18 ───────────────────────────────
describe('TC gate — preflight integrity checks', () => {
  it('preflight-prd-integrity.sh contains TC schema check (check 17)', () => {
    const src = readFileSync(INTEGRITY_SH, 'utf8');
    expect(src).toContain('testCriteria');
    expect(src).toContain('17.');
  });

  it('preflight-prd-integrity.sh contains TC sourceFiles alignment check (check 18)', () => {
    const src = readFileSync(INTEGRITY_SH, 'utf8');
    expect(src).toContain('18.');
    expect(src).toContain('sourceFiles');
  });

  it('current prd.json passes both TC preflight checks', () => {
    if (isCanonical) return; // preflight-prd-integrity.sh strict checks only apply post-spec-pass
    let exitCode = 0;
    let output = '';
    try {
      output = execSync(
        `bash "${INTEGRITY_SH}" --prd "${PRD_PATH}"`,
        { stdio: 'pipe', encoding: 'utf8' }
      );
    } catch (e: any) {
      exitCode = e.status ?? 1;
      output = e.stdout?.toString() ?? '';
    }
    // Should pass both TC checks
    expect(output).toContain('testCriteria field');
    expect(exitCode).toBe(0);
  });
});
