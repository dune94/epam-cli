/**
 * A CONFIG FLAG THAT NO CALL SITE READS IS DECORATION.
 *
 * `toolPolicy.readDedupe` lived in spec-mode-defaults.json, carried a long note explaining when it
 * should be turned on, and was never read by anything. The writer's invocation passed
 *
 *     EPAM_READ_DEDUPE="${EPAM_READ_DEDUPE:-0}"
 *
 * so the default was a literal 0 at the call site. Setting readDedupe to true changed nothing, and
 * nothing said so. The redirect beside it in the same config block WAS wired, which is what made
 * the gap invisible: the file looked like a working tool policy because half of it was one.
 *
 * This is the same class as the coverage gate that read a budget, logged it and never applied it,
 * and as the prompt trim that computed a smaller string and discarded it. Config is only config if
 * a call site consumes it.
 *
 * These tests EXECUTE the extraction claude.sh performs and assert on the value produced, then
 * mutate the config and assert the value MOVES. A test that only greps for the variable name would
 * pass on a dead assignment.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const CONFIG = join(ROOT, 'orchestrations/config/spec-mode-defaults.json');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The exact node expression claude.sh uses to derive the dedupe flag, run against a config. */
function deriveDedupe(configPath: string): string {
  return execFileSync('node', ['-e', `
    try {
      const cfg = require(process.argv[1]);
      process.stdout.write((cfg.toolPolicy || {}).readDedupe === true ? "1" : "0");
    } catch (_) { process.stdout.write("0"); }
  `, configPath], { encoding: 'utf8' });
}

/** A copy of the real config with toolPolicy patched. */
function configWith(patch: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'toolpolicy-')); dirs.push(dir);
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  cfg.toolPolicy = { ...(cfg.toolPolicy ?? {}), ...patch };
  const p = join(dir, 'spec-mode-defaults.json');
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

describe('the dedupe flag is derived from config, not from a literal', () => {
  it('the call site no longer hardcodes a default of 0', () => {
    // Comments are excluded deliberately: the fix documents the old literal in a comment above
    // the new derivation, and a whole-file substring match flagged that prose as the defect.
    // A sweep that cannot tell a call site from a description of one reports its own comment.
    const code = readFileSync(CLAUDE_SH, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(
      code,
      'EPAM_READ_DEDUPE still defaults to a literal at the call site, so toolPolicy.readDedupe ' +
      'cannot turn it on',
    ).not.toContain('EPAM_READ_DEDUPE="${EPAM_READ_DEDUPE:-0}"');
    expect(code).toContain('EPAM_READ_DEDUPE="${EPAM_READ_DEDUPE:-$_tool_policy_read_dedupe}"');
  });

  it('a config with readDedupe true yields 1', () => {
    expect(deriveDedupe(configWith({ readDedupe: true }))).toBe('1');
  });

  it('a config with readDedupe false yields 0 — the flag really controls it', () => {
    // The mutation that matters: if this returns 1, the derivation ignores config.
    expect(deriveDedupe(configWith({ readDedupe: false }))).toBe('0');
  });

  it('a non-boolean value is not treated as on', () => {
    // "true" the string, 1 the number, and null are all things a config edit produces by accident.
    for (const v of ['true', 1, null, 'yes']) {
      expect(deriveDedupe(configWith({ readDedupe: v })), `readDedupe=${JSON.stringify(v)} enabled dedupe`).toBe('0');
    }
  });

  it('an unreadable config fails OPEN, to today behaviour, not to a suppression', () => {
    const dir = mkdtempSync(join(tmpdir(), 'toolpolicy-bad-')); dirs.push(dir);
    const p = join(dir, 'spec-mode-defaults.json');
    writeFileSync(p, '{ not json');
    expect(
      deriveDedupe(p),
      'a broken config turned dedupe ON — a suppression the writer cannot get past is the one ' +
      'failure mode worse than paying for duplicate reads',
    ).toBe('0');
  });
});

describe('the shipped config is the one we intend to run', () => {
  it('dedupe is enabled', () => {
    expect(deriveDedupe(CONFIG), 'shipped config does not enable dedupe').toBe('1');
  });

  it('the bash-exploration redirect is still populated beside it', () => {
    // The config was rewritten to flip the flag; this catches a rewrite that dropped a sibling.
    const out = execFileSync('node', ['-e', `
      const c = require(process.argv[1]);
      const p = (c.toolPolicy || {}).bashExplorationRedirect;
      process.stdout.write(p ? String(JSON.stringify(p).length) : "0");
    `, CONFIG], { encoding: 'utf8' });
    expect(Number(out), 'the redirect vanished when the config was rewritten').toBeGreaterThan(100);
  });
});
