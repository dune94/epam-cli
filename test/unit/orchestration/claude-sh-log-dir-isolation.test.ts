/**
 * claude.sh's AUTOMATION_DIR/LOG_DIR resolution is UNCONDITIONAL — no env
 * override respected — so the only way to isolate a sandboxed invocation's
 * logs from the real orchestrations/logs/ is to invoke claude.sh through a
 * DIFFERENT path (a symlinked scripts/ dir) so BASH_SOURCE[0] resolves
 * elsewhere. Found live, 2026-08-01 (writer-sandbox-amsd2041.test.ts): a
 * LOG_DIR/CLAUDE_OUTPUT_DIR env override was silently ignored and every
 * sandbox attempt contaminated the real project's story-failures.jsonl,
 * phase-cost.jsonl, healing-events.jsonl, etc. with sandbox attempts —
 * discovered only because a cross-run self-heal signal ("N prior capability
 * failures") referenced numbers that made no sense for a fresh sandbox run.
 *
 * This proves the FIX deterministically, at zero cost (no LLM calls, no
 * client codeline): extracts the actual, unmodified path-resolution lines
 * from claude.sh (so it stays synced with the real source) and runs them
 * for real, inside a purpose-built probe script placed behind a real
 * symlink — exactly the mechanism writer-sandbox-amsd2041.test.ts's
 * makeSandboxAutomationRoot() depends on.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

// The real, unmodified path-resolution lines (claude.sh:20-25).
function extractPathResolutionLines(): string {
  const start = src.indexOf('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"');
  const end = src.indexOf('\n', src.indexOf('LOG_DIR="$AUTOMATION_DIR/logs"'));
  expect(start, 'SCRIPT_DIR line not found — has claude.sh moved/changed shape?').toBeGreaterThan(-1);
  expect(end, 'LOG_DIR line not found').toBeGreaterThan(start);
  return src.slice(start, end);
}
const pathLines = extractPathResolutionLines();

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A probe script containing the REAL extracted lines, placed at <root>/real-scripts/probe.sh,
 *  with <root>/scripts symlinked to real-scripts — mirrors makeSandboxAutomationRoot() exactly
 *  (real scripts dir standing in for the real orchestrations/scripts, symlinked from a
 *  sandbox-named entry point) without touching the real repo at all.
 */
function makeProbe(): { root: string; symlinkedProbe: string } {
  const root = mkdtempSync(join(tmpdir(), 'log-dir-isolation-'));
  dirs.push(root);
  const realScripts = join(root, 'real-scripts');
  mkdirSync(realScripts);
  const probePath = join(realScripts, 'probe.sh');
  writeFileSync(probePath, `#!/usr/bin/env bash\nset -e\n${pathLines}\necho "$LOG_DIR"\n`);
  chmodSync(probePath, 0o755);
  const symlinked = join(root, 'scripts');
  symlinkSync(realScripts, symlinked);
  mkdirSync(join(root, 'logs'));
  return { root, symlinkedProbe: join(symlinked, 'probe.sh') };
}

describe('claude.sh LOG_DIR isolation — real symlink resolution (zero-cost, no LLM)', () => {
  it('LOG_DIR is UNCONDITIONAL — a caller-supplied LOG_DIR env var is silently ignored', () => {
    const { symlinkedProbe } = makeProbe();
    const out = execFileSync('bash', ['-c', `LOG_DIR=/should/be/ignored bash "${symlinkedProbe}"`], { encoding: 'utf8' }).trim();
    expect(out).not.toBe('/should/be/ignored');
  });

  it('invoking through a symlinked scripts/ dir makes LOG_DIR resolve to the sandbox side, not the resolved real-scripts target\'s parent', () => {
    const { root, symlinkedProbe } = makeProbe();
    const out = execFileSync('bash', [symlinkedProbe], { encoding: 'utf8' }).trim();
    // AUTOMATION_DIR = dirname(SCRIPT_DIR). Invoked via <root>/scripts/probe.sh, bash's default
    // (non-physical) `pwd` after `cd` into the symlinked dir reports the LOGICAL path taken —
    // <root>/scripts, not <root>/real-scripts — so LOG_DIR must land at <root>/logs.
    expect(out).toBe(join(root, 'logs'));
  });

  it('never resolves through the REAL underlying target directory name ("real-scripts")', () => {
    const { symlinkedProbe } = makeProbe();
    const out = execFileSync('bash', [symlinkedProbe], { encoding: 'utf8' }).trim();
    expect(out).not.toContain('real-scripts');
  });

  it('the real orchestrations/logs/ directory in THIS repo is never referenced', () => {
    const { symlinkedProbe } = makeProbe();
    const out = execFileSync('bash', [symlinkedProbe], { encoding: 'utf8' }).trim();
    expect(out.startsWith(REPO_ROOT)).toBe(false);
  });
});
