/**
 * Impl agent must NOT be pushed to explore via CodeGraph when the fix is already
 * prescribed with a named helper (found live 2026-07-24, AMSD-1820): the prompt
 * injected an AUTHORITATIVE root-cause fix naming the exact helper (parseDispatchLineItemKey),
 * yet ALSO injected "## CodeGraph Tool — do this BEFORE writing any new helper … RULE: before
 * you add ANY function, run `helpers`". The agent obeyed the exploration push, burned ReAct
 * turns searching for a helper it was already handed, and the re-sent conversation ballooned
 * input to 137-189K tokens (it never even reached WriteFile).
 *
 * Fix: when fixSiteAnalysis[].helper is set, replace the exploration push with a minimal
 * "the helper is already identified — do NOT search, apply the fix directly" note. Full
 * CodeGraph block only when NO helper is prescribed (genuine novel work). Drives the real
 * bash block from claude.sh with a stubbed `codegraph` on PATH.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_SH = readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function extractBlock(): string {
  const start = CLAUDE_SH.indexOf('local codegraph_tool_block=""');
  const end = CLAUDE_SH.indexOf('# Deterministic contract injection', start);
  if (start === -1 || end === -1) throw new Error('codegraph_tool_block markers not found');
  // include up to (but not past) the contract-injection comment — trims to the closing fi
  return CLAUDE_SH.slice(start, end);
}
const block = extractBlock();

function run(fixSiteAnalysis: any[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cg-block-'));
  dirs.push(dir);
  // stub `codegraph` so `command -v codegraph` succeeds
  writeFileSync(join(dir, 'codegraph'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(dir, 'codegraph'), 0o755);
  const storyJson = JSON.stringify({ fixSiteAnalysis });
  const script = `
run_it() {
  local PROJECT_ROOT='/tmp/repo'
  local SCRIPT_DIR='/tmp/scripts'
  local story_json='${storyJson}'
${block}
  printf '%s' "$codegraph_tool_block"
}
export EPAM_BROWNFIELD=1
export PATH="${dir}:$PATH"
run_it
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

describe('CodeGraph exploration is suppressed when a helper is already prescribed', () => {
  it('helper prescribed → minimal "do NOT search" note, NOT the explore-before-writing push', () => {
    const out = run([{ file: 'src/x.ts', helper: 'parseDispatchLineItemKey' }]);
    expect(out).toMatch(/do NOT search|already identified/i);
    expect(out).toContain('parseDispatchLineItemKey');
    expect(out).not.toMatch(/do this BEFORE writing any new helper/); // the exploration push is gone
  });

  it('NO helper prescribed → full CodeGraph exploration block (novel work unchanged)', () => {
    const out = run([{ file: 'src/x.ts', helper: '' }]);
    expect(out).toMatch(/CodeGraph Tool|do this BEFORE writing any new helper/);
  });
});
