/**
 * A PATH CHECK THAT RESOLVES LITERALLY REJECTS TRUE CLAIMS.
 *
 * `ungrounded_paths` joins a cited path to the repo root and calls isfile. Live 2026-08-09 the
 * pre-phase assessment proposed, correctly:
 *
 *     "The ContentstackContext must be a React context provider that wraps the app in
 *      _app.tsx and provides the Contentstack client and live preview state via useContext"
 *
 * and it was rejected — "it cites file(s) that do not exist: _app.tsx". That file exists in all
 * three codelines at src/pages/_app.tsx. A true rule about where the provider belongs was
 * silently discarded, and the agent lost guidance it had earned.
 *
 * The check exists for a real reason and must keep working. Live AMSD-2041 run 4 an assessment
 * told the security gate to only report on "src/cli.ts, src/api.ts, src/utils.ts, src/index.ts"
 * — none of which existed — which is an instruction to suppress every finding it could make.
 *
 * THE DISTINCTION IS WHETHER THE CITATION IS SPECIFIC:
 *
 *   src/cli.ts     names a directory, so it is a claim about a LOCATION. It must resolve
 *                  exactly, or it is fabricated.
 *   _app.tsx       names a file and no location. It is underspecified, not false — and it is
 *                  grounded if a file of that name exists anywhere in the tree.
 *
 * That keeps the fabricated-allowlist rejection intact (those citations carried directories)
 * while letting a true bare-filename reference through.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A repo shaped like the real codelines: the file exists, nested. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'paths-')); dirs.push(dir);
  mkdirSync(join(dir, 'src', 'pages'), { recursive: true });
  mkdirSync(join(dir, 'src', 'services'), { recursive: true });
  writeFileSync(join(dir, 'src', 'pages', '_app.tsx'), 'export default function App() {}\n');
  writeFileSync(join(dir, 'src', 'services', 'contentstack.ts'), 'export const x = 1;\n');
  return dir;
}

/** Calls the real python helper. */
function ungrounded(rule: string, repoRoot: string): string[] {
  const out = execFileSync('python3', ['-c',
    `import sys, json; sys.path.insert(0, ${JSON.stringify(LIB)});\n` +
    `from assessment_apply import ungrounded_paths\n` +
    `print(json.dumps(sorted(ungrounded_paths(sys.argv[1], sys.argv[2]))))`,
    rule, repoRoot], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

describe('the harness is real', () => {
  it('the fixture repo contains the nested file', () => {
    const r = repo();
    expect(ungrounded('see src/pages/_app.tsx', r)).toEqual([]);
  });

  it('and a fabricated path is still caught — the check is not disabled', () => {
    expect(ungrounded('only report on src/nowhere.ts', repo())).toEqual(['src/nowhere.ts']);
  });
});

describe('THE DEFECT: a bare filename that exists is not a fabrication', () => {
  it('the exact rule that was discarded is accepted', () => {
    expect(
      ungrounded('the provider wraps the app in _app.tsx via useContext', repo()),
      'a true rule about where the provider belongs was thrown away',
    ).toEqual([]);
  });

  it('a bare filename that exists nowhere is still rejected', () => {
    expect(ungrounded('configure it in _nonexistent.tsx', repo())).toEqual(['_nonexistent.tsx']);
  });
});

describe('a citation WITH a directory is still a specific claim', () => {
  it('the live fabricated allowlist is still rejected in full', () => {
    // AMSD-2041 run 4: none of these existed, and the gate was told to suppress everything else.
    const rule = 'Only report findings on: src/cli.ts, src/api.ts, src/utils.ts, src/index.ts.';
    expect(ungrounded(rule, repo()).sort())
      .toEqual(['src/api.ts', 'src/cli.ts', 'src/index.ts', 'src/utils.ts']);
  });

  it('a right filename in the wrong directory is rejected — location is the claim', () => {
    expect(ungrounded('edit src/wrong/_app.tsx', repo())).toEqual(['src/wrong/_app.tsx']);
  });
});

describe('rules that cite nothing are untouched', () => {
  it('guidance naming no file is never rejected', () => {
    expect(ungrounded('Prefer composition over inheritance in this codebase.', repo())).toEqual([]);
  });

  it('an empty rule does not throw', () => {
    expect(ungrounded('', repo())).toEqual([]);
  });

  it('no repo root means no verdict rather than a guess', () => {
    expect(ungrounded('see src/nowhere.ts', '')).toEqual([]);
  });
});
