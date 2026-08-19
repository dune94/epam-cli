/**
 * If the pipeline prescribes an existing helper, the change must actually use it.
 *
 * Live metrolinx 2026-07-26, run 5. The detective was right: it found the true
 * fix site, quoted a real broken line, and named a real helper —
 *
 *   {"helper":"getDispatchLineItemKey","fixVerified":true,"evidenceVerified":true,
 *    "fix":"...a prefix match that accounts for the return-trip key suffix
 *           appended by getDispatchLineItemKey..."}
 *
 * The implementer then wrote this:
 *
 *   - (lineItem) => lineItem.id === discount.lineItemId,
 *   + (lineItem) => lineItem.id === discount.lineItemId
 *                   || lineItem.id.startsWith(discount.lineItemId + '-'),
 *
 * The separator in that repository is `#`, not `-` — `dispatch-line-item-key.ts`
 * declares `const DIVIDER = '#'`. So `"ORDER123#return".startsWith("ORDER123-")`
 * is false, the added clause never matches, and the bug is entirely unfixed.
 * The helper appeared ZERO times in the change.
 *
 * That is the whole failure: an agent hand-rolled string surgery against a
 * format it guessed, when the repo already contained a parser for exactly that
 * format and the pipeline had already told it so. Reusing the helper makes the
 * separator impossible to get wrong, because the helper owns it.
 *
 * So: when a helper is named in the prescription AND verified to exist in the
 * repo, its absence from the change is a retryable failure. This is the same
 * shape as the detective's own evidence gate — check the claim against the
 * code rather than trusting that instructions were followed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = require('node:fs').readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const m = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm').exec(claudeSrc);
  if (!m) throw new Error(`No function definition found for ${name}()`);
  return claudeSrc.slice(m.index, claudeSrc.indexOf('\n}', m.index) + 2);
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A repo at a baseline commit, plus whatever the "agent" then wrote. */
function fixture(opts: { helper: string; fixVerified?: boolean; change: string; fixText?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'helper-used-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo });
  git('init', '--quiet', '--initial-branch=develop');
  git('config', 'user.email', 't@t.com');
  git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'src/keys.ts'),
    `const DIVIDER = '#';\nexport function ${opts.helper}(id: string) { return id.split(DIVIDER)[0]; }\n`);
  writeFileSync(join(repo, 'src/match.ts'), 'export const m = (a: string, b: string) => a === b;\n');
  git('add', '-A');
  git('commit', '-m', 'baseline', '--quiet');
  const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  writeFileSync(join(repo, 'src/match.ts'), opts.change);
  git('add', '-A');
  git('commit', '-m', 'story: fix', '--quiet');

  const logDir = join(root, 'logs');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), baseline + '\n');

  const prd = join(root, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    stories: [{
      id: 'S-1',
      fixSiteAnalysis: [{
        file: 'src/match.ts', helper: opts.helper,
        fixVerified: opts.fixVerified !== false,
        fix: opts.fixText ?? `use ${opts.helper} to normalise the key before comparing`,
      }],
    }],
  }));
  return { repo, logDir, prd };
}

function run(fx: { repo: string; logDir: string; prd: string }) {
  const script = join(fx.logDir, 'drive.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `PROJECT_ROOT=${JSON.stringify(fx.repo)}`,
    `LOG_DIR=${JSON.stringify(fx.logDir)}`,
    `PRD_FILE=${JSON.stringify(fx.prd)}`,
    `MAIN_PRD_FILE=${JSON.stringify(fx.prd)}`,
    'EPAM_BROWNFIELD=1',
    'JIRA_BASELINE_BRANCH=develop',
    'warning() { echo "WARNING: $*"; }',
    'error()   { echo "ERROR: $*"; }',
    'success() { echo "SUCCESS: $*"; }',
    // All three, not just the gate: it delegates to _change_duplicates_owned_format, and an
    // unlifted dependency is command-not-found (127) — non-zero — so every helper reads as
    // "missing" and the suite silently tests the wrong thing.
    extractFunctionBody('_helper_module_separators'),
    extractFunctionBody('_change_duplicates_owned_format'),
    extractFunctionBody('verify_prescribed_helper_used'),
    'verify_prescribed_helper_used "S-1"',
    'echo "RC=$?"',
    'echo "FLAG=${DETERMINISTIC_CHECK_FAILURE:-0}"',
    'echo "KEY=${STORY_REJECTION_KEY:-}"',
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
  const out = (r.stdout || '') + (r.stderr || '');
  return {
    rc: parseInt((out.match(/RC=(\d+)/) || [, '-1'])[1], 10),
    flag: parseInt((out.match(/FLAG=(\d+)/) || [, '-1'])[1], 10),
    key: (out.match(/KEY=(.*)/) || [, ''])[1],
    out,
  };
}

describe('a prescribed, existing helper must appear in the change', () => {
  it('ADVISES on the live run-5 change — hand-rolled matching, helper unused', () => {
    const fx = fixture({
      helper: 'getDispatchLineItemKey',
      change: "export const m = (a: string, b: string) => a === b || a.startsWith(b + '-');\n",
    });
    const { rc, flag, key, out } = run(fx);
    // THE REQUIREMENT CHANGED, 2026-08-19. This gate used to veto. Proven against run artefacts:
    // gotransit shipped AMSD-2041 successfully (e780a8b7, 9 files, +379) with ZERO occurrences of
    // two helpers metrolinx's prd.json marks fixVerified for the SAME ticket — so the veto rejects
    // working code. Worse, verify_story_deliverables sets invoke_success=false on its failure,
    // which SILENTLY short-circuits the repo's own lint gate at the next call site: the veto
    // suppressed lint on every attempt it fired.
    //
    // It must still SAY the helper is unused — that information is worth having — and decide
    // nothing.
    // The fixture reproduces run-5 exactly: keys.ts declares DIVIDER='#' and the change invents
    // '-'. That is DUPLICATION of a format the helper owns, so it must be rejected — this is the
    // defect the gate exists for. Absence alone is NOT rejected; see the sibling test below and
    // helper-gate-judged-by-real-diffs.test.ts, which replays gotransit's shipped code.
    expect(out, 'the rejection must name the helper that owns the format').toMatch(/getDispatchLineItemKey/);
    expect(rc, 'the hand-rolled separator went unchallenged').toBe(1);
    expect(flag, 'a retryable finding must reach the next attempt').toBe(1);
    expect(key, 'no rejection key — an identical repeat cannot escalate').toMatch(/helper-duplication/);
  });

  it('accepts a change that uses the helper', () => {
    const fx = fixture({
      helper: 'getDispatchLineItemKey',
      change: "import { getDispatchLineItemKey } from './keys';\n" +
              'export const m = (a: string, b: string) => getDispatchLineItemKey(a) === b;\n',
    });
    expect(run(fx).rc, 'a correct change was rejected').toBe(0);
  });

  it('says WHY, naming the helper and the guessed alternative', () => {
    const fx = fixture({
      helper: 'getDispatchLineItemKey',
      change: "export const m = (a: string, b: string) => a === b || a.startsWith(b + '-');\n",
    });
    expect(run(fx).out.length, 'the rejection is not actionable').toBeGreaterThan(60);
  });

  it('is a per-attempt WARNING, not a terminal error', () => {
    // Same contract as the other deliverable verdicts: returning 1 sends the
    // story back through the retry ladder, and a later attempt routinely wins.
    const fx = fixture({
      helper: 'getDispatchLineItemKey',
      change: "export const m = (a: string, b: string) => a === b || a.startsWith(b + '-');\n",
    });
    const line = run(fx).out.split('\n').find(l => /helper/i.test(l)) ?? '';
    expect(line, 'a retryable verdict logged as ERROR reads as a dead run').toMatch(/^WARNING:/);
  });

  it('stays silent when no helper was prescribed', () => {
    const fx = fixture({ helper: '', change: 'export const m = (a: string) => a;\n' });
    expect(run(fx).rc).toBe(0);
  });

  it('stays silent when the prescribed helper does not exist in the repo', () => {
    // fixVerified=false means the detective may have hallucinated it; demanding
    // its use would force the agent to import something imaginary.
    const fx = fixture({
      helper: 'imaginaryHelper', fixVerified: false,
      // Must differ from the baseline, or there is nothing to commit and the
      // fixture — not the check — is what fails.
      change: 'export const m = (a: string, b: string) => a.trim() === b.trim();\n',
    });
    expect(run(fx).rc).toBe(0);
  });

  it('does not fire on greenfield', () => {
    const fx = fixture({
      helper: 'getDispatchLineItemKey',
      change: "export const m = (a: string, b: string) => a === b || a.startsWith(b + '-');\n",
    });
    const script = join(fx.logDir, 'gf.sh');
    writeFileSync(script, [
      '#!/usr/bin/env bash',
      `PROJECT_ROOT=${JSON.stringify(fx.repo)}`,
      `LOG_DIR=${JSON.stringify(fx.logDir)}`,
      `PRD_FILE=${JSON.stringify(fx.prd)}`,
      `MAIN_PRD_FILE=${JSON.stringify(fx.prd)}`,
      'EPAM_BROWNFIELD=0',
      'warning() { echo "WARNING: $*"; }',
      'error()   { echo "ERROR: $*"; }',
      'success() { echo "SUCCESS: $*"; }',
      // All three, not just the gate: it delegates to _change_duplicates_owned_format, and an
      // unlifted dependency is command-not-found (127) — non-zero — so every helper reads as
      // "missing" and the suite silently tests the wrong thing.
      extractFunctionBody('_helper_module_separators'),
      extractFunctionBody('_change_duplicates_owned_format'),
      extractFunctionBody('verify_prescribed_helper_used'),
      'verify_prescribed_helper_used "S-1"',
      'echo "RC=$?"',
    ].join('\n'));
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect((r.stdout || '').match(/RC=(\d+)/)?.[1]).toBe('0');
  });
});

describe('the story loop enforces it', () => {
  it('verify_story_deliverables consults the check', () => {
    expect(claudeSrc, 'the check exists but nothing calls it')
      .toMatch(/verify_prescribed_helper_used\s+"\$story_id"/);
  });
});
