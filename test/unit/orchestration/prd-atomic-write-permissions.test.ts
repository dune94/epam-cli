/**
 * Found live 2026-07-14: the monitor dashboard (docker `epam-cli-agent-
 * monitor-1`, nginx on port 8092) started returning "Cannot load prd.json"
 * (HTTP 403) MID-RUN, despite the PRD file being readable moments earlier.
 * Root cause: `mktemp` creates temp files as mode 0600 by default; several
 * PRD atomic-write call sites in run-agent-orchestration.sh do
 * `tmp_prd=$(mktemp); jq ... > "$tmp_prd" && mv "$tmp_prd" "$PRD_FILE"` --
 * `mv` PRESERVES the source file's permissions rather than the destination
 * directory's expected mode, so every one of these writes silently
 * downgraded the live PRD file to owner-only. nginx's WORKER processes
 * (which actually serve requests) run as an unprivileged `nginx` user, not
 * root, so they lost read access the moment any of these functions ran.
 *
 * Fix: `chmod 644 "$tmp_prd"` immediately after every `mktemp` call and
 * before the write, so the permission survives the `mv`. This test proves
 * each of the 5 affected functions leaves the PRD file group/world-readable
 * after a real write cycle -- a bug invisible to any test that only checks
 * file CONTENT, not permissions (every existing PRD-mutation test in this
 * suite only asserted on jq output).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');
// record_story_actual_cost now lives in lib/story-guards.sh (2026-07-14) —
// a single shared implementation sourced by both run-agent-orchestration.sh
// (main lane) and claude.sh (worktree lanes).
const GUARDS_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/story-guards.sh');
const guardsSrc = readFileSync(GUARDS_LIB, 'utf8');

function extractFunctionBodyBraceCounted(name: string, src: string = orchSrc): string {
  const start = src.indexOf(`${name}()`);
  if (start === -1) throw new Error(`Function ${name} not found`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

function permBits(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

// The RESET_STORIES block (top-level script logic, not a function -- runs
// at the start of EVERY `--reset` invocation, making it the highest-
// frequency PRD write in the pipeline) can't use the brace-counted function
// extractor. Anchor-extract the exact source text instead, so this test
// tracks the real file verbatim rather than a hand-copied re-creation that
// could silently drift from what actually ships.
function extractResetStoriesBlock(): string {
  const startAnchor = 'log "Resetting story completed flags in $PRD_FILE..."';
  const endAnchor = 'success "Stories reset to pending (all phases)"\n    fi';
  const start = orchSrc.indexOf(startAnchor);
  if (start === -1) throw new Error('RESET_STORIES start anchor not found');
  const endAnchorIdx = orchSrc.indexOf(endAnchor, start);
  if (endAnchorIdx === -1) throw new Error('RESET_STORIES end anchor not found');
  return orchSrc.slice(start, endAnchorIdx + endAnchor.length);
}

describe('PRD atomic-write permission regression — REAL execution', () => {
  it('hot_swap_story_model_if_unstable leaves the PRD file mode 644, not mktemp\'s default 600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-perm-hotswap-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({ stories: [{ id: 'SKY-999', model: 'old-model', aiProvider: 'openrouter' }] }));
      chmodSync(prdFile, 0o644);
      // hot_swap resolves its ladder tier through _resolve_ladder_tier, which reads the
      // archetype's declared ladder. An extracted function needs what the script provides.
      const fnBody = [
        extractFunctionBodyBraceCounted('_story_archetype_ladder'),
        extractFunctionBodyBraceCounted('_resolve_ladder_tier'),
        extractFunctionBodyBraceCounted('hot_swap_story_model_if_unstable'),
      ].join('\n');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `log() { :; }`,
          `warning() { :; }`,
          fnBody,
          // A configured ladder entry is required to reach the write path at
          // all (an empty ladder short-circuits the function before ever
          // touching the PRD file) -- this is what makes the test genuinely
          // exercise the mktemp/chmod/mv sequence rather than trivially
          // passing on an untouched, already-644 file.
          // The tier order is DECLARED data (lib/model-ladders.sh exports it from the settings
          // file). Without it a tier resolves to nothing and no ladder is found — which is the
          // point: the engine holds no ordering of its own, so a fixture must declare one.
          `EPAM_MODEL_LADDER_TIER_ORDER="medium" EPAM_MODEL_LADDER_MEDIUM="old-model=new-model" MAIN_PRD_FILE="${prdFile}" PRD_FILE="${prdFile}" hot_swap_story_model_if_unstable SKY-999`,
        ].join('\n'),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      // Proves the write path genuinely ran (not a silent early-return
      // leaving the original untouched-644 file, which would make the
      // permission assertion below pass trivially without exercising
      // anything).
      const updated = JSON.parse(readFileSync(prdFile, 'utf8'));
      expect(updated.stories[0].model).toBe('new-model');
      expect(permBits(prdFile)).toBe('644');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maybe_upgrade_model_for_tc_density leaves the PRD file mode 644', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-perm-tcdensity-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({ stories: [{ id: 'SKY-999', model: 'old-model', aiProvider: 'openrouter' }] }));
      chmodSync(prdFile, 0o644);
      const fnBody = extractFunctionBodyBraceCounted('maybe_upgrade_model_for_tc_density');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `warning() { :; }`,
          `success() { :; }`,
          fnBody,
          `ORCH_UPGRADE_MODEL=new-model PRD_FILE="${prdFile}" maybe_upgrade_model_for_tc_density SKY-999 20`,
        ].join('\n'),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(permBits(prdFile)).toBe('644');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is domain-agnostic: even starting from a fresh mktemp-default-600 handoff, the final file is 644, not 600', () => {
    // Directly proves the chmod ordering (mktemp -> chmod -> write -> mv)
    // survives redirection into the already-chmod'd temp file, independent
    // of any one caller function's surrounding logic.
    const dir = mkdtempSync(join(tmpdir(), 'prd-perm-direct-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({ stories: [] }));
      chmodSync(prdFile, 0o644);
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `prd_target="${prdFile}"`,
          'tmp_prd=$(mktemp)',
          'chmod 644 "$tmp_prd" 2>/dev/null',
          'jq \'.stories += [{"id":"X"}]\' "$prd_target" > "$tmp_prd" && mv "$tmp_prd" "$prd_target"',
        ].join('\n'),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(permBits(prdFile)).toBe('644');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Found live 2026-07-14 (a THIRD time -- after the first pass fixed 5
  // sites, and a second pass fixed the RESET_STORIES block below): this is
  // record_story_actual_cost(), which writes the PRD after EVERY SINGLE
  // story completion -- the highest-frequency PRD write of all, which is
  // why the bug kept recurring live even after two rounds of fixes. It used
  // generic $prd/$tmp variable names, so earlier greps searching
  // specifically for PRD_FILE/prd_target as the destination never matched
  // it at all.
  it('record_story_actual_cost leaves the PRD file mode 644 after every story completion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-perm-actualcost-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({ stories: [{ id: 'SKY-999' }] }));
      chmodSync(prdFile, 0o644);
      const logFile = join(dir, 'story.log');
      writeFileSync(logFile, JSON.stringify({ cost_usd: 0.0123 }) + '\n');
      const fnBody = extractFunctionBodyBraceCounted('record_story_actual_cost', guardsSrc);
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [fnBody, `MAIN_PRD_FILE="${prdFile}" PRD_FILE="${prdFile}" record_story_actual_cost SKY-999 "${logFile}"`].join(
          '\n',
        ),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const updated = JSON.parse(readFileSync(prdFile, 'utf8'));
      expect(updated.stories[0].actualCost).toBe(0.0123);
      expect(permBits(prdFile)).toBe('644');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Found live 2026-07-14 (a SECOND time, after the first pass above already
  // fixed 5 mktemp sites): this block -- the RESET_STORIES flag-reset run at
  // the start of every `--reset` invocation -- was missed the first pass and
  // kept re-breaking the dashboard on every relaunch. It's top-level script
  // logic, not a function, so it needed its own anchor-based extraction
  // rather than the brace-counted one above.
  it('RESET_STORIES phase-scoped reset leaves the PRD file mode 644', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-perm-reset-phase-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(
        prdFile,
        JSON.stringify({
          implementationOrder: { core: ['SKY-999'] },
          stories: [{ id: 'SKY-999', completed: true, status: 'completed' }],
        }),
      );
      chmodSync(prdFile, 0o644);
      const block = extractResetStoriesBlock();
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `log() { :; }`,
          `success() { :; }`,
          `RESET_STORIES=true`,
          `PHASE=core`,
          `PRD_FILE="${prdFile}"`,
          block,
        ].join('\n'),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const updated = JSON.parse(readFileSync(prdFile, 'utf8'));
      expect(updated.stories[0].status).toBe('pending');
      expect(updated.stories[0].completed).toBe(false);
      expect(permBits(prdFile)).toBe('644');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('RESET_STORIES global reset (no PHASE set) leaves the PRD file mode 644', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-perm-reset-global-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({ stories: [{ id: 'SKY-999', completed: true, status: 'failed' }] }));
      chmodSync(prdFile, 0o644);
      const block = extractResetStoriesBlock();
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        ['#!/usr/bin/env bash', `log() { :; }`, `success() { :; }`, `RESET_STORIES=true`, `PRD_FILE="${prdFile}"`, block].join(
          '\n',
        ),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const updated = JSON.parse(readFileSync(prdFile, 'utf8'));
      expect(updated.stories[0].status).toBe('pending');
      expect(permBits(prdFile)).toBe('644');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
