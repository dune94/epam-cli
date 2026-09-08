/**
 * A FRAMEWORK NAME IS NOT A PATH.
 *
 * ungroundedBriefPaths refuses an agent brief that names a file which does not exist, because a
 * brief is inherited whole and re-checked by nothing — a path it names becomes an instruction.
 * Right rule. But it kept any slash-bearing token whose LAST SEGMENT HAS AN EXTENSION:
 *
 *   if (/\.[A-Za-z0-9]+$/.test(segs[segs.length - 1])) return true;
 *
 * "React/Next.js" ends in ".js". So on a Next.js codeline — where writing "React/Next.js" is the
 * most natural phrase there is — the brief is read as citing a file, it resolves nowhere, and the
 * implementer is refused. Live 2026-09-08, pipeline-tests-47:
 *
 *   ! refused checkout-forms-engineer: brief names 1 path(s) that do not exist in any codeline:
 *     React/Next.js
 *   FAILED: [assign] no project implementation roles are registered for this project
 *
 * The run aborted at the mint with only investigators minted, having spent $6.89. This is not new:
 * the identical rejection appears in plans-unknown.jsonl dated 2026-08-25 on another model, so it
 * recurs whenever a brief mentions a .js-suffixed product name.
 *
 * THE FIX IS STRUCTURAL, NOT A VOCABULARY LIST. No list of framework names — the hardcoding rule
 * forbids it and the next framework would not be on it anyway. A two-segment token must ALSO start
 * at a directory the estate actually has, which is already how this function recognises a
 * directory cited without a trailing slash. Three or more segments keep the extension rule.
 *
 * THE COST OF THE TRADE, stated rather than hidden: a two-segment invented path rooted at a
 * directory the estate does not have — "vendor/thing.ts" — is no longer caught. That is the
 * narrow price of not refusing every brief that mentions the framework it works in.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const roster = require(join(ROOT, 'orchestrations/scripts/lib/agent-roster.js'));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A codeline with a real src/components tree, so "roots" is genuinely populated. */
function estate() {
  const d = mkdtempSync(join(tmpdir(), 'estate-')); dirs.push(d);
  mkdirSync(join(d, 'src', 'components', 'pages'), { recursive: true });
  writeFileSync(join(d, 'src', 'components', 'CheckoutForm.tsx'), 'x');
  mkdirSync(join(d, 'src', 'lib'), { recursive: true });
  return [{ name: 'gotransit', path: d }];
}
const brief = (text: string) => ({ name: 'a', kind: 'implementer', codeline: 'gotransit', systemPrompt: text });

describe('a framework name is not a path', () => {
  it('GUARD: the checker is reachable and still flags a genuinely invented file', () => {
    expect(typeof roster.ungroundedBriefPaths,
      'ungroundedBriefPaths is not exported, so the rule that killed a run cannot be tested')
      .toBe('function');
    const out = roster.ungroundedBriefPaths(
      brief('Edit src/components/DoesNotExist.tsx to fix it.'), estate());
    expect(out, 'an invented file under a real root must still be refused')
      .toContain('src/components/DoesNotExist.tsx');
  });

  it('DOES NOT FLAG A FRAMEWORK NAME — the exact brief that aborted run 47', () => {
    const out = roster.ungroundedBriefPaths(
      brief('You work in a React/Next.js codebase and own the checkout form.'), estate());
    expect(out, 'React/Next.js is still read as a file path, so any brief naming the framework it '
      + 'works in refuses the implementer and the run dies with no one to write code').toEqual([]);
  });

  it('NOR OTHER .js PRODUCT NAMES — the next framework is not on any list', () => {
    for (const name of ['Node.js', 'Vue.js', 'D3.js', 'Express.js']) {
      const out = roster.ungroundedBriefPaths(brief(`Built on React/${name} throughout.`), estate());
      expect(out, `React/${name} was read as a path`).toEqual([]);
    }
  });

  it('STILL FLAGS A REAL-ROOTED TWO-SEGMENT PATH — src/lib exists, src/nope does not', () => {
    expect(roster.ungroundedBriefPaths(brief('See src/lib for helpers.'), estate()),
      'src/lib exists and must not be flagged').toEqual([]);
    expect(roster.ungroundedBriefPaths(brief('See src/nope for helpers.'), estate()),
      'a missing directory under a REAL root must still be refused').toContain('src/nope');
  });

  it('STILL FLAGS DEEPER INVENTED PATHS — three segments keep the extension rule', () => {
    expect(roster.ungroundedBriefPaths(
      brief('Patch vendor/acme/thing.ts as well.'), estate()),
    'a three-segment invented path must still be refused').toContain('vendor/acme/thing.ts');
  });

  it('PROSE WITH SLASHES IS UNAFFECTED', () => {
    expect(roster.ungroundedBriefPaths(
      brief('Handle read/write and pass/fail and and/or cases.'), estate())).toEqual([]);
  });
});
