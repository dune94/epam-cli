/**
 * TWO DISCOVERY HANDLERS THAT REPLACED HARDCODED LISTS, AND HAD NO TEST.
 *
 * Each exists because a hand-written list in shell was wrong for any codeline that was not Node, and
 * each failure was SILENT — the wrong answer looked exactly like a correct one:
 *
 *   testable-source.js: the writer decided testability with `*.ts|*.tsx|*.js|...) return 0`, so on a
 *   Python, Go, Rust, Java or Ruby codeline NO file was ever testable. `_choose_target` found no
 *   candidate and the writer skipped, reported as "nothing sensible to test" — indistinguishable
 *   from a correct decision. Bug-reproduction tests silently never happened there.
 *
 *   repo-exclude-patterns.js: two shell files carried lists that had drifted, and between them
 *   described one ecosystem. On a Rust codeline whose target/ was not gitignored the build tree was
 *   STAGED INTO THE CUSTOMER'S REPOSITORY, and the same directory was counted as thousands of
 *   uncommitted files, which set issues=1 and killed the phase.
 *
 * So the cases that matter are the non-Node ones.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const H = join(__dirname, '../../../orchestrations/scripts/lib/handlers');
const NODE = process.execPath;

function run(script: string, args: string[], cwd?: string) {
  const r = spawnSync(NODE, [join(H, script), ...args], {
    encoding: 'utf8', timeout: 60_000, cwd: cwd || process.cwd(),
  });
  return {
    code: r.status ?? -1,
    lines: (r.stdout ?? '').split('\n').filter(Boolean),
    err: r.stderr ?? '',
  };
}

/** A codeline that DECLARES its source extensions, the way a real one does. */
function codeline(exts: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'codeline-'));
  mkdirSync(join(dir, '.epam'), { recursive: true });
  writeFileSync(join(dir, '.epam/dependency-check.json'),
    JSON.stringify({ scanFileExtensions: exts }));
  return dir;
}

describe('testable-source answers from what the codeline declares', () => {
  it('a PYTHON codeline finds its .py files testable — the case the hardcoded list could not reach', () => {
    const root = codeline(['.py']);
    const out = run('testable-source.js', [root, 'src/thing.py', 'README.md']);
    expect(out.lines, 'a python file was not testable, so the writer would skip and call it "nothing to test"')
      .toContain('src/thing.py');
    expect(out.lines).not.toContain('README.md');
  }, 90_000);

  it.each([['.go', 'src/main.go'], ['.rs', 'src/lib.rs'], ['.java', 'src/A.java'], ['.rb', 'app/a.rb']])(
    'and so does a %s codeline', (ext, file) => {
      const root = codeline([ext]);
      expect(run('testable-source.js', [root, file]).lines).toContain(file);
    }, 90_000);

  it('a file whose extension the codeline does NOT declare is not testable', () => {
    const root = codeline(['.py']);
    const out = run('testable-source.js', [root, 'src/thing.ts', 'src/thing.py']);
    expect(out.lines).toEqual(['src/thing.py']);
  }, 90_000);

  it('documentation, config and assets are excluded by the positive rule alone', () => {
    // The old exclusion list named .md, .txt, .json, .yml, .toml, .png, .svg, .css — every one of
    // which fails the positive rule once that rule is grounded in a declaration. Those entries were
    // compensating for a positive rule that was not.
    const root = codeline(['.ts']);
    const out = run('testable-source.js', [root,
      'a.md', 'b.txt', 'c.json', 'd.yml', 'e.toml', 'f.png', 'g.svg', 'h.css', 'i.ts']);
    expect(out.lines).toEqual(['i.ts']);
  }, 90_000);

  it('input ORDER is preserved — the caller picks a target by position', () => {
    const root = codeline(['.ts']);
    const out = run('testable-source.js', [root, 'z.ts', 'a.ts', 'm.ts']);
    expect(out.lines).toEqual(['z.ts', 'a.ts', 'm.ts']);
  }, 90_000);

  it('a codeline with NO .epam declaration falls back to the ecosystem it CARRIES', () => {
    // Codeline-first is right, but a codeline that has not been given a declaration is the NORMAL
    // case: the live metrolinx checkout carries .epam/verification.json and .epam/settings.json and
    // no dependency-check.json at all. Stopping at the codeline would have replaced a Node-only
    // defect with a nothing-works one.
    const dir = mkdtempSync(join(tmpdir(), 'codeline-'));
    writeFileSync(join(dir, 'requirements.txt'), 'requests==2.0\n');
    const out = run('testable-source.js', [dir, 'src/thing.py', 'src/thing.ts', 'README.md']);
    expect(out.lines, 'a python repo carrying requirements.txt found no testable python file')
      .toContain('src/thing.py');
    expect(out.lines).not.toContain('README.md');
  }, 90_000);

  it("and the codeline's OWN declaration outranks the ecosystem it carries", () => {
    // A repository that declares its source extensions knows better than any provider manifest.
    const dir = mkdtempSync(join(tmpdir(), 'codeline-'));
    writeFileSync(join(dir, 'requirements.txt'), 'requests==2.0\n');
    mkdirSync(join(dir, '.epam'), { recursive: true });
    writeFileSync(join(dir, '.epam/dependency-check.json'),
      JSON.stringify({ scanFileExtensions: ['.ts'] }));
    const out = run('testable-source.js', [dir, 'src/thing.py', 'src/thing.ts']);
    expect(out.lines, "the provider's manifest overrode the codeline's own declaration")
      .toEqual(['src/thing.ts']);
  }, 90_000);

  it('no paths at all is an empty answer, not an error', () => {
    const root = codeline(['.ts']);
    const out = run('testable-source.js', [root]);
    expect(out.code).toBe(0);
    expect(out.lines).toEqual([]);
  }, 90_000);
});

describe('repo-exclude-patterns gives every caller the same answer', () => {
  it.each(['pathspec', 'glob', 'regex', 'diff'])('%s form produces output', (form) => {
    const out = run('repo-exclude-patterns.js', [form]);
    expect(out.code, out.err).toBe(0);
    expect(out.lines.length, `the ${form} form produced nothing at all`).toBeGreaterThan(0);
  }, 90_000);

  it('every directory is emitted in BOTH top-level and nested form', () => {
    // `:!*​/node_modules/*` alone does not match a top-level node_modules, and the top-level form
    // alone does not match a nested one. A caller needs both or the exclusion has a hole.
    const out = run('repo-exclude-patterns.js', ['pathspec']);
    const joined = out.lines.join('\n');
    const nested = out.lines.filter((l) => l.includes('*/')).length;
    expect(nested, 'nothing was emitted in the nested form').toBeGreaterThan(0);
    expect(joined).toMatch(/node_modules/);
  }, 90_000);

  it('DIFF is deliberately wider than PATHSPEC — staging and reviewing are different questions', () => {
    // A lockfile must still be STAGED: a real dependency change belongs in the commit. It must not
    // be REVIEWED — machine-generated, often thousands of lines, and it would consume the
    // reviewer's whole budget before reaching the code the change is about.
    const pathspec = run('repo-exclude-patterns.js', ['pathspec']).lines;
    const diff = run('repo-exclude-patterns.js', ['diff']).lines;
    expect(diff.length, 'diff is not wider than pathspec, so a lockfile reaches the reviewer')
      .toBeGreaterThan(pathspec.length);
    expect(diff.join('\n'), 'no lockfile is excluded from review').toMatch(/lock/i);
    expect(pathspec.join('\n'), 'a lockfile was excluded from STAGING, so a real dependency '
      + 'change would never be committed').not.toMatch(/package-lock|yarn\.lock|Cargo\.lock/);
  }, 90_000);

  it('the regex form is ONE expression, and it actually matches an excluded path', () => {
    const out = run('repo-exclude-patterns.js', ['regex']);
    expect(out.lines.length).toBe(1);
    const re = new RegExp(out.lines[0]);
    expect(re.test('node_modules/x/index.js'), 'the regex misses a nested exclusion').toBe(true);
    expect(re.test('src/app/service.ts'), 'the regex excludes real source').toBe(false);
  }, 90_000);

  it('an unknown form is refused rather than answered with a default', () => {
    const out = run('repo-exclude-patterns.js', ['not-a-form']);
    expect(out.code, 'an unknown form got one of the real answers').not.toBe(0);
  }, 90_000);
});
