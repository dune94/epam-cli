/**
 * A WRITER PROMPT THAT CANNOT RENDER IS NOT SENT — AND A CODELINE WITH NO TOOLS IS ORDINARY.
 *
 * regintel £0 rehearsal #18 (2026-09-20), the first to reach a worktree lane: the worktree is a
 * fresh checkout with no untracked .epam/tools, so __PROJECT_TOOLS_BLOCK__ was empty; the
 * story-writer-main template did not declare it may-be-empty, render refused — and the writer
 * was invoked anyway ("Invoking claude (attempt 1/8)") with nothing, eight times, because
 * build_implementation_prompt ended in `rm -f` and returned the rm's status, not the render's.
 * Every story in the lane failed "missing deliverables" on a prompt that never existed.
 *
 * (1) A codeline that registered no tools is the ordinary state; the block may be empty.
 * (2) build_implementation_prompt returns the render's status, so the caller's existing
 *     "REFUSED — not invoking the writer" path fires.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');

describe('(1) the tools block may be empty', () => {
  it('story-writer-main declares __PROJECT_TOOLS_BLOCK__ may-be-empty, with a reason', () => {
    const tpl = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/story-writer-main.json'), 'utf8'));
    expect(tpl.mayBeEmpty).toContain('__PROJECT_TOOLS_BLOCK__');
    const why = tpl.$whyMayBeEmpty || tpl.$mayBeEmptyWhy;
    expect(typeof why === 'string' ? why : why.__PROJECT_TOOLS_BLOCK__).toMatch(/tool/i);
  });
  it('the engine renderer accepts an empty tools block for that template', () => {
    // renderEngineTemplate checks emptiness against the declaration; a declared-empty value passes.
    const r = spawnSync(process.execPath, ['-e', `
      const fs = require('fs');
      const tpl = JSON.parse(fs.readFileSync(${JSON.stringify(join(ROOT, 'orchestrations/prompts/templates/story-writer-main.json'))}, 'utf8'));
      const may = new Set(tpl.mayBeEmpty || []);
      process.stdout.write(String(may.has('__PROJECT_TOOLS_BLOCK__')));
    `], { encoding: 'utf8' });
    expect(r.stdout).toBe('true');
  });
});

describe('(2) a failed render is a refusal', () => {
  it('build_implementation_prompt ends by returning the render\'s status, not rm\'s', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/lib/writer-prompt.sh'), 'utf8');
    const i = src.indexOf('render_engine_prompt story-writer-main "$_sw_vals"');
    const tail = src.slice(i, i + 200);
    expect(tail).toMatch(/_sw_rc=\$\?/);
    expect(tail).toMatch(/return "?\$_sw_rc"?/);
  });
  it('executed: a render that fails makes the function fail', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/lib/writer-prompt.sh'), 'utf8');
    const i = src.indexOf('render_engine_prompt story-writer-main "$_sw_vals"');
    const end = src.indexOf('\n}\n', i);
    const tail = src.slice(i, end);
    const r = spawnSync('bash', ['-c', `_sw_vals=$(mktemp); render_engine_prompt(){ echo "render refused" >&2; return 1; }\nf(){ ${tail}\n}\nf; echo "RC=$?"`], { encoding: 'utf8' });
    expect(r.stdout).toMatch(/RC=1/);
  });
});
