/**
 * Absence must be provable, not assumed.
 *
 * The CodeGraph index is a tree-sitter AST in SQLite — structurally exact, but
 * it answers only for what it indexed. When a symbol is missing from it (a
 * near-miss spelling, a construct the parser skipped, a file newer than the
 * index) it returns empty, and empty is where extrapolation begins. Runs 3 and
 * 6 invented `lineItemKey` — a name that appears nowhere in the repository —
 * after exactly that kind of miss.
 *
 * This fallback searches the real working tree, so a hit is ground truth and a
 * miss is evidence of absence. Both are facts; neither is an inference. Paired
 * with the reality-anchor rule in the detective prompt, the model is told: if
 * neither tool returns it, it does not exist — stop reasoning about it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const TOOL = join(__dirname, '../../../orchestrations/scripts/ripgrep-search.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SERVICE = 'src/services/apply-report-discounts.service.ts';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'rg-fallback-'));
  dirs.push(root);
  const abs = join(root, SERVICE);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs,
    'export function applyReportDiscountsService(dispatches, orderLineItems) {\n' +
    '  return dispatches.filter((d) => lineItem.id === discount.lineItemId);\n' +
    '}\n');
  writeFileSync(join(root, 'README.md'), 'applyReportDiscountsService is documented here\n');
  return root;
}

function search(root: string, ...args: string[]) {
  const r = spawnSync('bash', [TOOL, ...args], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PROJECT_ROOT: root },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('a hit is ground truth', () => {
  it('finds a symbol that really exists, with its location', () => {
    const r = search(repo(), '--string', 'applyReportDiscountsService');
    expect(r.code).toBe(0);
    expect(r.out).toContain(SERVICE);
  });

  it('can be scoped to a file type', () => {
    const r = search(repo(), '--string', 'applyReportDiscountsService', '--glob', '*.ts');
    expect(r.out, 'the glob was ignored — the markdown hit came back too')
      .not.toContain('README.md');
  });

  it('finds a file by name', () => {
    const r = search(repo(), '--file', 'apply-report-discounts');
    expect(r.code).toBe(0);
    expect(r.out).toContain(SERVICE);
  });
});

describe('a miss is evidence of absence, and says so', () => {
  it('reports the invented identifier from runs 3 and 6 as not existing', () => {
    const r = search(repo(), '--string', 'lineItemKey');
    expect(r.code, 'a missing symbol did not report definitive absence').toBe(1);
    expect(r.out).toMatch(/NOT FOUND/);
  });

  it('tells the model the answer is definitive, not an index gap', () => {
    // "The tool didn't find it" invites a retry-by-guessing. "It does not
    // exist" ends the question.
    expect(search(repo(), '--string', 'lineItemKey').out).toMatch(/definitive/i);
  });

  it('explicitly forbids inferring it under another name', () => {
    expect(search(repo(), '--string', 'lineItemKey').out).toMatch(/do not infer/i);
  });
});

describe('it cannot be turned into a different question', () => {
  it('treats the query as a literal, not a regex', () => {
    // A symbol containing regex metacharacters must not silently match
    // something else — that would manufacture a false hit, which is worse
    // than a miss.
    const r = search(repo(), '--string', 'lineItem.id === discount.lineItemId');
    expect(r.code).toBe(0);
    const r2 = search(repo(), '--string', 'lineItem?id');
    expect(r2.code, 'the query was interpreted as a pattern and matched real code').toBe(1);
  });

  it('fails clearly when given neither a string nor a file', () => {
    expect(search(repo()).code).toBe(2);
  });

  it('fails clearly when the project root does not exist', () => {
    const r = spawnSync('bash', [TOOL, '--string', 'x'], {
      encoding: 'utf8', env: { ...process.env, PROJECT_ROOT: '/nonexistent-xyz' },
    });
    expect(r.status).toBe(2);
  });
});

describe('the detective is told the rule', () => {
  const SPEC = require('node:fs').readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('carries the reality anchor', () => {
    expect(SPEC, 'nothing tells the model that a tool miss means non-existence')
      .toMatch(/REALITY ANCHOR|does NOT exist in this codebase/);
  });

  it('names the fallback so the model can actually reach it', () => {
    expect(SPEC, 'the rule demands proof via a tool the prompt never mentions')
      .toMatch(/ripgrep-search\.sh/);
  });

  it('forbids extrapolating names from naming patterns', () => {
    expect(SPEC).toMatch(/do not infer|extrapolat/i);
  });
});
