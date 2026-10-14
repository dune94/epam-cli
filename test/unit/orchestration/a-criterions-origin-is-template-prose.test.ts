/**
 * THE WORDS THAT MARK A REMEDIATION CRITERION ARE TEMPLATE PROSE — ONE DEFINITION, RENDERED, NEVER A LITERAL IN THE ENGINE.
 *
 * Operator, 2026-10-14: "You are not permitted to hard code engine prose." The marker the reviewer and the writer see
 * beside a criterion the remediator added was a string in lib/story-acs-block.sh, and the reviewer's contract repeated it
 * in its own text. It now lives in prompts/templates/criterion-origin.json and both render it.
 *
 * EXECUTED: the real story_acs_block on a PRD, and the real review-finding-routing render; both compared with the template.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
const T = join(__dirname, '../../../orchestrations/prompts/templates');
const template = () => JSON.parse(readFileSync(join(T, 'criterion-origin.json'), 'utf8'));

describe('a criterion\'s origin is template prose', () => {
  it('the criteria block marks a remediation criterion with the template\'s words, and a plan criterion with none', () => {
    const mark = template().bodies.remediation.trim();
    expect(mark.length).toBeGreaterThan(0);
    const d = mkdtempSync(join(tmpdir(), 'origin-'));
    const prd = join(d, 'prd.json');
    writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S', acceptanceCriteria: ['the plan one', { text: 'the remediator one', status: 'pending', origin: 'remediation' }] }] }));
    const r = spawnSync('bash', ['-c', `. "${S}/lib/story-acs-block.sh"; story_acs_block "${prd}" S`], { encoding: 'utf8' });
    const out = r.stdout;
    expect(out, r.stderr).toContain(`AC2: the remediator one  ${mark}`);
    expect(out).toMatch(/AC1: the plan one\n/);
  });

  it('the reviewer\'s contract names the same words', () => {
    const mark = template().bodies.remediation.trim();
    const r = spawnSync('bash', ['-c', `. "${S}/lib/render-engine-prompt.sh"; . "${S}/lib/story-acs-block.sh"; f=$(mktemp); story_criterion_mark_values > "$f"; render_engine_prompt review-finding-routing "$f"`], { encoding: 'utf8' });
    expect(r.stdout, r.stderr).toContain(mark);
    expect(r.stdout).not.toContain('__REMEDIATION_MARK__');
  });
});
