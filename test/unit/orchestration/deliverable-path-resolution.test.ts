/**
 * A declared deliverable is a module, not always a filename.
 *
 * Live metrolinx 2026-07-29. All three lanes failed the same way, four hours in:
 *
 *   Story AMSD-2041 is missing 1 declared deliverable(s) in next.upexpress.com:
 *     src/hooks/useContent
 *   Story AMSD-2041 is missing 1 declared deliverable(s) in next.metrolinx.com:
 *     hooks/useContent
 *
 * `src/hooks/useContent.ts` EXISTS in all three repositories. The declared path
 * has no extension, because that is how the module is imported
 * (`from '@/hooks/useContent'`) and the declaration is written by a model
 * reasoning about imports. The check tested `[ ! -s "$check_path" ]` against the
 * literal string, so it demanded a path that can never exist, the agent retried
 * until the watchdog killed it (600s then 900s), and the run burned hours
 * proving a filename wrong.
 *
 * Note the two lanes disagree (`src/hooks/...` vs `hooks/...`), which is the
 * tell that this is generated text rather than a filesystem fact.
 *
 * THE RESOLUTION MUST BE DETERMINED, NOT ASSUMED. Hardcoding `.ts` would fix
 * this repository and break the next one. The rule is: a declared deliverable is
 * satisfied if the literal path exists, OR if exactly one file exists whose path
 * differs only by an extension that this project actually uses. Ambiguity is
 * reported, never guessed — two candidates mean the declaration is unusable and
 * the operator should see that, rather than the check silently picking one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The resolver, bounded by its own definition. */
function resolverSrc(): string {
  const start = SRC.indexOf('_resolve_deliverable_path() {');
  if (start === -1) throw new Error('_resolve_deliverable_path is not defined in claude.sh');
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

/**
 * Run the real resolver against a repo fixture.
 * `files` are created relative to the repo root; `declared` is what the story said.
 */
function resolve(files: string[], declared: string): { path: string; rc: number } {
  const repo = mkdtempSync(join(tmpdir(), 'deliverable-'));
  dirs.push(repo);
  for (const f of files) {
    const p = join(repo, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'export const x = 1;\n');
  }
  const script = join(repo, '_probe.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_ROOT=${JSON.stringify(repo)}
warning() { echo "WARN: $*" >&2; }
${resolverSrc()}
_resolve_deliverable_path "$PROJECT_ROOT/"${JSON.stringify(declared)}
echo "RC=$?"
`);
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000, cwd: repo });
  const out = `${r.stdout || ''}`;
  const rc = Number((out.match(/RC=(\d+)/) || [, '1'])[1]);
  // The resolver speaks absolute paths; compare relative for readability.
  const path = out.split('\n')[0].trim().replace(repo + '/', '');
  return { path, rc };
}

describe('an exact path still wins', () => {
  it('returns the literal path when it exists', () => {
    const r = resolve(['src/hooks/useContent.ts'], 'src/hooks/useContent.ts');
    expect(r.rc).toBe(0);
    expect(r.path).toBe('src/hooks/useContent.ts');
  });

  it('does not invent a file that is absent in any form', () => {
    // A genuinely missing deliverable must still fail — this fix must not turn
    // the check into a rubber stamp.
    expect(resolve(['src/hooks/other.ts'], 'src/hooks/useContent').rc).not.toBe(0);
  });
});

describe('an extensionless module path resolves to the real file', () => {
  it('resolves the exact live failure: src/hooks/useContent -> .ts', () => {
    const r = resolve(['src/hooks/useContent.ts'], 'src/hooks/useContent');
    expect(r.rc, 'the live AMSD-2041 failure is unfixed').toBe(0);
    expect(r.path).toBe('src/hooks/useContent.ts');
  });

  it('works for whatever extension the project actually uses', () => {
    // Determined, not hardcoded: the next project may be .tsx, .js, .mjs, .py.
    for (const ext of ['tsx', 'js', 'jsx', 'mjs', 'py', 'go']) {
      const r = resolve([`src/mod.${ext}`], 'src/mod');
      expect(r.rc, `.${ext} not resolved`).toBe(0);
      expect(r.path).toBe(`src/mod.${ext}`);
    }
  });

  it('resolves a directory module via its index file', () => {
    // `from './hooks/useContent'` may equally mean hooks/useContent/index.ts.
    const r = resolve(['src/hooks/useContent/index.ts'], 'src/hooks/useContent');
    expect(r.rc).toBe(0);
    expect(r.path).toBe('src/hooks/useContent/index.ts');
  });
});

describe('ambiguity is reported, never guessed', () => {
  it('fails when two extensions could satisfy the declaration', () => {
    // Picking one silently would make the gate's verdict depend on glob order.
    // The declaration is unusable and the operator needs to know.
    const r = resolve(['src/mod.ts', 'src/mod.js'], 'src/mod');
    expect(r.rc, 'the resolver guessed between two candidates').not.toBe(0);
  });
});
