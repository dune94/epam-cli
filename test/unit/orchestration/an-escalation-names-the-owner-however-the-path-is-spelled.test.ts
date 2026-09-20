/**
 * AN ESCALATION RESOLVES ITS OWNER HOWEVER THE FILE PATH IS SPELLED.
 *
 * regintel 20260919T224649Z, resume 6 (2026-09-20 02:10): REGI-005b (owns tests/test_escalation.py
 * only) failed three times on a defect in regintel/classifier.py, its analyst diagnosed it
 * correctly each time, and escalate_defect_to_sibling_story filed
 * targetFile "/home/.../regintel-build/regintel/classifier.py" — the absolute path the agent
 * had been reading. The PRD declares the file as "regintel/classifier.py" (REGI-005a). The
 * resolver matched `candidate == file or candidate endswith "/"+file`, which only covers a
 * relative target against an absolute declaration; the opposite spelling never matched, the
 * run logged "Could not resolve an owning story ... no story declares it", and the story went
 * on to burn its ladder on a fix it is forbidden to make. The 2026-07-12 fix (BUG A) assumed
 * declarations are ALWAYS absolute; greenfield PRDs declare them relative to outputDir.
 *
 * A declaration and a target name the same file when either is the other, or either ends with
 * "/" + the other. A deprecated split parent, which still lists the pre-split combined files,
 * is never the owner (the write side already excludes it; the resolver must too).
 *
 * Executes the real resolve_escalation() with implement_story stubbed, as escalation.test.ts does.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const REPO_ROOT = join(__dirname, '../../../');
const src = engineSource(join(REPO_ROOT, 'orchestrations/scripts/claude.sh'));

function fnBody(name: string): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${name}() {`);
  if (start === -1) throw new Error(`no ${name}`);
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) { body.push(lines[i]); if (lines[i] === '}') return body.join('\n'); }
  throw new Error(`unterminated ${name}`);
}

function resolve(prd: object, escalatingStoryId: string, targetFile: string) {
  const dir = mkdtempSync(join(tmpdir(), 'escalation-path-'));
  try {
    writeFileSync(join(dir, 'prd.json'), JSON.stringify(prd));
    mkdirSync(join(dir, '.epam/escalations'), { recursive: true });
    writeFileSync(join(dir, '.epam/escalations', `${escalatingStoryId}.json`),
      JSON.stringify({ targetFile, diagnosis: 'classify_event is async; TC8 declares it synchronous', requiredFix: 'make classify_event synchronous' }));
    const script = join(dir, 'run.sh');
    writeFileSync(script, [
      `PROJECT_ROOT="${dir}"`, `PRD_FILE="${dir}/prd.json"`, `MAX_RETRIES=8`,
      `log() { echo "LOG: $*"; }`, `warning() { echo "WARN: $*"; }`, `success() { echo "SUCCESS: $*"; }`,
      `implement_story() { echo "IMPLEMENT_STORY_CALLED_WITH:$1"; return 0; }`,
      fnBody('resolve_escalation'),
      `resolve_escalation "${escalatingStoryId}"`, `echo "EXIT:$?"`,
    ].join('\n'));
    const out = execFileSync('bash', [script], { encoding: 'utf8' });
    const owner = (out.match(/IMPLEMENT_STORY_CALLED_WITH:(\S+)/) || [])[1] || '';
    return { out, exit: parseInt((out.match(/EXIT:(\d+)/) || ['', '-1'])[1], 10), owner,
      fileLeft: existsSync(join(dir, '.epam/escalations', `${escalatingStoryId}.json`)) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const OUT = '/home/bradleyjerome/projects/ai/regintel-build';
// The live PRD's shape: the deprecated parents still list the combined files, the children split them.
const REGINTEL = {
  project: { outputDir: OUT },
  stories: [
    { id: 'REGI-004', status: 'deprecated', technicalNotes: { files: ['regintel/classifier.py', 'regintel/config.py', 'tests/test_classifier.py'] } },
    { id: 'REGI-005', status: 'deprecated', technicalNotes: { files: ['regintel/escalation.py', 'regintel/classifier.py', 'tests/test_escalation.py'] } },
    { id: 'REGI-004a', status: 'completed', specification: { createdFrom: 'REGI-004' }, technicalNotes: { files: ['regintel/classifier.py', 'regintel/config.py'] } },
    { id: 'REGI-004b', status: 'completed', specification: { createdFrom: 'REGI-004' }, technicalNotes: { files: ['tests/test_classifier.py'] } },
    { id: 'REGI-005a', status: 'completed', specification: { createdFrom: 'REGI-005' }, technicalNotes: { files: ['regintel/escalation.py', 'regintel/classifier.py'] } },
    { id: 'REGI-005b', status: 'pending', specification: { createdFrom: 'REGI-005' }, technicalNotes: { files: ['tests/test_escalation.py'] } },
  ],
};

describe('THE DEFECT: an absolute target against a relative declaration', () => {
  it('resolves REGI-005a as the owner of the absolute path the agent filed', () => {
    const r = resolve(REGINTEL, 'REGI-005b', `${OUT}/regintel/classifier.py`);
    expect(r.out, r.out).not.toMatch(/Could not resolve an owning story/);
    expect(r.owner).toBe('REGI-005a');
    expect(r.exit).toBe(0);
    expect(r.fileLeft).toBe(false);
  });

  it('still resolves the relative spelling', () => {
    expect(resolve(REGINTEL, 'REGI-005b', 'regintel/classifier.py').owner).toBe('REGI-005a');
  });
});

describe('the other spellings keep working', () => {
  const ABS = { stories: [
    { id: 'S-impl', specification: { createdFrom: 'S' }, technicalNotes: { files: [`${OUT}/src/client.ts`] } },
    { id: 'S-test', specification: { createdFrom: 'S' }, technicalNotes: { files: [`${OUT}/src/client.test.ts`] } },
  ] };
  it('relative target against an absolute declaration (the 2026-07-12 case)', () => {
    expect(resolve(ABS, 'S-test', 'src/client.ts').owner).toBe('S-impl');
  });
  it('absolute target against an absolute declaration', () => {
    expect(resolve(ABS, 'S-test', `${OUT}/src/client.ts`).owner).toBe('S-impl');
  });
  it('a file no story declares is still unresolved', () => {
    const r = resolve(REGINTEL, 'REGI-005b', `${OUT}/regintel/ghost.py`);
    expect(r.out).toMatch(/Could not resolve an owning story/);
    expect(r.exit).toBe(1);
  });
  it('a shared basename in another directory is not a match', () => {
    const r = resolve(REGINTEL, 'REGI-005b', `${OUT}/other/classifier.py`);
    expect(r.out).toMatch(/Could not resolve an owning story/);
  });
});

describe('a deprecated split parent is never the owner', () => {
  it('the project-wide fallback skips the deprecated parent that still lists the combined files', () => {
    // No split relationship between the escalating story and the owner: only the fallback can find it.
    const prd = { stories: [
      { id: 'P', status: 'deprecated', technicalNotes: { files: ['regintel/classifier.py', 'tests/test_classifier.py'] } },
      { id: 'P-a', status: 'completed', specification: { createdFrom: 'P' }, technicalNotes: { files: ['regintel/classifier.py'] } },
      { id: 'Q', status: 'pending', technicalNotes: { files: ['tests/test_q.py'] } },
    ] };
    expect(resolve(prd, 'Q', `${OUT}/regintel/classifier.py`).owner).toBe('P-a');
  });
});
