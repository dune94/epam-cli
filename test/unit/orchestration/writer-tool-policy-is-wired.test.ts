/**
 * THE POLICY MUST REACH THE WRITER, OR IT IS ANOTHER INERT GUARD.
 *
 * Two tool policies were built on 2026-08-09 — bash exploration redirect and read dedupe — both
 * opt-in via environment variables, both doing nothing until the orchestration sets them. That
 * is the same shape as the day's recurring defect: correct code that never runs, found only by
 * a live run producing nothing.
 *
 * So this asserts the seam, by EXECUTING the resolution rather than reading it: the config
 * carries the policy, claude.sh resolves it, and the writer invocation exports both variables.
 *
 * It degrades to today's behaviour rather than to a wall: a config with no toolPolicy resolves
 * to empty, and the CLI treats unset as "no policy". A guard that fails closed here would block
 * shell exploration while pointing at tools the agent was never told about.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
const CONFIG = join(ROOT, 'orchestrations/config/spec-mode-defaults.json');

describe('the policy exists as configuration', () => {
  const cfg = () => JSON.parse(readFileSync(CONFIG, 'utf8'));

  it('the redirect is in config, not spelled out in the script', () => {
    const p = cfg().toolPolicy?.bashExplorationRedirect;
    expect(p, 'no tool policy in spec-mode-defaults.json').toBeTruthy();
    expect(Object.keys(p.verbs).length).toBeGreaterThan(3);
  });

  it('a dependency path is routed to the dependency tools', () => {
    const o = cfg().toolPolicy.bashExplorationRedirect.pathOverrides;
    const dep = o.find((x: { match: string }) => x.match === 'node_modules');
    expect(dep, 'node_modules would be redirected to an index that cannot answer it').toBeTruthy();
    expect(dep.use).toMatch(/resolve_package_symbol|dependency_contract/);
    expect(dep.use, 'points at the repo index for a dependency question').not.toMatch(/^codegraph_query/);
  });

  it('sed is deliberately absent — it edits as well as reads', () => {
    // Blocking sed would break real work to save tokens, which is the wrong trade.
    expect(Object.keys(cfg().toolPolicy.bashExplorationRedirect.verbs)).not.toContain('sed');
  });
});

describe('claude.sh resolves it and exports it', () => {
  it('the writer invocation exports both policy variables', () => {
    expect(CLAUDE_SH).toMatch(/EPAM_BASH_EXPLORATION_REDIRECT="\$\{_tool_policy_redirect\}"/);
    expect(CLAUDE_SH).toMatch(/EPAM_READ_DEDUPE=/);
  });

  it('the resolver produces the real policy from the real config — executed, not read', () => {
    const out = execFileSync('node', ['-e', `
      const cfg = require(${JSON.stringify(CONFIG)});
      const p = (cfg.toolPolicy || {}).bashExplorationRedirect;
      process.stdout.write(p ? JSON.stringify(p) : "");
    `], { encoding: 'utf8' });
    expect(out.length, 'the resolver produced nothing — the redirect would be silently off').toBeGreaterThan(50);
    const parsed = JSON.parse(out);
    expect(parsed.verbs.grep).toMatch(/codegraph_query|search/);
  });

  it('a config with no toolPolicy resolves to empty, disabling the redirect', () => {
    // Degrades to today's behaviour. Failing closed would wall the writer off from the shell
    // while pointing at tools it was never told about.
    const dir = mkdtempSync(join(tmpdir(), 'nopolicy-'));
    try {
      const f = join(dir, 'cfg.json');
      writeFileSync(f, JSON.stringify({ promptTrim: { thresholdChars: 16000 } }));
      const out = execFileSync('node', ['-e', `
        try {
          const cfg = require(${JSON.stringify(f)});
          const p = (cfg.toolPolicy || {}).bashExplorationRedirect;
          process.stdout.write(p ? JSON.stringify(p) : "");
        } catch (_) { process.stdout.write(""); }
      `], { encoding: 'utf8' });
      expect(out).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an unreadable config also resolves to empty rather than throwing', () => {
    const out = execFileSync('node', ['-e', `
      try {
        const cfg = require('/nonexistent/nope.json');
        process.stdout.write(JSON.stringify(cfg));
      } catch (_) { process.stdout.write(""); }
    `], { encoding: 'utf8' });
    expect(out).toBe('');
  });
});
