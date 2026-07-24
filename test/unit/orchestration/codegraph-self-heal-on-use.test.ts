/**
 * fetchCodeGraphContext() self-heal at point of use — REAL execution of the
 * actual, unmodified exported function, real `codegraph` binary, real
 * fixture repo.
 *
 * Built 2026-07-23 after a real Metrolinx run: CodeGraph preflight reported
 * "31 already indexed" (a genuinely valid index existed at that moment),
 * but by the time the spec pass actually called fetchCodeGraphContext ~9
 * minutes later, the index was gone (only .codegraph/.gitignore remained).
 * The exact deletion mechanism was not conclusively identified (git clean
 * -fd and git reset --hard were both ruled out directly) — Step 3's
 * skill-assessment agent has broad, unlogged Bash access and is the most
 * plausible remaining source, but this fix does not depend on knowing the
 * cause: fetchCodeGraphContext now re-indexes on demand whenever the index
 * is missing/invalid at the moment it's actually needed, so CodeGraph's
 * contribution can never silently and permanently degrade to null
 * regardless of what deleted it or when.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const specModeRunner = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { fetchCodeGraphContext } = specModeRunner;
const codegraphContext = require('../../../orchestrations/scripts/lib/codegraph-context.js');

function codegraphAvailable(): boolean {
  try { execSync('command -v codegraph', { stdio: 'ignore' }); return true; } catch { return false; }
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.CODEGRAPH_ENABLED;
  delete process.env.PROJECT_ROOT;
});

function makeFixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'codegraph-selfheal-'));
  cleanupDirs.push(repo);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export function doThing() { return 1; }\n');
  return repo;
}

describe('fetchCodeGraphContext self-heal (real codegraph binary, real fixture)', () => {
  it('re-indexes on demand when .codegraph/ is entirely missing at the point of use', () => {
    if (!codegraphAvailable()) return;
    const repo = makeFixtureRepo();
    process.env.CODEGRAPH_ENABLED = '1';
    process.env.PROJECT_ROOT = repo;
    expect(codegraphContext.isCodeGraphIndexed(repo)).toBe(false);

    const story = { title: 'Fix doThing behavior', codeline: undefined };
    fetchCodeGraphContext(story);

    expect(codegraphContext.isCodeGraphIndexed(repo)).toBe(true);
  }, 30000);

  it('reproduces the exact live failure and self-heals: .codegraph/ with only .gitignore, db missing', () => {
    if (!codegraphAvailable()) return;
    const repo = makeFixtureRepo();
    process.env.CODEGRAPH_ENABLED = '1';
    process.env.PROJECT_ROOT = repo;
    const cgDir = join(repo, '.codegraph');
    mkdirSync(cgDir, { recursive: true });
    writeFileSync(join(cgDir, '.gitignore'), 'codegraph.db\n');
    expect(codegraphContext.isCodeGraphIndexed(repo)).toBe(false);

    const story = { title: 'Fix doThing behavior' };
    fetchCodeGraphContext(story);

    expect(codegraphContext.isCodeGraphIndexed(repo)).toBe(true);
    expect(existsSync(join(cgDir, 'codegraph.db'))).toBe(true);
  }, 30000);

  it('does not attempt to re-index when CODEGRAPH_ENABLED is unset (returns null cleanly)', () => {
    const repo = makeFixtureRepo();
    delete process.env.CODEGRAPH_ENABLED;
    process.env.PROJECT_ROOT = repo;
    const story = { title: 'Fix doThing behavior' };
    expect(fetchCodeGraphContext(story)).toBeNull();
    expect(existsSync(join(repo, '.codegraph'))).toBe(false);
  });
});
