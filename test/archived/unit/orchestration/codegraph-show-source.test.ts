/**
 * The detective cannot quote code it has never been shown.
 *
 * It is required to emit `brokenLine` — a VERBATIM quote of the broken source —
 * and that quote is machine-checked against the file. But its only tool,
 * codegraph-agent-query.sh, returns nothing but indexed symbol names and import
 * paths. It emits zero lines of source. The prompt then says:
 *
 *     "Use the Bash tool ONLY to run the CodeGraph query script above;
 *      use no other tool."
 *
 * So the pipeline demands a verbatim copy, never provides the text, and forbids
 * fetching it. The only thing the model CAN do is reconstruct the line from the
 * symbol names it saw — and that is exactly what the failures look like:
 *
 *   run 3 quoted   dispatch.lineItemKey === lineItem.id
 *   run 6 quoted   lineItemKey === orderLineItem.id
 *   the real line  lineItem.id === discount.lineItemId
 *
 * Both are correct in concept with invented identifiers. `lineItemKey` exists
 * nowhere in the repository. It also explains why the failure is intermittent:
 * when the symbol names happened to resemble the real expression the
 * reconstruction came out right by luck.
 *
 * That is not a weak model. It is an impossible instruction. The fix is to show
 * the source: a `show` subcommand that prints real, numbered lines, so quoting
 * becomes copying.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const TOOL = join(__dirname, '../../../orchestrations/scripts/codegraph-agent-query.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SERVICE = 'src/services/apply-report-discounts.service.ts';
const SOURCE =
  "import { getUniqDiscounts } from './helpers';\n" +
  'export function applyReportDiscountsService(dispatches, orderLineItems) {\n' +
  '  const uniqDiscounts = getUniqDiscounts(orderLineItems);\n' +
  '  dispatches.forEach((dispatch) => {\n' +
  '    const discountsForDispatch = uniqDiscounts.filter((discount) => {\n' +
  '      return dispatch.lineItems.some(\n' +
  '        (lineItem) => lineItem.id === discount.lineItemId,\n' +
  '      );\n' +
  '    });\n' +
  '  });\n' +
  '}\n';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cg-show-'));
  dirs.push(root);
  const abs = join(root, SERVICE);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, SOURCE);
  return root;
}

function show(root: string, ...args: string[]) {
  const r = spawnSync('bash', [TOOL, 'show', ...args], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PROJECT_ROOT: root },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('the tool can show real source, so a quote is a copy', () => {
  it('prints the actual broken line the detective must quote', () => {
    const r = show(repo(), SERVICE);
    expect(r.out,
      'the detective is asked for a verbatim quote but is never shown the file — ' +
      'so it reconstructs the line from symbol names and invents identifiers')
      .toContain('lineItem.id === discount.lineItemId');
  });

  it('numbers the lines, so the fix can cite a location', () => {
    expect(show(repo(), SERVICE).out).toMatch(/\b7[:\s|]/);
  });

  it('accepts a repo-relative path', () => {
    expect(show(repo(), SERVICE).code).toBe(0);
  });

  it('can show a window around one line rather than a whole file', () => {
    // Whole files blow the context budget on an 850-file repository.
    const r = show(repo(), SERVICE, '5', '9');
    expect(r.out).toContain('lineItem.id === discount.lineItemId');
    expect(r.out, 'the window is not bounded — it printed the import line too')
      .not.toContain('getUniqDiscounts }');
  });

  it('refuses to escape the repository', () => {
    const r = show(repo(), '../../../etc/passwd');
    expect(r.code, 'the tool read a file outside the project').not.toBe(0);
  });

  it('fails clearly on a missing file rather than printing nothing', () => {
    const r = show(repo(), 'src/nope.ts');
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not found|no such/i);
  });

  it('caps very large files instead of dumping them', () => {
    const root = repo();
    const big = join(root, 'src/big.ts');
    writeFileSync(big, Array.from({ length: 5000 }, (_, i) => `const x${i} = ${i};`).join('\n'));
    const r = show(root, 'src/big.ts');
    expect(r.out.split('\n').length, 'an unbounded dump would swamp the context window')
      .toBeLessThan(400);
    expect(r.out, 'the truncation is silent').toMatch(/truncat/i);
  });
});

describe('the detective is told to read before it quotes', () => {
  const SPEC = require('node:fs').readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('the prompt documents the show subcommand', () => {
    expect(SPEC, 'the tool can show source but the detective is never told')
      .toMatch(/\bshow\b[^\n]*<file>|show <file>/);
  });

  it('requires reading the file before emitting the quote', () => {
    expect(SPEC, 'nothing tells the model to look at the line it is about to quote')
      .toMatch(/read the file|before you quote|copy it exactly/i);
  });

  it('no longer forbids the very read it depends on', () => {
    // "use no other tool" was fine; "only run the query script" was not, because
    // the quote requirement cannot be met without seeing the source.
    const i = SPEC.indexOf('Use the Bash tool ONLY');
    if (i > -1) {
      expect(SPEC.slice(i, i + 200),
        'the prompt still bans reading the file whose text it demands verbatim')
        .toMatch(/show|read/i);
    }
  });
});
