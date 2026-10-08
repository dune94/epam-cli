/**
 * A CAPTURED SCOPE CARRIES NO LOG LINE.
 *
 * Rehearsal 2026-10-08 (AMSD-2974, metrolinx — plan part "none", nothing changed): story_outputs_files returns its
 * scope on stdout and logged "no writer-output manifest … falling back to the baseline diff" on stdout too. The
 * reviewer captured it, counted the warning as "1 changed file", reviewed a story that changed nothing, refused for
 * want of a writer rung, and looped to its cycle limit.
 *
 * EXECUTED: lib/story-outputs.sh story_outputs_files, with the stdout logger the orchestrator loads.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/story-outputs.sh');
const d = mkdtempSync(join(tmpdir(), 'scope-'));
afterAll(() => rmSync(d, { recursive: true, force: true }));
const repo = join(d, 'repo'); const logs = join(d, 'logs'); mkdirSync(logs);
const git = (...a: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).stdout.trim();
spawnSync('git', ['init', '-q', '-b', 'develop', repo]); writeFileSync(join(repo, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-qm', 'base');
writeFileSync(join(logs, 'phase-baseline-sha.txt'), git('rev-parse', 'HEAD'));
const scope = () => spawnSync('bash', ['-c', `warning(){ echo "[WARN] $*"; }; log(){ echo "$*"; }
SCRIPT_DIR=${JSON.stringify(join(__dirname, '../../../orchestrations/scripts'))}; PHASE=core
. ${JSON.stringify(LIB)}; out=$(story_outputs_files ${JSON.stringify(repo)} ${JSON.stringify(logs)}); printf 'SCOPE=[%s]' "$out"`], { encoding: 'utf8' }).stdout;

describe('the scope a caller captures is files only', () => {
  it('nothing changed, no manifest: the scope is empty — the fallback warning is not part of it', () => {
    expect(scope()).toMatch(/SCOPE=\[\]$/);
  });
  it('a change: the scope is that file, and nothing else', () => {
    writeFileSync(join(repo, 'b.ts'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'fix');
    expect(scope()).toMatch(/SCOPE=\[b\.ts\]$/);
  });
});
