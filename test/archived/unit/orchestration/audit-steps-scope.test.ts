/**
 * Steps 11/12 (Skills coordinator audit, Tools coordinator audit) — REAL
 * execution of the actual, unmodified scan functions from
 * run-agent-orchestration.sh, proving neither can touch a project's
 * tsconfig.json (or any file outside their own declared scope:
 * AGENT_PROFILES_FILE for Step 11, PROJECT_ROOT/.epam/dynamic-tools/*.sh
 * for Step 12).
 *
 * Built 2026-07-23 as part of ruling out candidates for the mystery Step 19
 * tsc failure (`moduleResolution=node10`) hit twice in the full mock1
 * pipeline run but not reproducible via the code-writer step alone (see
 * code-writer-real-agent.test.ts) or Step 19 in isolation (see
 * pre-review-gate-step19.test.ts). This test proves Steps 11/12 are not the
 * cause either, by direct code-level execution against a real project
 * fixture with a real tsconfig.json present.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractFn(name: string): string {
  const start = orchSrc.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() not found`);
  const end = orchSrc.indexOf('\n}', start) + 2;
  return orchSrc.slice(start, end);
}

const skillsAuditFn = extractFn('run_skills_audit_scan');
const toolsAuditFn = extractFn('run_tools_audit_scan');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeProjectFixture(): { dir: string; tsconfigPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'audit-steps-'));
  cleanupDirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.epam/dynamic-tools'), { recursive: true });
  const tsconfigPath = join(dir, 'tsconfig.json');
  writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: { module: 'CommonJS', moduleResolution: 'node', target: 'ES2020' },
    include: ['src/**/*.ts'],
  }, null, 2));
  return { dir, tsconfigPath };
}

function makeProfilesFixture(): { path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'audit-profiles-'));
  cleanupDirs.push(dir);
  const path = join(dir, 'profiles.json');
  writeFileSync(path, JSON.stringify({
    'typescript-engineer': "You are a typescript engineer.\n\n[Self-Heal] Do not use 'as' keyword.\n\n[Self-Heal] Do not use 'as' keyword.",
  }, null, 2));
  return { path };
}

function runBashSnippet(snippet: string): { rc: number; output: string } {
  const scriptDir = mkdtempSync(join(tmpdir(), 'audit-harness-'));
  cleanupDirs.push(scriptDir);
  const scriptPath = join(scriptDir, 'run.sh');
  writeFileSync(scriptPath, ['#!/usr/bin/env bash', snippet].join('\n'));
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  return { rc: result.status ?? -1, output: (result.stdout || '') + (result.stderr || '') };
}

describe('Step 11 (Skills coordinator audit) — REAL execution, scope is AGENT_PROFILES_FILE only', () => {
  it('extracted the real, non-empty function body', () => {
    expect(skillsAuditFn).toMatch(/duplicates_removed/);
    expect(skillsAuditFn.length).toBeGreaterThan(100);
  });

  it('deduplicates real self-heal notes in profiles.json and reports the count', () => {
    const { path } = makeProfilesFixture();
    const { rc, output } = runBashSnippet([skillsAuditFn, `run_skills_audit_scan ${JSON.stringify(path)}`].join('\n'));
    expect(rc, output).toBe(0);
    const result = JSON.parse(output.trim());
    expect(result.duplicates_removed).toBe(1);
  });

  it('never touches a project tsconfig.json — its only file argument is profiles.json', () => {
    const { tsconfigPath } = makeProjectFixture();
    const { path: profilesPath } = makeProfilesFixture();
    const tsconfigBefore = readFileSync(tsconfigPath, 'utf8');
    const { rc } = runBashSnippet([skillsAuditFn, `run_skills_audit_scan ${JSON.stringify(profilesPath)}`].join('\n'));
    expect(rc).toBe(0);
    expect(readFileSync(tsconfigPath, 'utf8')).toBe(tsconfigBefore);
  });
});

describe('Step 12 (Tools coordinator audit) — REAL execution, scope is .epam/dynamic-tools/*.sh only', () => {
  it('extracted the real, non-empty function body', () => {
    expect(toolsAuditFn).toMatch(/broken/);
    expect(toolsAuditFn.length).toBeGreaterThan(100);
  });

  it('reports zero broken/duplicate tools for an empty dynamic-tools dir', () => {
    const { dir } = makeProjectFixture();
    const { rc, output } = runBashSnippet([
      toolsAuditFn,
      `run_tools_audit_scan ${JSON.stringify(join(dir, '.epam/dynamic-tools'))} ${JSON.stringify(dir)}`,
    ].join('\n'));
    expect(rc, output).toBe(0);
    const result = JSON.parse(output.trim());
    expect(result.broken).toEqual([]);
    expect(result.duplicates).toEqual([]);
  });

  it('never touches a project tsconfig.json — its only file arguments are the dynamic-tools dir and log dir', () => {
    const { dir, tsconfigPath } = makeProjectFixture();
    const tsconfigBefore = readFileSync(tsconfigPath, 'utf8');
    const { rc } = runBashSnippet([
      toolsAuditFn,
      `run_tools_audit_scan ${JSON.stringify(join(dir, '.epam/dynamic-tools'))} ${JSON.stringify(dir)}`,
    ].join('\n'));
    expect(rc).toBe(0);
    expect(readFileSync(tsconfigPath, 'utf8')).toBe(tsconfigBefore);
  });

  it('detects a syntax-broken tool deterministically, still without touching tsconfig.json', () => {
    const { dir, tsconfigPath } = makeProjectFixture();
    writeFileSync(join(dir, '.epam/dynamic-tools/bad-tool.sh'), '#!/usr/bin/env bash\n# does something\nif [ ]; then\n');
    writeFileSync(join(dir, '.epam/dynamic-tools/bad-tool.sh.reviewed'), '');
    const tsconfigBefore = readFileSync(tsconfigPath, 'utf8');
    const { rc, output } = runBashSnippet([
      toolsAuditFn,
      `run_tools_audit_scan ${JSON.stringify(join(dir, '.epam/dynamic-tools'))} ${JSON.stringify(dir)}`,
    ].join('\n'));
    expect(rc, output).toBe(0);
    const result = JSON.parse(output.trim());
    expect(result.broken.some((b: any) => b.tool === 'bad-tool' && b.reason === 'syntax')).toBe(true);
    expect(readFileSync(tsconfigPath, 'utf8')).toBe(tsconfigBefore);
  });
});
