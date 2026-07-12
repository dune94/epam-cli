/**
 * Step 1.65: Skills coordinator audit (run-agent-orchestration.sh).
 *
 * Motivation (2026-07-10, tier3-travel-app session): nothing in the pipeline
 * ever looked at the ACCUMULATED set of persisted self-heal skill notes as a
 * whole — FailureAnalyst only ever appends. This let a self-contradictory
 * note ("Do not use 'as' keyword... use 'value as Type'...") get persisted
 * TWICE, verbatim, into typescript-engineer's profile (a separate bug, fixed
 * in skill-note-dedup-truncation.test.ts). This step adds a periodic auditor:
 *   1. A free, deterministic scan (run_skills_audit_scan) that collapses
 *      exact-duplicate [Self-Heal] notes and flags a narrow "says not to use
 *      X, then recommends using X" contradiction pattern.
 *   2. Only when the scan flags something, a skills-coordinator LLM call
 *      rewrites JUST the flagged note — the LLM is never invoked when the
 *      scan finds nothing to fix.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('Step 1.65 wiring (static)', () => {
  it('runs after Step 1.6 (TC writer gate), before the monitor sync', () => {
    const tcGateIdx = orchSrc.indexOf('step_emit "1.6" "skip" "Step 1.6: TC writer gate"');
    const auditIdx = orchSrc.indexOf('Step 1.65: Skills coordinator audit');
    const syncIdx = orchSrc.indexOf('Sync story data to monitor from cost log');
    expect(tcGateIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(tcGateIdx);
    expect(syncIdx).toBeGreaterThan(auditIdx);
  });

  it('respects SKIP_SKILLS_AUDIT=1', () => {
    const idx = orchSrc.indexOf('if [ "${SKIP_SKILLS_AUDIT:-0}" = "1" ]; then');
    expect(idx).toBeGreaterThan(-1);
  });

  it('the LLM call is only reached inside the contradiction-count branch, not unconditionally', () => {
    const idx = orchSrc.indexOf('run_orch_prompt_with_tools "$_sc_prompt"');
    const contradictionIfIdx = orchSrc.lastIndexOf('if [ "${_skills_contradiction_count:-0}" -gt 0 ]; then', idx);
    expect(idx).toBeGreaterThan(-1);
    expect(contradictionIfIdx).toBeGreaterThan(-1);
    expect(contradictionIfIdx).toBeLessThan(idx);
  });

  it('appends the "1.65" checklist row to the step-status board', () => {
    expect(orchSrc).toMatch(/_checklist_row "1\.65"\s+"Skills coordinator audit"/);
  });

  it('includes "1.65" in the skip-counting key list alongside the other steps', () => {
    const idx = orchSrc.indexOf('for key in "0" "0.1"');
    const line = orchSrc.slice(idx, orchSrc.indexOf('\n', idx));
    expect(line).toMatch(/"1\.6" "1\.65"/);
  });

  it('restores the pre-audit profiles.json snapshot if the LLM rewrite corrupts the JSON', () => {
    const idx = orchSrc.indexOf('_skills_before=$(cat "$AGENT_PROFILES_FILE"');
    expect(idx).toBeGreaterThan(-1);
    const block = orchSrc.slice(idx, idx + 2200);
    expect(block).toMatch(/jq empty "\$AGENT_PROFILES_FILE"/);
    expect(block).toMatch(/echo "\$_skills_before" > "\$AGENT_PROFILES_FILE"/);
  });

  it('logs a warning (not a hard failure) when the skills-coordinator call itself fails', () => {
    const idx = orchSrc.indexOf('_skills_before=$(cat "$AGENT_PROFILES_FILE"');
    const block = orchSrc.slice(idx, idx + 2200);
    expect(block).toMatch(/failed to rewrite note for.*leaving as-is/);
  });

  it('writes one JSONL audit record per flagged contradiction, regardless of rewrite outcome', () => {
    const idx = orchSrc.indexOf('_skills_before=$(cat "$AGENT_PROFILES_FILE"');
    const block = orchSrc.slice(idx, idx + 2000);
    // The jq -cn append call must be OUTSIDE (after) the if/else that branches
    // on rewrite success/failure/corruption -- i.e. it always runs once per
    // contradiction, not just on the success path.
    const doneLoopIdx = block.indexOf('done < <(echo "$_skills_audit_result"');
    const jsonlAppendIdx = block.lastIndexOf('skills-coordinator-audit.jsonl', doneLoopIdx);
    expect(doneLoopIdx).toBeGreaterThan(-1);
    expect(jsonlAppendIdx).toBeGreaterThan(-1);
    expect(jsonlAppendIdx).toBeLessThan(doneLoopIdx);
  });
});

describe('run_skills_audit_scan — REAL execution', () => {
  function extractFunctionBody(name: string): string {
    const start = orchSrc.indexOf(`${name}() {`);
    if (start === -1) throw new Error(`${name} not found`);
    // The function body ends at the line containing only "}" that closes the
    // heredoc-wrapped python3 call — find the first "}\n" after the PYEOF marker.
    const pyeofIdx = orchSrc.indexOf('PYEOF', start);
    const end = orchSrc.indexOf('\n}', pyeofIdx) + 2;
    return orchSrc.slice(start, end);
  }

  function runScan(profiles: Record<string, string>): { duplicates_removed: number; contradictions: { role: string; note: string }[]; finalProfiles: Record<string, string> } {
    const dir = mkdtempSync(join(tmpdir(), 'skills-audit-scan-'));
    const profilesPath = join(dir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
    try {
      const fnBody = extractFunctionBody('run_skills_audit_scan');
      const script = `${fnBody}\nrun_skills_audit_scan "$1"\n`;
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, script);
      const output = execFileSync('bash', [scriptPath, profilesPath], { encoding: 'utf8' });
      const result = JSON.parse(output.trim());
      const finalProfiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
      return { ...result, finalProfiles };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live shape: an exact-duplicate [Self-Heal] note is collapsed to one', () => {
    const note = "[Self-Heal] Always declare explicit return types on exported async functions.";
    const { duplicates_removed, finalProfiles } = runScan({
      'typescript-engineer': `Base profile text.\n\n${note}\n\n${note}`,
    });
    expect(duplicates_removed).toBe(1);
    expect((finalProfiles['typescript-engineer'].match(/Always declare explicit return types/g) || []).length).toBe(1);
  });

  it('flags a self-contradictory note (says not to use X, then recommends using X)', () => {
    const contradictoryNote =
      "[Self-Heal] Do not use 'as' keyword for type assertions in TypeScript when the type is not explicitly defined; use explicit type casting with 'value as Type' or '<Type>value' instead.";
    const { contradictions } = runScan({
      'typescript-engineer': `Base profile text.\n\n${contradictoryNote}`,
    });
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0].role).toBe('typescript-engineer');
    expect(contradictions[0].note).toContain("Do not use 'as'");
  });

  it('does NOT flag a coherent note with no contradiction (no false positive)', () => {
    const coherentNote =
      "[Self-Heal] Always declare explicit return types on exported async functions to avoid implicit any inference.";
    const { contradictions, duplicates_removed } = runScan({
      'typescript-engineer': `Base profile text.\n\n${coherentNote}`,
    });
    expect(contradictions).toHaveLength(0);
    expect(duplicates_removed).toBe(0);
  });

  it('scans every role, not just the first', () => {
    const dupe = '[Self-Heal] Never mutate shared state inside a promise callback.';
    const { duplicates_removed } = runScan({
      'typescript-engineer': 'clean profile, nothing to fix',
      'test-engineer': `${dupe}\n\n${dupe}`,
    });
    expect(duplicates_removed).toBe(1);
  });
});

describe('Step 1.65 — REAL execution: LLM only invoked when the deterministic scan flags something', () => {
  function extractStepBlock(): string {
    const startMarker = 'if [ "${SKIP_SKILLS_AUDIT:-0}" = "1" ]; then';
    const start = orchSrc.indexOf(startMarker);
    const endMarker = 'step_emit "1.65" "pass" "Step 1.65: Skills coordinator audit"\nfi';
    const end = orchSrc.indexOf(endMarker, start) + endMarker.length;
    if (start === -1 || end === -1) throw new Error('Could not locate Step 1.65 block');
    return orchSrc.slice(start, end);
  }

  function extractScanFunction(): string {
    const start = orchSrc.indexOf('run_skills_audit_scan() {');
    const pyeofIdx = orchSrc.indexOf('PYEOF', start);
    const end = orchSrc.indexOf('\n}', pyeofIdx) + 2;
    return orchSrc.slice(start, end);
  }

  type StubMode = 'rewrite-success' | 'llm-fails' | 'corrupts-json';

  function buildStub(profilesPath: string, callLog: string, dir: string, mode: StubMode): string {
    const stubPath = join(dir, 'ai-runner-stub.sh');
    if (mode === 'llm-fails') {
      writeFileSync(
        stubPath,
        ['#!/usr/bin/env bash', 'cat > /dev/null', `echo called >> ${JSON.stringify(callLog)}`, 'exit 1'].join('\n'),
      );
    } else if (mode === 'corrupts-json') {
      writeFileSync(
        stubPath,
        [
          '#!/usr/bin/env bash',
          'cat > /dev/null',
          `echo called >> ${JSON.stringify(callLog)}`,
          `echo 'not valid json{{{' > ${JSON.stringify(profilesPath)}`,
          'exit 0',
        ].join('\n'),
      );
    } else {
      const rewritePyPath = join(dir, 'rewrite.py');
      writeFileSync(
        rewritePyPath,
        [
          'import json, sys',
          'path = sys.argv[1]',
          'with open(path) as f:',
          '    p = json.load(f)',
          "old = (\"Do not use 'as' keyword for type assertions in TypeScript when the \"",
          "       \"type is not explicitly defined; use explicit type casting with \"",
          "       \"'value as Type' or '<Type>value' instead.\")",
          "new = (\"Use explicit type casting with 'value as Type' syntax only; \"",
          "       \"never use the angle-bracket '<Type>value' form.\")",
          "p['typescript-engineer'] = p['typescript-engineer'].replace(old, new)",
          "old2 = \"Never mutate shared state inside a promise callback.\"",
          "new2 = \"Never mutate shared state inside a promise callback (rewritten).\"",
          "p['test-engineer'] = p.get('test-engineer', '').replace(old2, new2)",
          'with open(path, "w") as f:',
          '    json.dump(p, f, indent=2)',
        ].join('\n'),
      );
      writeFileSync(
        stubPath,
        [
          '#!/usr/bin/env bash',
          'cat > /dev/null',
          `echo called >> ${JSON.stringify(callLog)}`,
          `python3 ${JSON.stringify(rewritePyPath)} ${JSON.stringify(profilesPath)}`,
          'exit 0',
        ].join('\n'),
      );
    }
    chmodSync(stubPath, 0o755);
    return stubPath;
  }

  function run(
    profiles: Record<string, string>,
    opts: { stubMode?: StubMode; skipAudit?: boolean } = {},
  ): { llmCallCount: number; stdout: string; finalProfiles: Record<string, string>; auditLogRecords: any[]; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'skills-step-'));
    const profilesPath = join(dir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));

    const callLog = join(dir, 'llm-called.txt');
    const stubPath = buildStub(profilesPath, callLog, dir, opts.stubMode ?? 'rewrite-success');

    const scanFn = extractScanFunction();
    const block = extractStepBlock();
    const script = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      'step_emit() { :; }',
      'error() { echo "ERROR: $*"; }',
      'success() { echo "SUCCESS: $*"; }',
      'warning() { echo "WARNING: $*"; }',
      'info() { echo "INFO: $*"; }',
      // Mirrors the REAL run_orch_prompt_with_tools/run_orch_prompt: the
      // prompt is a positional ARGUMENT, piped into the AI runner's stdin via
      // an explicit echo -- it must NOT read from the caller's own /dev/stdin,
      // since this function is called from inside a `while read` loop over a
      // process-substitution stream. An earlier version of this stub did
      // `"${stubPath}" < /dev/stdin`, which taps directly into that shared fd
      // and silently consumes the loop's remaining input -- with 2 flagged
      // contradictions queued up, only the first ever got processed.
      'run_orch_prompt_with_tools() {',
      `  echo "$1" | "${stubPath}"`,
      '}',
      `AGENT_PROFILES_FILE=${JSON.stringify(profilesPath)}`,
      `LOG_DIR=${JSON.stringify(dir)}`,
      'PHASE=core',
      opts.skipAudit ? 'SKIP_SKILLS_AUDIT=1' : '',
      scanFn,
      block,
    ]
      .filter(Boolean)
      .join('\n');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, script);

    let stdout = '';
    try {
      stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    } catch (e: any) {
      stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
    }
    let llmCallCount = 0;
    try {
      llmCallCount = readFileSync(callLog, 'utf8').split('\n').filter((l) => l === 'called').length;
    } catch {
      /* not called */
    }
    const finalProfiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
    let auditLogRecords: any[] = [];
    try {
      auditLogRecords = readFileSync(join(dir, 'skills-coordinator-audit.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      /* no log written */
    }
    return { llmCallCount, stdout, finalProfiles, auditLogRecords, dir };
  }

  const contradictoryNote =
    "[Self-Heal] Do not use 'as' keyword for type assertions in TypeScript when the type is not explicitly defined; use explicit type casting with 'value as Type' or '<Type>value' instead.";

  it('a clean profile (no duplicates, no contradictions) never invokes the LLM', () => {
    const { llmCallCount, stdout, dir } = run({
      'typescript-engineer': '[Self-Heal] Always declare explicit return types on exported async functions.',
    });
    expect(llmCallCount).toBe(0);
    expect(stdout).not.toMatch(/suspected self-contradictory/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('REPRODUCES the exact live case: a flagged contradiction invokes the LLM and the note gets rewritten coherently', () => {
    const { llmCallCount, finalProfiles, dir } = run({
      'typescript-engineer': `Base profile text.\n\n${contradictoryNote}`,
    });
    expect(llmCallCount).toBe(1);
    expect(finalProfiles['typescript-engineer']).not.toContain("Do not use 'as' keyword");
    expect(finalProfiles['typescript-engineer']).toContain('never use the angle-bracket');
    rmSync(dir, { recursive: true, force: true });
  });

  it('SKIP_SKILLS_AUDIT=1 skips the whole step at runtime — LLM never called, profile untouched even with a real duplicate present', () => {
    const dupe = '[Self-Heal] Always declare explicit return types on exported async functions.';
    const { llmCallCount, finalProfiles, dir } = run(
      { 'typescript-engineer': `${dupe}\n\n${dupe}` },
      { skipAudit: true },
    );
    expect(llmCallCount).toBe(0);
    // Duplicate is still present — the deterministic scan itself never ran either.
    expect((finalProfiles['typescript-engineer'].match(/Always declare explicit return types/g) || []).length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('LLM call failure: logs a warning, leaves the note as-is, does not crash the step', () => {
    const { llmCallCount, stdout, finalProfiles, dir } = run(
      { 'typescript-engineer': `Base profile text.\n\n${contradictoryNote}` },
      { stubMode: 'llm-fails' },
    );
    expect(llmCallCount).toBe(1);
    expect(stdout).toMatch(/failed to rewrite note.*leaving as-is/);
    // Note is unchanged since the rewrite attempt failed.
    expect(finalProfiles['typescript-engineer']).toContain("Do not use 'as' keyword");
    rmSync(dir, { recursive: true, force: true });
  });

  it('LLM corrupts profiles.json: pre-audit snapshot is restored, error logged', () => {
    const originalProfiles = { 'typescript-engineer': `Base profile text.\n\n${contradictoryNote}` };
    const { llmCallCount, stdout, finalProfiles, dir } = run(originalProfiles, { stubMode: 'corrupts-json' });
    expect(llmCallCount).toBe(1);
    expect(stdout).toMatch(/corrupted profiles\.json.*[Rr]estoring/);
    // Restored to the pre-audit snapshot -- the flagged note is back, valid JSON.
    expect(finalProfiles['typescript-engineer']).toContain("Do not use 'as' keyword");
    rmSync(dir, { recursive: true, force: true });
  });

  it('multiple contradictions across different roles each trigger their own LLM call', () => {
    const otherContradiction = "[Self-Heal] Never mutate shared state inside a promise callback.";
    const { llmCallCount, finalProfiles, dir } = run({
      'typescript-engineer': `Base profile text.\n\n${contradictoryNote}`,
      'test-engineer': otherContradiction,
    });
    // "Never mutate shared state inside a promise callback." alone doesn't
    // match the contradiction regex (no "do not use 'X'" pattern) -- confirm
    // the real trigger here is TWO distinct contradictory notes, not just one.
    // Use a second genuinely contradictory note to exercise the multi-role path.
    const secondContradiction =
      "[Self-Heal] Never use 'var' for variable declarations; use 'var' only inside legacy CommonJS wrapper functions.";
    const { llmCallCount: count2, finalProfiles: final2, dir: dir2 } = run({
      'typescript-engineer': `Base profile text.\n\n${contradictoryNote}`,
      'test-engineer': `Base profile text.\n\n${secondContradiction}`,
    });
    expect(count2).toBe(2);
    // The stub's rewriter only knows how to fix the 'as'-keyword note; the
    // 'var' note is left as-is by the stub, but the call still had to happen.
    expect(final2['typescript-engineer']).not.toContain("Do not use 'as' keyword");
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });

  it('writes one JSONL audit record per flagged contradiction with the expected fields', () => {
    const { auditLogRecords, dir } = run({
      'typescript-engineer': `Base profile text.\n\n${contradictoryNote}`,
    });
    expect(auditLogRecords).toHaveLength(1);
    expect(auditLogRecords[0]).toMatchObject({
      phase: 'core',
      role: 'typescript-engineer',
      event: 'contradiction_rewrite',
    });
    expect(auditLogRecords[0].flagged_note).toContain("Do not use 'as' keyword");
    expect(auditLogRecords[0].timestamp).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });
});
