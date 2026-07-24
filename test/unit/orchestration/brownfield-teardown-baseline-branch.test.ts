/**
 * brownfield-preflight-reset.sh must reset a codeline to the BASELINE BRANCH
 * (JIRA_BASELINE_BRANCH, e.g. "develop"), NOT to the accumulating verified-
 * baseline marker.
 *
 * Found live 2026-07-24 (AMSD-1820): the marker records the last SHA that passed
 * story_tsc_gate. Once a run COMMITTED a fix that passed the gate, that fix
 * BECAME the marker — so "reset to the last verified baseline" reset to the
 * previous fix, and every re-run of the same story built ON TOP of it. The
 * detective then saw already-fixed code (named getDispatchLineItemKey instead of
 * the original parseDispatchLineItemKey fix) and the whole run was invalid — it
 * wasn't fixing the original bug from scratch. This violated the predictable-
 * teardown mandate (reset to pre-run state every time).
 *
 * Real git repos, real script execution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/brownfield-preflight-reset.sh');

let repo: string;
let stateDir: string;
const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'bf-teardown-repo-'));
  stateDir = mkdtempSync(join(tmpdir(), 'bf-teardown-state-'));
  git(['init', '-q', '-b', 'develop']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  // Baseline (develop): the clean, original-bug state.
  writeFileSync(join(repo, 'src.ts'), 'const x = lineItem.id === discount.lineItemId;\n');
  git(['add', '-A']); git(['commit', '-q', '-m', 'baseline (original bug)']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function run(env: Record<string, string>): string {
  return execFileSync('bash', [SCRIPT, repo], {
    encoding: 'utf8',
    env: { ...process.env, EPAM_BROWNFIELD_STATE_DIR: stateDir, ...env },
  });
}
function markerPath(): string {
  const key = createHash('md5').update(repo).digest('hex');
  return join(stateDir, `${key}.sha`);
}

describe('brownfield teardown resets to the baseline branch, not the accumulated fix', () => {
  it('discards a prior-run fix committed on top of develop (the live AMSD-1820 bug)', () => {
    const developSha = git(['rev-parse', 'HEAD']);
    // Simulate a prior run: the fix lives on a SEPARATE AI-<story> branch (as in
    // production), develop stays at the baseline; the marker is pinned to the fix.
    git(['checkout', '-q', '-b', 'AI-AMSD-1820']);
    writeFileSync(join(repo, 'src.ts'), 'const x = parseDispatchLineItemKey(lineItem.id).id === discount.lineItemId;\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'story: complete AMSD-1820 (the fix)']);
    const fixSha = git(['rev-parse', 'HEAD']);
    expect(fixSha).not.toBe(developSha);
    writeFileSync(markerPath(), fixSha + '\n');

    run({ JIRA_BASELINE_BRANCH: 'develop' });

    // Reset back to develop — the fix commit is gone, original bug restored.
    expect(git(['rev-parse', 'HEAD'])).toBe(developSha);
    expect(readFileSync(join(repo, 'src.ts'), 'utf8')).not.toContain('parseDispatchLineItemKey');
    // Marker refreshed to develop so it can never re-accumulate the fix.
    expect(readFileSync(markerPath(), 'utf8').trim()).toBe(developSha);
  });

  it('is a no-op when already at develop with a clean tree', () => {
    const developSha = git(['rev-parse', 'HEAD']);
    const out = run({ JIRA_BASELINE_BRANCH: 'develop' });
    expect(out).toMatch(/already at baseline branch develop/);
    expect(git(['rev-parse', 'HEAD'])).toBe(developSha);
  });

  it('discards a DIRTY working tree (uncommitted work from a killed run)', () => {
    const developSha = git(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'src.ts'), 'garbage from a crashed run\n');
    run({ JIRA_BASELINE_BRANCH: 'develop' });
    expect(git(['rev-parse', 'HEAD'])).toBe(developSha);
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('falls back to the verified marker when the baseline branch is absent', () => {
    // No JIRA_BASELINE_BRANCH, marker present but at HEAD → nothing-to-do path (no throw).
    const sha = git(['rev-parse', 'HEAD']);
    writeFileSync(markerPath(), sha + '\n');
    const out = run({ JIRA_BASELINE_BRANCH: '' });
    expect(out).toMatch(/nothing to do|leaving as-is/);
  });
});

describe('record_brownfield_verified_baseline pins the marker to the baseline branch, never a fix', () => {
  const GUARDS = join(__dirname, '../../../orchestrations/scripts/lib/story-guards.sh');
  it('records the develop SHA even when HEAD is a fix commit on an AI branch', () => {
    const developSha = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '-b', 'AI-X']);
    writeFileSync(join(repo, 'src.ts'), 'the fix\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'fix']);
    const fixSha = git(['rev-parse', 'HEAD']);
    expect(fixSha).not.toBe(developSha);

    execFileSync('bash', ['-c', `source ${GUARDS}; record_brownfield_verified_baseline`], {
      env: { ...process.env, EPAM_BROWNFIELD: '1', PROJECT_ROOT: repo, JIRA_BASELINE_BRANCH: 'develop', EPAM_BROWNFIELD_STATE_DIR: stateDir },
      encoding: 'utf8',
    });
    // The marker must be develop, NOT the fix — so the next run can never build on it.
    expect(readFileSync(markerPath(), 'utf8').trim()).toBe(developSha);
    expect(readFileSync(markerPath(), 'utf8').trim()).not.toBe(fixSha);
  });
});
