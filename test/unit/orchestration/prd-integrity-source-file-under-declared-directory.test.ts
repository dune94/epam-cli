/**
 * A SOURCE FILE UNDER A DECLARED DIRECTORY IS DECLARED.
 *
 * Check #18 (testCriteria.sourceFiles align with known story files) matched sourceFiles by
 * basename against the basenames of every story's technicalNotes.files. A story may declare a
 * DIRECTORY — regintel's REGI-001 declares `dial/` (a package copied whole from the read-only
 * source repo) — and the TC writer then legitimately lists `dial/client.py` as a source file.
 * The basename of `dial/` is `dial`, `client.py` matched nothing, and the resume of run
 * 20260919T141354Z was refused at pre-flight (2026-09-19): "sourceFiles references unknown file
 * 'client.py'" on a story the run had already completed and reviewed.
 *
 * Executes the real preflight-prd-integrity.sh against a PRD, as its sibling tests do.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/preflight-prd-integrity.sh');
const outputDir = '/tmp/prd-integrity-dir-fixture-app';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fixture(sourceFiles: string[], files: string[]): any {
  return {
    project: { outputDir },
    stories: [{
      id: 'REGI-001', status: 'pending', completed: false, effort: 'medium',
      aiProvider: 'openrouter', model: 'z-ai/glm-5.3',
      acceptanceCriteria: ['the package imports cleanly'],
      technicalNotes: { files },
      testCriteria: { facts: ['imports cleanly'], sourceFiles },
    }],
    implementationOrder: { scaffold: ['REGI-001'], core: [] },
  };
}

function run(prd: any): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prd-integrity-dir-')); dirs.push(dir);
  const prdPath = join(dir, 'prd.json');
  writeFileSync(prdPath, JSON.stringify(prd));
  try {
    return { code: 0, out: execFileSync('bash', [SCRIPT, '--prd', prdPath], { encoding: 'utf8' }) };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('check #18 — testCriteria.sourceFiles against declared files', () => {
  it('accepts a source file inside a declared directory', () => {
    const r = run(fixture(['dial/client.py', 'dial/__init__.py'], ['dial/', 'requirements.txt']));
    expect(r.out, r.out).not.toMatch(/sourceFiles references unknown file/);
    expect(r.code).toBe(0);
  });

  it('accepts it when the declared directory is absolute and the source file relative', () => {
    const r = run(fixture(['dial/client.py'], [`${outputDir}/dial/`]));
    expect(r.out).not.toMatch(/sourceFiles references unknown file/);
  });

  it('still refuses a source file that no story declares by file or directory', () => {
    const r = run(fixture(['regintel/ghost.py'], ['dial/', 'requirements.txt']));
    expect(r.out).toMatch(/sourceFiles references unknown file 'ghost\.py'/);
    expect(r.code).not.toBe(0);
  });

  it('a declared directory does not cover a file outside it that merely shares a basename', () => {
    const r = run(fixture(['regintel/client.py'], ['dial/']));
    expect(r.out).toMatch(/sourceFiles references unknown file 'client\.py'/);
  });
});
