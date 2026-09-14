/**
 * THE DETECTIVE'S EXTRACTION PROMPT IS A TEMPLATE, NOT A LITERAL IN CODE.
 *
 * runCodeGraphDetective's second phase (no tools: extract the fix site from an investigation that
 * ended in prose) sent a prompt written as a template literal inside spec-mode-runner.js. The
 * prompt layer could not see it — no project copy, no review — and the £0 brownfield rehearsal
 * answered it from the catch-all with {} (run 1, 2026-09-14). One prompt = one JSON file.
 * Judged by rendering the template the code names and by the absence of the literal.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const { substituteOnce: _substituteOnce, placeholdersIn } = require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));
// The real one-pass substitution, over every placeholder the body carries.
const substituteOnce = (body: string, values: Record<string, string>) => _substituteOnce(body, placeholdersIn(body), values);

describe("the detective's extraction prompt is a template", () => {
  it('the code renders a named template for the extraction phase and holds no prompt literal', () => {
    const m = SRC.match(/const extractPrompt = renderEngineTemplate\('([a-z0-9-]+)'/);
    expect(m, 'the extraction phase does not render a template').toBeTruthy();
    expect(SRC).not.toMatch(/const extractPrompt = `/);
    const id = m![1];
    const file = join(ROOT, 'orchestrations/prompts/templates', `${id}.json`);
    expect(existsSync(file), `${id}.json does not exist`).toBe(true);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles;
    expect(doc.seams.filter((s: string) => reg[s]), 'the template declares no registry seam').not.toEqual([]);
    const rendered = substituteOnce(doc.body, Object.fromEntries(placeholdersIn(doc.body).map((p: string) => [p, `INVESTIGATION TEXT for ${p.replace(/_/g, " ").trim()}`])));
    expect(rendered).toContain('INVESTIGATION TEXT');
    expect(rendered).toMatch(/fix site/i);
    expect(rendered).not.toMatch(/__[A-Z0-9_]+__/);
  });
});
