import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * THE TEST-FILE CONVENTION IS A STACK FACT, SO IT LIVES IN THE PLUGIN.
 *
 * brownfield-repro-test-writer.sh carried its own copy:
 *
 *     if [ spec_count >= test_count ]; then _ext="spec.ts"; else _ext="test.ts"; fi
 *     _target_rel="${_primary_fix%.*}.${_ext}"
 *
 * Two faults in three lines. It HARDCODED stack filenames in engine code, which is not permitted —
 * a stack fact belongs in a plugin or in project config. And it counted `*.spec.ts` and
 * `*.spec.tsx` together (746 files on the gotransit codeline) then discarded the .tsx half, so a
 * CheckoutForm.tsx source produced a target of CheckoutForm.spec.ts.
 *
 * Live 2026-09-02, AMSD-1919: the agent wrote CheckoutForm.spec.tsx — correct, a React component's
 * test carries JSX and will not compile as .ts — and the stage, waiting on CheckoutForm.spec.ts,
 * reported "no valid test after 3 attempts" while escalating claude-sonnet-5 -> claude-opus-4-8 ->
 * claude-opus-5 against a file already on disk under the right name.
 */
describe('where a new repro test goes', () => {
  const handler = path.resolve(__dirname, '../../../orchestrations/scripts/lib/handlers/new-test-path.js');
  const script = path.resolve(__dirname, '../../../orchestrations/scripts/brownfield-repro-test-writer.sh');

  const ask = (source: string, existing: string[]) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'convention-'));
    for (const f of [source, ...existing]) {
      fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(repo, f), '// x\n');
    }
    const out = execFileSync(process.execPath, [handler, repo, source], { encoding: 'utf8', timeout: 60_000 });
    expect(out.length, 'handler produced nothing — vacuous pass').toBeGreaterThan(0);
    return {
      target: out.match(/TARGET=(.*)/)?.[1]?.trim() ?? '',
      example: out.match(/EXAMPLE=(.*)/)?.[1]?.trim() ?? '',
    };
  };

  it('gives a .tsx source a .tsx test path', () => {
    expect(ask('src/CheckoutForm.tsx', ['src/A.spec.tsx', 'src/B.spec.ts']).target)
      .toBe('src/CheckoutForm.spec.tsx');
  });

  it('gives a .ts source a .ts test path', () => {
    expect(ask('src/helper.ts', ['src/A.spec.tsx', 'src/B.spec.ts']).target)
      .toBe('src/helper.spec.ts');
  });

  it('follows the marker this codeline actually uses, not a literal', () => {
    // a repo that says .test, not .spec — the answer must follow the repo
    expect(ask('src/thing.ts', ['src/A.test.ts', 'src/B.test.ts', 'src/C.test.ts']).target)
      .toBe('src/thing.test.ts');
  });

  it('offers an existing test to mirror', () => {
    expect(ask('src/CheckoutForm.tsx', ['src/A.spec.tsx']).example).toBe('src/A.spec.tsx');
  });

  it('the engine ASKS the plugin — it holds no convention of its own', () => {
    const body = fs.readFileSync(script, 'utf8');
    expect(body, 'the script no longer calls the resolver').toContain('new-test-path.js');
    const code = body.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    const literals = code.match(/["']\*?\.?(spec|test)\.(ts|tsx|js|jsx)["']/g) ?? [];
    expect(literals, `stack filename literals still in engine code: ${literals.join(' ')}`).toEqual([]);
  });
});
