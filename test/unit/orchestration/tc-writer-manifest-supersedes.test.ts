/**
 * After implementation and review, the manifest supersedes technicalNotes.files.
 *
 * `technicalNotes.files` is a PREDICTION written during the spec pass; the
 * writer-output manifest is a RECORD of what the run actually wrote. Anything
 * running AFTER implementation should trust the record — and the reproducing
 * test is created by a later agent, so it can never appear in a prediction made
 * earlier.
 *
 * post-impl-tc-writer.sh runs post-implementation and read the prediction. It
 * also hardcoded `.test.ts`:
 *
 *     is_test_story = any(f.endswith('.test.ts') for f in files)
 *
 * The metrolinx codeline names every test `.spec.ts`, so `is_test_story` was
 * always false there and test criteria were never generated for it at all —
 * the same hardcoded convention that had already blinded mutant-hunter.
 *
 * Two bugs in the first version of this fix were caught only by exercising the
 * helpers rather than reading them: `__tests__/a.ts` did not match (the pattern
 * required a leading slash), and the pairing key stripped the test marker but
 * not the extension, so `a.service.ts` and `a.service.spec.ts` produced
 * different keys and NOTHING was ever paired. Both would have made the fix a
 * silent no-op.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/post-impl-tc-writer.sh');
const src = readFileSync(SCRIPT, 'utf8');

/** Run the helper functions exactly as embedded in the script. */
function helpers(manifest: string | null) {
  const i = src.indexOf('def _files_for');
  const j = src.indexOf('\n', src.indexOf('return list(dict.fromkeys(declared + extra))'));
  const code = src.slice(src.lastIndexOf('import os as _os', i), j);
  const probe = `${code}
import json, sys
print(json.dumps({
  "det": [_is_test_file(f) for f in ["a.spec.ts","a.test.ts","__tests__/a.ts","src/__tests__/a.ts","pkg/test_thing.py","a.service.ts"]],
  "files": _files_for({"technicalNotes": {"files": ["src/a.service.ts"]}}),
}))`;
  const r = spawnSync('python3', ['-c', probe], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, _TCW_MANIFEST: manifest ?? '/nonexistent' },
  });
  return JSON.parse(r.stdout || '{}');
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function manifestWith(lines: string[]): string {
  const d = mkdtempSync(join(tmpdir(), 'tcw-'));
  dirs.push(d);
  const p = join(d, 'story-outputs-core.txt');
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('the TC writer trusts what the run produced', () => {
  it('pairs a source file with the test the run wrote for it', () => {
    const out = helpers(manifestWith([
      'src/a.service.ts', 'src/a.service.spec.ts', 'src/unrelated.ts',
    ]));
    expect(out.files,
      'the .spec.ts the run produced is invisible, so no test criteria are written for it')
      .toContain('src/a.service.spec.ts');
  });

  it('does not drag in unrelated files the run happened to touch', () => {
    const out = helpers(manifestWith(['src/a.service.ts', 'src/unrelated.ts']));
    expect(out.files).not.toContain('src/unrelated.ts');
  });

  it('falls back to the declared files when there is no manifest', () => {
    expect(helpers(null).files).toEqual(['src/a.service.ts']);
  });

  it('recognises every test convention, not just .test.ts', () => {
    // .spec.ts is this codeline's convention; hardcoding .test.ts made every
    // story look like a non-test story.
    const [spec, test, tests, nestedTests, pyTest, source] = helpers(null).det;
    expect(spec, '.spec.ts not recognised — the live codeline uses this').toBe(true);
    expect(test).toBe(true);
    expect(tests, '__tests__/ at path start not recognised').toBe(true);
    expect(nestedTests).toBe(true);
    expect(pyTest, 'python test_ convention not recognised').toBe(true);
    expect(source, 'a source file was misread as a test').toBe(false);
  });

  it('no longer hardcodes .test.ts anywhere', () => {
    expect(src, 'a hardcoded test convention remains in the engine')
      .not.toMatch(/endsWith\('\.test\.ts'\)|endswith\('\.test\.ts'\)/);
  });

  it('every embedded python program defines the helpers it uses', () => {
    // Three separate heredocs use these; one originally used them without
    // defining them, which fails only at runtime.
    const lines = src.split('\n');
    const starts = lines.reduce<number[]>((a, l, i) => {
      // Only a real heredoc OPENER, never a comment that mentions one — the
      // script contains a comment explaining the unquoted-heredoc hazard, and
      // matching it produced a phantom "program" with no helper definitions.
      if (/^[^#]*python3 <<\s*'?PYEOF'?\s*$/.test(l)) a.push(i);
      return a;
    }, []).concat(lines.length);
    for (let k = 0; k < starts.length - 1; k++) {
      const seg = lines.slice(starts[k], starts[k + 1]).join('\n');
      const uses = seg.split('_files_for(').length - 1 - (seg.split('def _files_for').length - 1);
      if (uses > 0) {
        expect(seg, `python program at line ${starts[k] + 1} uses _files_for without defining it`)
          .toMatch(/def _files_for/);
      }
    }
  });
});
