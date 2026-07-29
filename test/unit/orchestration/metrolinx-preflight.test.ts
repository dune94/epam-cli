/**
 * Pre-flight: run the REAL codelines through the steps that have actually failed.
 *
 * Every defect on 2026-07-28/29 was found by spending a live run to find it —
 * scope resolving to one bogus lane, an assessment with no tool budget, a
 * deliverable check that demanded an extensionless path, a health probe that
 * condemned working trees. Each cost 20 minutes to hours, and each was
 * detectable in seconds against the codelines sitting on this disk.
 *
 * So this executes the real shell functions against the real repositories, in
 * the order a run hits them. It is not a substitute for a run: it cannot tell
 * you an agent will write good code. It tells you the run will not die on
 * plumbing again, which is the only way this project has failed so far.
 *
 * Skips itself when the codelines are absent, so it is inert on any machine
 * without the client repos, and reads only — it never writes to a client repo.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const CONFIG = join(REPO_ROOT, 'orchestrations/projects/metrolinx/config.env');

function cfg(key: string): string {
  const m = readFileSync(CONFIG, 'utf8').match(new RegExp(`^${key}="?([^"\\n]*)"?$`, 'm'));
  return m ? m[1] : '';
}

const CODELINES = cfg('JIRA_CODELINES').split(',').map((s) => s.trim()).filter(Boolean)
  .map((name) => ({ name, path: cfg(`JIRA_WORKTREE_${name.toUpperCase()}`) }));

const HAVE_CODELINES = CODELINES.length > 0 && CODELINES.every((c) => c.path && existsSync(c.path));

/**
 * Extract a shell function's text HERE, in JS. The first version of this
 * embedded `$(awk ...)` in the probe script, which makes bash EXECUTE the
 * function's text as a command instead of defining it — so every codeline
 * probed as broken and it looked like a real finding. A harness that fails
 * closed is worse than none: it manufactures gaps.
 */
function fnText(scriptPath: string, fnName: string): string {
  const src = readFileSync(scriptPath, 'utf8');
  const start = src.indexOf(`${fnName}() {`);
  if (start === -1) throw new Error(`${fnName} not found in ${scriptPath}`);
  const end = src.indexOf('\n}', start);
  if (end === -1) throw new Error(`${fnName} has no closing brace`);
  return src.slice(start, end + 2);
}

/** Execute a named shell function from a pipeline script against real inputs. */
function runFn(scriptPath: string, fnName: string, invocation: string, extra = ''): { rc: number; out: string } {
  const d = mkdtempSync(join(tmpdir(), 'preflight-'));
  const probe = join(d, 'p.sh');
  writeFileSync(probe, `#!/usr/bin/env bash
set -uo pipefail
warning(){ echo "WARN: $*"; }
log(){ echo "LOG: $*"; }
info(){ :; }
error(){ echo "ERROR: $*"; }
success(){ :; }
detect_and_install_dependencies(){ echo "REPAIR_WOULD_RUN"; return 1; }
${extra}
${fnText(scriptPath, fnName)}
${invocation}
echo "RC=$?"
`);
  const r = spawnSync('bash', [probe], { encoding: 'utf8', timeout: 120000 });
  rmSync(d, { recursive: true, force: true });
  const out = (r.stdout || '') + (r.stderr || '');
  return { rc: Number((out.match(/RC=(\d+)/) || [, '1'])[1]), out };
}

describe.skipIf(!HAVE_CODELINES)('metrolinx pre-flight — real codelines, real functions', () => {
  it('the pinned scope resolves to codelines that exist', () => {
    expect(CODELINES.length, 'no codelines pinned').toBeGreaterThan(1);
    for (const c of CODELINES) {
      expect(existsSync(c.path), `${c.name} -> ${c.path} does not exist`).toBe(true);
      expect(existsSync(join(c.path, '.git')), `${c.name} is not a git repo`).toBe(true);
    }
  });

  it('every codeline passes the health probe', () => {
    // The live Step 5 halt: the probe picked `escodegen`, which rejects
    // --version, and condemned all three working trees.
    for (const c of CODELINES) {
      const r = runFn(ORCH, 'ensure_node_modules_healthy',
        `ensure_node_modules_healthy ${JSON.stringify(c.path)} "$(command -v node)" ""`);
      expect(r.rc, `${c.name} probes as unhealthy — Step 5 will halt the run:\n${r.out}`).toBe(0);
      expect(r.out, `${c.name} would trigger a dependency repair`).not.toMatch(/REPAIR_WOULD_RUN/);
    }
  });

  it('every codeline declares a test runner that exists and runs', () => {
    // What the probe now depends on, checked directly so a failure names the
    // cause rather than surfacing as "unhealthy".
    for (const c of CODELINES) {
      const pkg = JSON.parse(readFileSync(join(c.path, 'package.json'), 'utf8'));
      const declared = String(pkg.scripts?.test || '');
      expect(declared, `${c.name} declares no scripts.test`).toBeTruthy();
      const runner = declared.split(' ')[0];
      const bin = join(c.path, 'node_modules/.bin', runner);
      expect(existsSync(bin), `${c.name}: declared runner '${runner}' is not installed`).toBe(true);
    }
  });

  it('the declared deliverable resolves in every codeline', () => {
    // The four-hour overnight failure: the story declares
    // "src/hooks/useContent" (a module specifier, no extension) and the check
    // demanded that literal path. Probe the resolver against each real repo.
    const declared = 'src/hooks/useContent';
    for (const c of CODELINES) {
      const r = runFn(CLAUDE_SH, '_resolve_deliverable_path',
        `PROJECT_ROOT=${JSON.stringify(c.path)}\n_resolve_deliverable_path ${JSON.stringify(join(c.path, declared))}`);
      expect(r.rc,
        `${c.name}: '${declared}' does not resolve — Step 8 will report a missing ` +
        `deliverable and retry into the watchdog:\n${r.out}`).toBe(0);
      expect(r.out, `${c.name}: resolved to something without a file extension`)
        .toMatch(/useContent\.[a-z]+/);
    }
  });

  it('no codeline has uncommitted work that a run would trip over', () => {
    for (const c of CODELINES) {
      const dirty = spawnSync('git', ['-C', c.path, 'status', '--porcelain', '--untracked-files=no'],
        { encoding: 'utf8' }).stdout.trim();
      expect(dirty, `${c.name} has uncommitted changes:\n${dirty}`).toBe('');
    }
  });
});

describe('the pre-flight itself is wired correctly', () => {
  it('reads the codeline set from the pinned config', () => {
    // If this returns nothing the suite above skips silently, which would hide
    // exactly the failures it exists to catch.
    expect(CODELINES.length, 'pre-flight found no codelines in config.env').toBeGreaterThan(1);
  });
});
