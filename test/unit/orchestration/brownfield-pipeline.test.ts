/**
 * Brownfield pipeline invariants — verifies that EPAM_BROWNFIELD=1 activates
 * the no-teardown path and codeline discovery, while the greenfield path
 * (EPAM_BROWNFIELD unset or 0) remains completely unchanged.
 *
 * Covers:
 *   BF1  — EPAM_BROWNFIELD switch exists in _run_codeline_loop teardown block
 *   BF2  — greenfield teardown (rm -rf + git init) fires when brownfield=0/unset
 *   BF3  — brownfield path skips rm -rf and git init entirely
 *   BF4  — brownfield path errors if worktree path does not exist
 *   BF5  — brownfield path errors if worktree has no .git directory
 *   BF6  — brownfield path captures JIRA_BASELINE_BRANCH SHA into phase-baseline-sha.txt
 *   BF7  — brownfield baseline defaults to "main" when JIRA_BASELINE_BRANCH unset
 *   BF8  — _run_jira_pipeline validation accepts JIRA_CODELINE_ROOT (not JIRA_WORKTREE_*)
 *           when EPAM_BROWNFIELD=1
 *   BF9  — _run_jira_pipeline validation still requires JIRA_WORKTREE_* when brownfield=0
 *   BF10 — ingest-jira-tickets.sh discovery stage fires only when EPAM_BROWNFIELD=1
 *           AND JIRA_CODELINES is unset
 *   BF11 — ingest discovery stage is a no-op when JIRA_CODELINES is already set (greenfield)
 *   BF12 — ingest discovery stage errors when JIRA_CODELINE_ROOT is absent (brownfield)
 *   BF13 — codeline-discovery.js exists and exports the correct interface
 *   BF14 — codeline-discovery.js dry-run returns the first git repo in the manifest
 *   BF15 — codeline-discovery.js skips non-git directories in JIRA_CODELINE_ROOT
 *   BF16 — codeline-discovery.js validates that returned paths exist and are git repos
 *   BF17 — deriveCodelineName strips generic prefixes (azure, next, react…)
 *   BF18 — metrolinx.env has all required brownfield vars
 *   BF19 — metrolinx.env does NOT declare JIRA_CODELINES or JIRA_WORKTREE_* (discovery-driven)
 *   BF20 — skyscanner .env is unchanged (greenfield regression)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readFileSync, existsSync, mkdtempSync, mkdirSync,
  writeFileSync, rmSync, symlinkSync,
} from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT    = join(__dirname, '../../../');
const ORCH_SH      = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const INGEST_SH    = join(REPO_ROOT, 'orchestrations/scripts/ingest-jira-tickets.sh');
const DISCOVERY_JS = join(REPO_ROOT, 'orchestrations/scripts/lib/codeline-discovery.js');
const SKY_ENV      = join(REPO_ROOT, 'orchestrations/jira/.env');
const MTX_ENV      = join(REPO_ROOT, 'orchestrations/jira/metrolinx.env');
// 2026-08-06: metrolinx.env is now the SECRETS file only; project config lives in
// projects/metrolinx/config.env. BF18 asserts the project SUPPLIES these values —
// which file holds them is not the contract, and duplicating them across both is
// what let ESCALATION_MODEL_HIGH silently drift (glm-5.1 vs MiniMax-M3).
const MTX_CFG      = join(REPO_ROOT, 'orchestrations/projects/metrolinx/config.env');
const NODE_BIN     = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';

const orchSrc   = readFileSync(ORCH_SH,   'utf8');
const ingestSrc = readFileSync(INGEST_SH, 'utf8');

// ─── BF1: EPAM_BROWNFIELD switch in _run_codeline_loop ───────────────────────

describe('BF1: EPAM_BROWNFIELD switch controls teardown in _run_codeline_loop', () => {
  const loopIdx = orchSrc.indexOf('_run_codeline_loop()');
  const block   = orchSrc.slice(loopIdx, loopIdx + 5000);

  it('teardown block is gated on EPAM_BROWNFIELD != 1', () => {
    expect(block).toMatch(/EPAM_BROWNFIELD.*!=.*1|EPAM_BROWNFIELD.*-ne.*1/);
  });

  it('brownfield else branch exists alongside the greenfield if branch', () => {
    const ifIdx   = block.indexOf('EPAM_BROWNFIELD');
    const elseIdx = block.indexOf('else', ifIdx);
    expect(elseIdx).toBeGreaterThan(ifIdx);
  });
});

// ─── BF2: greenfield teardown still fires when brownfield=0 ─────────────────

describe('BF2: greenfield rm -rf + git init inside the EPAM_BROWNFIELD != 1 branch', () => {
  const loopIdx  = orchSrc.indexOf('_run_codeline_loop()');
  const block    = orchSrc.slice(loopIdx, loopIdx + 5000);
  const bfIdx    = block.indexOf('EPAM_BROWNFIELD');
  // Greenfield code is between the if-guard and the first else
  const elseIdx  = block.indexOf('else', bfIdx);
  const gfBlock  = block.slice(bfIdx, elseIdx);

  it('rm -rf is inside the greenfield (EPAM_BROWNFIELD != 1) branch', () => {
    expect(gfBlock).toMatch(/rm -rf/);
  });

  it('git init is inside the greenfield branch', () => {
    expect(gfBlock).toMatch(/git.*init/);
  });
});

// ─── BF3: brownfield path has no rm -rf or git init ─────────────────────────

describe('BF3: brownfield else branch does not call rm -rf or git init', () => {
  // Anchor on the unique brownfield comment — it only appears inside the brownfield else
  const brownfieldAnchor = '── Brownfield: verify the existing repo';
  const anchorIdx = orchSrc.indexOf(brownfieldAnchor);
  // Take a window large enough to include all brownfield logic but not the next greenfield block
  const bfBlock = orchSrc.slice(anchorIdx, anchorIdx + 2500);

  it('brownfield block exists (anchor comment found)', () => {
    expect(anchorIdx).toBeGreaterThan(-1);
  });

  it('brownfield block does not contain rm -rf', () => {
    expect(bfBlock).not.toMatch(/rm -rf/);
  });

  it('brownfield block does not call git -C ... init', () => {
    // git rev-parse is allowed (baseline SHA); git init is not
    expect(bfBlock).not.toMatch(/git.*init/);
  });
});

// ─── BF4 + BF5: brownfield worktree existence checks ────────────────────────

describe('BF4+BF5: brownfield verifies worktree path and .git presence', () => {
  const loopIdx = orchSrc.indexOf('_run_codeline_loop()');
  const block   = orchSrc.slice(loopIdx, loopIdx + 6000);
  const elseIdx = block.indexOf('else', block.indexOf('EPAM_BROWNFIELD'));
  const bfBlock = block.slice(elseIdx, elseIdx + 2500);

  it('checks that the worktree directory exists', () => {
    expect(bfBlock).toMatch(/! -d.*_wt|! -d.*wt/);
  });

  it('errors if worktree does not exist', () => {
    expect(bfBlock).toMatch(/does not exist|worktree.*not.*exist/i);
  });

  it('checks that .git directory is present', () => {
    expect(bfBlock).toMatch(/\.git/);
  });

  it('errors if worktree is not a git repo', () => {
    expect(bfBlock).toMatch(/not a git repo|not.*git.*repository/i);
  });

  it('REAL: brownfield fails with clear error when worktree is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-missing-'));
    try {
      const script = join(dir, 'test.sh');
      writeFileSync(script, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'EPAM_BROWNFIELD=1',
        '_wt="/nonexistent/path/$$"',
        '_cl="test"',
        'if [ "${EPAM_BROWNFIELD:-0}" != "1" ]; then',
        '  echo "greenfield"',
        'else',
        '  if [ ! -d "$_wt" ]; then',
        '    echo "ERROR: Brownfield worktree does not exist: $_wt" >&2',
        '    exit 1',
        '  fi',
        'fi',
      ].join('\n'));
      expect(() => execFileSync('bash', [script], { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }))
        .toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── BF6: baseline SHA capture ───────────────────────────────────────────────

describe('BF6: brownfield captures JIRA_BASELINE_BRANCH SHA into phase-baseline-sha.txt', () => {
  const loopIdx = orchSrc.indexOf('_run_codeline_loop()');
  const block   = orchSrc.slice(loopIdx, loopIdx + 6000);
  const elseIdx = block.indexOf('else', block.indexOf('EPAM_BROWNFIELD'));
  const bfBlock = block.slice(elseIdx, elseIdx + 2500);

  it('reads JIRA_BASELINE_BRANCH in brownfield branch', () => {
    expect(bfBlock).toContain('JIRA_BASELINE_BRANCH');
  });

  it('writes to phase-baseline-sha.txt', () => {
    expect(bfBlock).toContain('phase-baseline-sha.txt');
  });

  it('runs git rev-parse to capture the SHA', () => {
    expect(bfBlock).toMatch(/git.*rev-parse/);
  });
});

// ─── BF7: default baseline branch is "main" ──────────────────────────────────

describe('BF7: JIRA_BASELINE_BRANCH defaults to "main" when unset', () => {
  const loopIdx = orchSrc.indexOf('_run_codeline_loop()');
  const block   = orchSrc.slice(loopIdx, loopIdx + 6000);
  const bfIdx   = block.indexOf('JIRA_BASELINE_BRANCH');
  const snippet = block.slice(bfIdx, bfIdx + 100);

  it('uses ${JIRA_BASELINE_BRANCH:-main} default expansion', () => {
    expect(snippet).toMatch(/JIRA_BASELINE_BRANCH.*:-.*main/);
  });
});

// ─── BF8: _run_jira_pipeline validation — brownfield accepts JIRA_CODELINE_ROOT ─

describe('BF8: brownfield validation requires JIRA_CODELINE_ROOT not JIRA_WORKTREE_*', () => {
  const pipeIdx = orchSrc.indexOf('_run_jira_pipeline()');
  const block   = orchSrc.slice(pipeIdx, pipeIdx + 2000);

  it('JIRA_CODELINE_ROOT is in the validation block', () => {
    expect(block).toContain('JIRA_CODELINE_ROOT');
  });

  it('JIRA_CODELINE_ROOT is only required inside the EPAM_BROWNFIELD=1 branch', () => {
    // The actual if condition: [ "${EPAM_BROWNFIELD:-0}" = "1" ]
    // JIRA_CODELINE_ROOT must appear inside that branch (after the if line)
    const ifIdx   = block.indexOf('[ "${EPAM_BROWNFIELD:-0}" = "1"');
    const rootIdx = block.indexOf('JIRA_CODELINE_ROOT', ifIdx);
    expect(ifIdx).toBeGreaterThan(-1);
    expect(rootIdx).toBeGreaterThan(ifIdx);
  });
});

// ─── BF9: greenfield validation still requires JIRA_WORKTREE_* ──────────────

describe('BF9: greenfield validation still checks JIRA_WORKTREE_* when brownfield=0', () => {
  const pipeIdx = orchSrc.indexOf('_run_jira_pipeline()');
  const block   = orchSrc.slice(pipeIdx, pipeIdx + 2000);

  it('JIRA_WORKTREE_ is still referenced in the validation block', () => {
    expect(block).toContain('JIRA_WORKTREE_');
  });

  it('greenfield worktree check is inside an elif/else branch from EPAM_BROWNFIELD', () => {
    const bfIdx   = block.indexOf('EPAM_BROWNFIELD');
    const elifIdx = block.indexOf('elif', bfIdx);
    const wtIdx   = block.indexOf('JIRA_WORKTREE_', elifIdx);
    expect(elifIdx).toBeGreaterThan(bfIdx);
    expect(wtIdx).toBeGreaterThan(elifIdx);
  });
});

// ─── BF10: ingest discovery stage fires only under correct conditions ─────────

describe('BF10: ingest discovery stage fires only when EPAM_BROWNFIELD=1 and JIRA_CODELINES unset', () => {
  it('discovery block is guarded by EPAM_BROWNFIELD=1', () => {
    expect(ingestSrc).toContain('EPAM_BROWNFIELD');
    const bfIdx   = ingestSrc.indexOf('EPAM_BROWNFIELD.*1|.*1.*EPAM_BROWNFIELD') !== -1
      ? ingestSrc.search(/EPAM_BROWNFIELD.*1|.*1.*EPAM_BROWNFIELD/)
      : ingestSrc.indexOf('EPAM_BROWNFIELD');
    const discIdx = ingestSrc.indexOf('codeline-discovery', bfIdx);
    expect(discIdx).toBeGreaterThan(bfIdx);
  });

  it('discovery block is also guarded by -z JIRA_CODELINES (skip if already set)', () => {
    // Anchor on the actual if condition, not the comment which appears earlier
    const ifLine = 'if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -z "${JIRA_CODELINES:-}"';
    expect(ingestSrc).toContain(ifLine);
  });
});

// ─── BF11: discovery is skipped when JIRA_CODELINES already set (greenfield) ─

describe('BF11: greenfield — discovery stage is a no-op when JIRA_CODELINES is set', () => {
  it('REAL: discovery block does not execute when JIRA_CODELINES is pre-set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-gf-skip-'));
    try {
      const script = join(dir, 'test.sh');
      writeFileSync(script, [
        '#!/usr/bin/env bash',
        'EPAM_BROWNFIELD=1',
        'JIRA_CODELINES=be,fe',   // already set — discovery must be skipped
        '_discovery_ran=0',
        'if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -z "${JIRA_CODELINES:-}" ]; then',
        '  _discovery_ran=1',
        'fi',
        'echo "discovery_ran=$_discovery_ran"',
      ].join('\n'));
      const out = execFileSync('bash', [script], { encoding: 'utf8' });
      expect(out.trim()).toBe('discovery_ran=0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REAL: discovery block runs when EPAM_BROWNFIELD=1 and JIRA_CODELINES is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-disc-runs-'));
    try {
      const script = join(dir, 'test.sh');
      writeFileSync(script, [
        '#!/usr/bin/env bash',
        'EPAM_BROWNFIELD=1',
        'JIRA_CODELINES=""',
        '_discovery_ran=0',
        'if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -z "${JIRA_CODELINES:-}" ]; then',
        '  _discovery_ran=1',
        'fi',
        'echo "discovery_ran=$_discovery_ran"',
      ].join('\n'));
      const out = execFileSync('bash', [script], { encoding: 'utf8' });
      expect(out.trim()).toBe('discovery_ran=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── BF12: ingest errors when JIRA_CODELINE_ROOT absent (brownfield) ─────────

describe('BF12: ingest errors when EPAM_BROWNFIELD=1 but JIRA_CODELINE_ROOT not set', () => {
  it('error message references JIRA_CODELINE_ROOT', () => {
    // The err() call is after the actual if condition, not in the comment block
    const ifLine = 'if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -z "${JIRA_CODELINES:-}"';
    const ifIdx  = ingestSrc.indexOf(ifLine);
    expect(ifIdx).toBeGreaterThan(-1);
    const errIdx = ingestSrc.indexOf('JIRA_CODELINE_ROOT', ifIdx);
    expect(errIdx).toBeGreaterThan(ifIdx);
    const snippet = ingestSrc.slice(errIdx - 50, errIdx + 150);
    expect(snippet).toMatch(/err.*JIRA_CODELINE_ROOT|JIRA_CODELINE_ROOT.*err/s);
  });
});

// ─── BF13: codeline-discovery.js exists with correct interface ───────────────

describe('BF13: codeline-discovery.js exists and has correct interface', () => {
  it('file exists at orchestrations/scripts/lib/codeline-discovery.js', () => {
    expect(existsSync(DISCOVERY_JS)).toBe(true);
  });

  const src = existsSync(DISCOVERY_JS) ? readFileSync(DISCOVERY_JS, 'utf8') : '';

  it('accepts --issues, --root, --out arguments', () => {
    expect(src).toContain('--issues');
    expect(src).toContain('--root');
    expect(src).toContain('--out');
  });

  it('respects --dry-run flag', () => {
    expect(src).toContain('--dry-run');
    expect(src).toContain('DRY_RUN');
  });

  it('output shape has a codelines array', () => {
    expect(src).toContain('"codelines"');
  });

  it('calls ai-run.sh for LLM classification (same pattern as ac-gate.js)', () => {
    expect(src).toContain('AI_RUN_SH');
    expect(src).toContain('ai-run.sh');
  });

  it('validates returned paths exist on disk before writing output', () => {
    expect(src).toContain('existsSync');
    expect(src).toContain('.git');
  });
});

// ─── BF14: dry-run uses scored selection, not alphabetical-first ─────────────
// Bug: old dryRunDiscovery() picked manifest[0] (alphabetically first). When the
// LLM timed out and fell back to dry-run, it selected cx-shared instead of
// azure.commerce.cdts. Fix: scoreRepos() always runs first; selectBestCandidate()
// picks the highest-scored repo. The reason must contain "scored-fallback".

describe('BF14: codeline-discovery.js dry-run uses scored selection', () => {
  it('REAL: dry-run picks highest-scored repo (not first alphabetically)', () => {
    const dir  = mkdtempSync(join(tmpdir(), 'bf-disc-dry-'));
    try {
      const root = join(dir, 'repos');
      mkdirSync(root);

      // z-gotransit (last alphabetically, but with no domain signal)
      const irrelevant = join(root, 'z-gotransit');
      mkdirSync(join(irrelevant, '.git'), { recursive: true });
      writeFileSync(join(irrelevant, 'package.json'), JSON.stringify({ name: 'z-gotransit', description: 'generic transit service' }));

      // azure.commerce.cdts (alphabetically first, has domain signal via description)
      const relevant = join(root, 'azure.commerce.cdts');
      mkdirSync(join(relevant, '.git'), { recursive: true });
      writeFileSync(join(relevant, 'package.json'), JSON.stringify({ name: 'azure.commerce.cdts', description: 'Mozio promo discount commerce service' }));

      const issuesPath = join(dir, 'issues.json');
      writeFileSync(issuesPath, JSON.stringify([{
        jiraKey: 'AMSD-1820',
        title: '[Mozio] The Promo code discount is not shown in email confirmation',
        description: 'Mozio promo discount missing from email.'
      }]));
      const outPath = join(dir, 'discovery.json');

      execFileSync(NODE_BIN, [
        '--require', 'module',
        DISCOVERY_JS,
        '--issues', issuesPath,
        '--root',   root,
        '--out',    outPath,
        '--dry-run',
      ], { encoding: 'utf8', env: { ...process.env, SEMBLE_ENABLED: '0' } });

      const result = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(result.codelines).toHaveLength(1);
      // azure.commerce.cdts has domain signal (mozio/promo/discount); must win
      expect(result.codelines[0].path).toContain('azure.commerce.cdts');
      expect(result.codelines[0].name).toBeTruthy();
      // Reason must say scored-fallback, not "First git repo"
      expect(result.codelines[0].reason).toMatch(/scored-fallback/i);
      expect(result.codelines[0].reason).not.toMatch(/first git repo/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── BF15: non-git directories are skipped ───────────────────────────────────

describe('BF15: codeline-discovery.js skips directories without .git', () => {
  it('REAL: only git repos appear in the manifest', () => {
    const dir  = mkdtempSync(join(tmpdir(), 'bf-disc-git-'));
    try {
      const root = join(dir, 'repos');
      mkdirSync(root);
      // Non-git dir
      mkdirSync(join(root, 'plain-dir'));
      writeFileSync(join(root, 'plain-dir', 'package.json'), '{"name":"plain"}');
      // Git repo
      const gitRepo = join(root, 'real-service');
      mkdirSync(join(gitRepo, '.git'), { recursive: true });
      writeFileSync(join(gitRepo, 'package.json'), '{"name":"real-service"}');

      const issuesPath = join(dir, 'issues.json');
      writeFileSync(issuesPath, JSON.stringify([{ jiraKey: 'T-1', title: 'Test', description: '' }]));
      const outPath = join(dir, 'discovery.json');

      execFileSync(NODE_BIN, [
        DISCOVERY_JS, '--issues', issuesPath, '--root', root, '--out', outPath, '--dry-run',
      ], { encoding: 'utf8' });

      const result = JSON.parse(readFileSync(outPath, 'utf8'));
      // Only the git repo should appear; plain-dir must be skipped
      expect(result.codelines[0].path).toContain('real-service');
      expect(result.codelines[0].path).not.toContain('plain-dir');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── BF16: validation rejects paths that are not real git repos ──────────────

describe('BF16: codeline-discovery.js validation rejects paths without .git', () => {
  const src = existsSync(DISCOVERY_JS) ? readFileSync(DISCOVERY_JS, 'utf8') : '';

  it('validation checks existsSync(path.join(cl.path, .git))', () => {
    expect(src).toMatch(/existsSync.*\.git|\.git.*existsSync/);
  });

  it('validation warns and skips invalid entries (does not throw)', () => {
    expect(src).toContain('warn(');
    expect(src).toMatch(/Skipping codeline/);
  });
});

// ─── BF17: deriveCodelineName strips decoration, keeps identity ──────────────

/**
 * This test used to slice the function's SOURCE TEXT out of codeline-discovery.js
 * and eval it. That stopped testing anything the moment the function moved to its
 * own module: indexOf returned -1, the slice produced garbage, and the failure
 * looked like a behaviour change rather than a test that had lost its subject.
 * It now requires the module, so moving the code again breaks the import loudly.
 *
 * The contract also changed, deliberately. Popping the LAST segment is what made
 * mock1 run 7 name a codeline 'world' — see codeline-ordering.test.ts. Decoration
 * (platform/hosting words, domain suffixes) is dropped; every word that actually
 * identifies the repository is kept.
 */
describe('BF17: deriveCodelineName strips decoration, keeps identity', () => {
  const { deriveCodelineName } = require('../../../orchestrations/scripts/lib/codeline-name.js');

  it('REAL: azure.commerce.cdts → commercecdts', () => {
    // 'azure' is decoration — it appears across the estate and distinguishes
    // nothing. 'commerce' and 'cdts' both identify, so both survive.
    expect(deriveCodelineName('azure.commerce.cdts')).toBe('commercecdts');
  });

  it('REAL: next.gotransit.com → gotransit', () => {
    expect(deriveCodelineName('next.gotransit.com')).toBe('gotransit');
  });
});

// ─── BF18: metrolinx.env has all required brownfield vars ────────────────────

describe('BF18: the metrolinx project supplies required brownfield configuration', () => {
  it('metrolinx.env exists', () => {
    expect(existsSync(MTX_ENV)).toBe(true);
  });

  const mtxSrc = existsSync(MTX_ENV) ? (readFileSync(MTX_ENV, 'utf8') + '\n' + readFileSync(MTX_CFG, 'utf8')) : '';

  it('EPAM_BROWNFIELD=1 is set', () => {
    expect(mtxSrc).toContain('EPAM_BROWNFIELD=1');
  });

  it('JIRA_PIPELINE=1 is set', () => {
    expect(mtxSrc).toContain('JIRA_PIPELINE=1');
  });

  it('JIRA_CODELINE_ROOT is set to a local metrolinx path', () => {
    expect(mtxSrc).toMatch(/JIRA_CODELINE_ROOT=.*metrolinx/);
  });

  it('JIRA_BASELINE_BRANCH=develop is set', () => {
    expect(mtxSrc).toContain('JIRA_BASELINE_BRANCH=develop');
  });

  it('JIRA_URL points to metrolinx.atlassian.net', () => {
    expect(mtxSrc).toContain('metrolinx.atlassian.net');
  });

  it('JIRA_BOARD_ID is empty (agile API 403 on metrolinx; JQL path used instead)', () => {
    expect(mtxSrc).toMatch(/^JIRA_BOARD_ID=\s*$/m);
  });
});

// ─── BF19: metrolinx.env has no hardcoded JIRA_CODELINES or JIRA_WORKTREE_* ─

describe('BF19: metrolinx.env is discovery-driven — no hardcoded codelines', () => {
  const mtxSrc = existsSync(MTX_ENV) ? (readFileSync(MTX_ENV, 'utf8') + '\n' + readFileSync(MTX_CFG, 'utf8')) : '';

  it('JIRA_CODELINES is not declared in metrolinx.env', () => {
    expect(mtxSrc).not.toMatch(/^JIRA_CODELINES=/m);
  });

  it('JIRA_WORKTREE_* is not declared in metrolinx.env', () => {
    expect(mtxSrc).not.toMatch(/^JIRA_WORKTREE_/m);
  });
});

// ─── BF20: skyscanner .env unchanged (greenfield regression) ─────────────────

describe('BF20: skyscanner .env unaffected — greenfield regression guard', () => {
  it('skyscanner .env still exists', () => {
    expect(existsSync(SKY_ENV)).toBe(true);
  });

  const skySrc = existsSync(SKY_ENV) ? readFileSync(SKY_ENV, 'utf8') : '';

  it('JIRA_PIPELINE=1 still set in skyscanner .env', () => {
    expect(skySrc).toContain('JIRA_PIPELINE=1');
  });

  it('EPAM_BROWNFIELD is NOT in skyscanner .env', () => {
    expect(skySrc).not.toContain('EPAM_BROWNFIELD');
  });

  it('JIRA_CODELINES is still declared in skyscanner .env', () => {
    expect(skySrc).toMatch(/^JIRA_CODELINES=/m);
  });

  it('JIRA_WORKTREE_BE still declared in skyscanner .env', () => {
    expect(skySrc).toMatch(/^JIRA_WORKTREE_BE=/m);
  });

  it('skyscanner greenfield teardown (rm -rf) is still in _run_codeline_loop', () => {
    // Greenfield must still rm -rf — verify the guard preserves it
    const loopIdx = orchSrc.indexOf('_run_codeline_loop()');
    const block   = orchSrc.slice(loopIdx, loopIdx + 5000);
    expect(block).toMatch(/rm -rf/);
    expect(block).toMatch(/git.*init/);
  });
});
