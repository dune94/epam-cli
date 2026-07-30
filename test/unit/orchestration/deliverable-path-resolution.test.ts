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

describe('the implementation prompt resolves through the same function', () => {
  // The deliverable CHECK resolving correctly is necessary but not sufficient:
  // live 2026-07-30, the injection loop's own `[ -f "$abs_f" ]` failed on the
  // wrong-case declaration FIRST, so the prompt told the agent "WRITE this
  // file first" for a file that already existed under a different case — the
  // agent complied and created a duplicate. Fixing only the post-hoc verifier
  // would leave that phantom-file creation happening every time.
  it('build_implementation_prompt resolves abs_f before the existence check', () => {
    const i = SRC.indexOf('while IFS= read -r f; do');
    expect(i, 'the injection loop is gone — this is anchored to nothing').toBeGreaterThan(-1);
    const block = SRC.slice(i, i + 2200);
    expect(block, 'the injection loop still checks the RAW declared path — a wrong ' +
      'case or extension still reads as missing and the agent is told to WRITE a ' +
      'file that already exists')
      .toMatch(/_resolve_deliverable_path "\$abs_f"/);
  });

  it('the resolution happens before the write-first branch, not after', () => {
    const i = SRC.indexOf('while IFS= read -r f; do');
    const resolveIdx = SRC.indexOf('_resolve_deliverable_path "$abs_f"', i);
    const checkIdx = SRC.indexOf('[ "$_inject_content" = "1" ] && [ -f "$abs_f" ]', i);
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(-1);
    expect(resolveIdx, 'the existence check runs before the resolution — the fix has no effect')
      .toBeLessThan(checkIdx);
  });
});

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

describe('a declaration with the WRONG extension still resolves', () => {
  it('resolves .tsx declared against a .ts file — seen live 2026-07-29', () => {
    // The story declared src/context/ContentstackContext.tsx; the repository
    // holds ContentstackContext.ts. Globbing "<path>.*" only helps an
    // EXTENSIONLESS declaration, so the deliverable read as missing and the
    // agent was failed for work it may well have done.
    const r = resolve(['src/context/ContentstackContext.ts'], 'src/context/ContentstackContext.tsx');
    expect(r.rc, 'a wrong extension in the declaration still reads as missing').toBe(0);
    expect(r.path).toBe('src/context/ContentstackContext.ts');
  });

  it('prefers the exact file when both extensions exist', () => {
    // If the declared path is real, it wins — no stem-matching required.
    const r = resolve(['src/m.ts', 'src/m.tsx'], 'src/m.tsx');
    expect(r.rc).toBe(0);
    expect(r.path).toBe('src/m.tsx');
  });

  it('still fails when no file matches the stem in any extension', () => {
    expect(resolve(['src/other.ts'], 'src/missing.tsx').rc).not.toBe(0);
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

describe('a declaration with the WRONG CASE still resolves', () => {
  // Live AMSD-2041 2026-07-30, metrolinx. The real file is
  // src/context/contentstackContext.tsx (lowercase c). The detective's own
  // transcript never once shows it querying the exact case — it names
  // "ContentstackContext.tsx" (capital C, the conventional PascalCase a model
  // defaults to for a React Context) in both its final answer and the ONLY
  // occurrence of the string anywhere in its log.
  //
  // On this case-SENSITIVE filesystem the consequence cascaded: the injection
  // loop's `[ -f "$abs_f" ]` check failed on the wrong-case path, so the
  // implementation prompt told the agent "WRITE this file first" for a file
  // that already existed under a different case. The agent complied — git
  // then showed one file ADDED (capital C) and the real one DELETED (git's
  // rename-detection reading the old file as removed once nothing referenced
  // it) — 7 attempts, same failure, real spend each time.
  it('resolves the exact live failure: wrong case, same extension', () => {
    const r = resolve(['src/context/contentstackContext.tsx'], 'src/context/ContentstackContext.tsx');
    expect(r.rc, 'a case-only mismatch still reads as missing — this is the live failure').toBe(0);
    expect(r.path).toBe('src/context/contentstackContext.tsx');
  });

  it('resolves wrong case AND wrong extension together', () => {
    const r = resolve(['src/context/contentstackContext.ts'], 'src/context/ContentstackContext.tsx');
    expect(r.rc).toBe(0);
    expect(r.path).toBe('src/context/contentstackContext.ts');
  });

  it('prefers the exact-case file when both casings exist', () => {
    // If the declared casing is real, it wins — no case-folding required, and
    // no risk of silently picking the wrong one of two real files.
    const r = resolve(['src/Mod.ts', 'src/mod.ts'], 'src/Mod.ts');
    expect(r.rc).toBe(0);
    expect(r.path).toBe('src/Mod.ts');
  });

  it('is ambiguous, not guessed, when two case variants both exist', () => {
    const r = resolve(['src/Mod.ts', 'src/mod.ts'], 'src/mod.ts'.replace('mod', 'MOD'));
    expect(r.rc, 'two real files differing only by case were silently collapsed to one')
      .not.toBe(0);
  });

  it('still fails when no case variant exists either', () => {
    expect(resolve(['src/other.ts'], 'src/Missing.ts').rc).not.toBe(0);
  });

  it('does not match a same-named file in a DIFFERENT directory', () => {
    // Case-insensitivity must stay scoped to the declared directory — matching
    // anywhere in the repo would silently redirect a genuinely wrong path to
    // an unrelated file of the same name.
    const r = resolve(['src/other/ContentstackContext.tsx'], 'src/context/ContentstackContext.tsx');
    expect(r.rc, 'matched a file outside the declared directory').not.toBe(0);
  });
});
