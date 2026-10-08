/**
 * A PHASE THAT CHANGED NOTHING GIVES THE REVIEW-RANGER NOTHING TO JUDGE.
 *
 * Rehearsal 2026-10-08 (AMSD-2974 on a copy of the real estate): gotransit's plan part was exactly "none", its
 * branch clean, the writer rightly not run — and the review-ranger's evidence template refused an empty diff, the
 * ranger exited 1 and the gates failed the codeline. The code reviewer already holds this rule ("changed nothing vs
 * baseline — nothing to review"); the ranger judges the same diff. The codeline is still proved by the gates that
 * build and test it.
 *
 * EXECUTED: lib/gates-testing.sh phase_changed_nothing on a real repository.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/gates-testing.sh');
const d = mkdtempSync(join(tmpdir(), 'nothing-'));
afterAll(() => rmSync(d, { recursive: true, force: true }));
const git = (...a: string[]) => spawnSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).stdout.trim();
git('init', '-q', '-b', 'develop'); writeFileSync(join(d, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-qm', 'base');
const base = git('rev-parse', 'HEAD');
const nothing = (ref: string) => spawnSync('bash', ['-c', `log(){ :; }; warning(){ :; }; error(){ :; }; info(){ :; }; success(){ :; }; step_emit(){ :; }
. ${JSON.stringify(LIB)} >/dev/null 2>&1; phase_changed_nothing ${JSON.stringify(d)} ${JSON.stringify(ref)} && echo NOTHING || echo CHANGED`], { encoding: 'utf8' }).stdout.trim();

describe('what the phase changed against its baseline', () => {
  it('no commit since the baseline: nothing', () => expect(nothing(`${base}..HEAD`)).toBe('NOTHING'));
  it('a commit since the baseline: changed', () => {
    writeFileSync(join(d, 'a.txt'), 'b\n'); git('commit', '-qam', 'fix');
    expect(nothing(`${base}..HEAD`)).toBe('CHANGED');
  });
});
