/**
 * A DEFECT IN A SHARED FILE REACHES THE OWNER THE ANALYST NAMED.
 *
 * regintel/classifier.py is declared by three stories: REGI-004-A, REGI-005-A and REGI-009a. Live
 * 2026-09-24 REGI-009a's analyst diagnosed the dedup defect there (REGI-005-A's classifier dedup pass);
 * _apply_analyst_escalation refused any escalation of a file in the story's OWN scope and turned it
 * into a skill note, so REGI-009a's writer was told to fix another story's code and spent 11.4M
 * tokens on it. And resolve_escalation ignored the analyst's ownerStoryId, taking the first declarer
 * in array order. On a file several stories declare, "whose fix is it" is the analyst's judgement,
 * and it is honoured. A file only this story declares is still this story's to fix.
 *
 * Driven through the real functions over the REAL regintel PRD (test/fixtures/regintel).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';
import { escalationMachinery } from '../../lib/escalation-engine';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const PRD = join(__dirname, '../../fixtures/regintel/prd-20260924.json');
const dirs: string[] = []; afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function apply(story: string, answer: object) {
  const d = mkdtempSync(join(tmpdir(), 'shared-')); dirs.push(d);
  const r = spawnSync('bash', ['-c', `log(){ echo "LOG $*"; }; warning(){ echo "WARN $*"; }
PROJECT_ROOT=${JSON.stringify(d)}; PRD_FILE=${JSON.stringify(PRD)}
${shellFunction(join(LIB, 'failure-healing.sh'), '_apply_analyst_escalation')}
_apply_analyst_escalation ${story} ${JSON.stringify(JSON.stringify(answer))}; echo "RC=$?"`], { encoding: 'utf8' });
  const f = join(d, '.epam/escalations', `${story}.json`);
  return { out: (r.stdout || '') + (r.stderr || ''), rc: Number(((r.stdout || '').match(/RC=(\d+)/) || [])[1]), record: existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null, dir: d };
}
const classifier = (owner?: string) => ({ target: 'escalate', diagnosis: 'the dedup pass reads dict rows with getattr and never detects a duplicate',
  escalation: { targetFile: 'regintel/classifier.py', requiredFix: 'read fields from a dict by key', ...(owner ? { ownerStoryId: owner } : {}) } });

describe('a defect in a shared file reaches the owner the analyst named', () => {
  it('the fixture is the real PRD: classifier.py is declared by REGI-004-A, REGI-005-A and REGI-009a', () => {
    const p = JSON.parse(readFileSync(PRD, 'utf8'));
    const owners = p.stories.filter((s: any) => s.status !== 'deprecated' && (s.technicalNotes?.files || []).includes('regintel/classifier.py')).map((s: any) => s.id).sort();
    expect(owners).toEqual(['REGI-004-A', 'REGI-005-A', 'REGI-009a']);
  });

  it('REPRODUCES 2026-09-24: REGI-009a escalating to REGI-005-A on the shared file is FILED, not turned into a skill note', () => {
    const { rc, record, out } = apply('REGI-009a', classifier('REGI-005-A'));
    expect(out).not.toMatch(/inside REGI-009a's own scope/);
    expect(rc, out).toBe(0);
    expect(record?.ownerStoryId).toBe('REGI-005-A');
  });

  it('naming no owner on a shared file stays this story\'s fix — nothing is guessed', () => {
    const { rc } = apply('REGI-009a', classifier());
    expect(rc).toBe(1);
  });

  it('naming an owner that does not declare the file stays this story\'s fix', () => {
    const { rc } = apply('REGI-009a', classifier('REGI-010-A'));
    expect(rc).toBe(1);
  });

  it('a file ONLY this story declares is still this story\'s to fix, whatever owner is named', () => {
    const { rc } = apply('REGI-009a', { target: 'escalate', diagnosis: 'x', escalation: { targetFile: 'scripts/report_costs.py', requiredFix: 'y', ownerStoryId: 'REGI-005-A' } });
    expect(rc).toBe(1);
  });

  it('resolve_escalation sends it to the owner the record names, not the first declarer in array order', () => {
    const { dir } = apply('REGI-009a', classifier('REGI-005-A'));
    const git = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    mkdirSync(join(dir, 'regintel'), { recursive: true }); writeFileSync(join(dir, 'regintel/classifier.py'), 'x = 1\n');
    git('add', 'regintel'); git('commit', '-qm', 'base');
    const r = spawnSync('bash', ['-c', `export PROJECT_ROOT=${JSON.stringify(dir)} PRD_FILE=${JSON.stringify(PRD)} LOG_DIR=${JSON.stringify(dir)} MAX_RETRIES=2
log(){ echo "LOG $*"; }; warning(){ echo "WARN $*"; }; error(){ :; }; success(){ :; }; info(){ :; }
read_story_retry_count(){ echo 0; }; write_story_retry_count(){ :; }; render_or_keep(){ echo "brief"; }
implement_story(){ echo "OWNER-RAN=$1"; return 1; }
${escalationMachinery()}
resolve_escalation REGI-009a`], { encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    expect(out, out).toContain('OWNER-RAN=REGI-005-A');
  });
});
