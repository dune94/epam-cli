/**
 * Healing Recorder — TDD tests for the run_healing_recorder function in claude.sh.
 *
 * Principle: we test the FRAMEWORK, not the travel app.
 * - All data is mock/generated in this file
 * - No reads from travel-app-prd.canonical.json or live profiles.json
 * - Integration tests invoke the bash function directly with synthetic inputs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

// ── 1. Structural contract (no bash needed) ───────────────────────────────────
describe('claude.sh — run_healing_recorder structural contract', () => {
  it('run_healing_recorder function is defined', () => {
    expect(claudeSrc).toMatch(/run_healing_recorder\s*\(\)/);
  });

  it('writes to healing-events.jsonl in OUTPUT_DIR', () => {
    const funcStart = claudeSrc.indexOf('run_healing_recorder()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/healing-events\.jsonl/);
  });

  it('record includes "ts" timestamp field', () => {
    const funcStart = claudeSrc.indexOf('run_healing_recorder()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/"ts"/);
  });

  it('record includes "story_id" field', () => {
    const funcStart = claudeSrc.indexOf('run_healing_recorder()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/"story_id"/);
  });

  it('record includes "retry" field (which attempt triggered the heal)', () => {
    const funcStart = claudeSrc.indexOf('run_healing_recorder()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/"retry"/);
  });

  it('record includes "target" field (prd | skill | none)', () => {
    const funcStart = claudeSrc.indexOf('run_healing_recorder()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/"target"/);
  });

  it('record includes "diagnosis" field', () => {
    const funcStart = claudeSrc.indexOf('run_healing_recorder()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/"diagnosis"/);
  });

  it('record includes "patches_applied" field (count of AC patches for target=prd)', () => {
    const funcStart = claudeSrc.indexOf('run_healing_recorder()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/"patches_applied"/);
  });

  it('record includes "profile_updated" field (true when profiles.json was mutated)', () => {
    const funcStart = claudeSrc.indexOf('run_healing_recorder()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/"profile_updated"/);
  });

  it('uses printf to write the record (not echo, to avoid line-continuation issues)', () => {
    const funcStart = claudeSrc.indexOf('run_healing_recorder()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/printf/);
  });

  it('appends with >> so prior events are not overwritten', () => {
    const funcStart = claudeSrc.indexOf('run_healing_recorder()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/>>/);
  });

  it('[HealingRecorder] marker logged so operator can see the event in run log', () => {
    const funcStart = claudeSrc.indexOf('run_healing_recorder()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/HealingRecorder/);
  });
});

// ── 2. Wiring — analyst calls the recorder ────────────────────────────────────
describe('claude.sh — run_failure_analyst calls run_healing_recorder on success', () => {
  it('run_healing_recorder is called inside run_failure_analyst body', () => {
    const analystStart = claudeSrc.indexOf('run_failure_analyst()');
    const analystEnd   = claudeSrc.indexOf('\n}', analystStart + 100);
    const body         = claudeSrc.slice(analystStart, analystEnd);
    expect(body).toMatch(/run_healing_recorder/);
  });

  it('recorder call comes AFTER the case statement (not inside a branch)', () => {
    const analystStart = claudeSrc.indexOf('run_failure_analyst()');
    const analystEnd   = claudeSrc.indexOf('\n}', analystStart + 100);
    const body         = claudeSrc.slice(analystStart, analystEnd);
    const esacIdx      = body.lastIndexOf('esac');
    const recorderIdx  = body.indexOf('run_healing_recorder');
    expect(esacIdx).toBeGreaterThan(-1);
    expect(recorderIdx).toBeGreaterThan(esacIdx);
  });

  it('recorder receives story_id, retry_num, target, diagnosis, patch_count, _profile_updated', () => {
    const analystStart = claudeSrc.indexOf('run_failure_analyst()');
    const analystEnd   = claudeSrc.indexOf('\n}', analystStart + 100);
    const body         = claudeSrc.slice(analystStart, analystEnd);
    expect(body).toMatch(/run_healing_recorder.*story_id.*retry_num|run_healing_recorder.*\$story_id/is);
  });

  it('run_failure_analyst accepts retry_num as 3rd parameter', () => {
    expect(claudeSrc).toMatch(/retry_num.*\$\{3:-0\}|local retry_num/);
  });

  it('call site in implement_story passes retry_count as 3rd arg', () => {
    expect(claudeSrc).toMatch(/run_failure_analyst.*\$story_id.*\$output_file.*\$retry_count/);
  });
});

// ── 3. Integration — bash execution with mock data ────────────────────────────
// These tests actually invoke run_healing_recorder via a real bash script to verify
// that the written JSONL is valid and contains the expected fields.
// Scripts are written to temp files to avoid JSON.stringify escaping bash syntax.
describe('run_healing_recorder — bash integration with mock data', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync('/tmp/healing-test-');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function extractRecorder(): string {
    // Grab the function definition from claude.sh source
    const start = claudeSrc.indexOf('run_healing_recorder()');
    if (start === -1) throw new Error('run_healing_recorder not found in claude.sh');
    // Find the closing } on its own line after the function body
    const rest = claudeSrc.slice(start);
    const end  = rest.indexOf('\n}') + 2;
    return rest.slice(0, end);
  }

  function runScript(tmpDir: string, calls: string): void {
    const funcDef    = extractRecorder();
    const scriptPath = join(tmpDir, 'run.sh');
    writeFileSync(scriptPath, `#!/bin/bash
${funcDef}
log() { :; }
OUTPUT_DIR="${tmpDir}"
${calls}
`);
    execSync(`bash "${scriptPath}"`);
  }

  it('writes a valid JSONL record for target=skill', () => {
    runScript(tmpDir, `run_healing_recorder "MOCK-001" "1" "skill" "constructor throws on missing key" "0" "false"`);
    const healLog = join(tmpDir, 'healing-events.jsonl');
    expect(existsSync(healLog)).toBe(true);
    const record = JSON.parse(readFileSync(healLog, 'utf8').trim());
    expect(record.story_id).toBe('MOCK-001');
    expect(record.retry).toBe(1);
    expect(record.target).toBe('skill');
    expect(record.diagnosis).toBe('constructor throws on missing key');
    expect(record.patches_applied).toBe(0);
    expect(record.profile_updated).toBe(false);
    expect(typeof record.ts).toBe('string');
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writes a valid JSONL record for target=prd with patches', () => {
    runScript(tmpDir, `run_healing_recorder "MOCK-002" "2" "prd" "AC missing 503 requirement" "3" "false"`);
    const record = JSON.parse(readFileSync(join(tmpDir, 'healing-events.jsonl'), 'utf8').trim());
    expect(record.story_id).toBe('MOCK-002');
    expect(record.target).toBe('prd');
    expect(record.patches_applied).toBe(3);
  });

  it('appends multiple records — does not truncate the file', () => {
    runScript(tmpDir, [
      `run_healing_recorder "MOCK-001" "1" "skill" "bad import" "0" "false"`,
      `run_healing_recorder "MOCK-002" "1" "prd" "AC ambiguous" "1" "false"`,
      `run_healing_recorder "MOCK-003" "2" "none" "transient failure" "0" "false"`,
    ].join('\n'));
    const lines   = readFileSync(join(tmpDir, 'healing-events.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const records = lines.map(l => JSON.parse(l));
    expect(records[0].story_id).toBe('MOCK-001');
    expect(records[1].story_id).toBe('MOCK-002');
    expect(records[2].story_id).toBe('MOCK-003');
  });

  it('handles diagnosis containing double-quotes safely (valid JSON output)', () => {
    const scriptPath = join(tmpDir, 'run.sh');
    const funcDef    = extractRecorder();
    // Use single-quoted arg to preserve the double-quotes inside the diagnosis
    writeFileSync(scriptPath, `#!/bin/bash
${funcDef}
log() { :; }
OUTPUT_DIR="${tmpDir}"
run_healing_recorder "MOCK-001" "1" "none" 'used "backtick" template incorrectly' "0" "false"
`);
    execSync(`bash "${scriptPath}"`);
    const line = readFileSync(join(tmpDir, 'healing-events.jsonl'), 'utf8').trim();
    expect(() => JSON.parse(line)).not.toThrow();
  });
});
