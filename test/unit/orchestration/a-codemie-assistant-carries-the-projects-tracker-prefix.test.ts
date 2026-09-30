/**
 * A CODEMIE ASSISTANT CARRIES ITS PROJECT'S TRACKER PREFIX.
 *
 * Operator, 2026-09-30: "ensure the [AMSD] prefix is used on all created agents there". The prefix is
 * the project's own tracker key (projects/<p>/config.env JIRA_PROJECT_KEY) — declared once, read from
 * there; the engine config says only which variable carries it and how it is shown. A project with no
 * tracker key keeps the plain name.
 *
 * EXECUTED: the plugin's real assistantName with the real engine config; the key arrives the way a
 * run delivers it — in the environment load_project_env exports.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assistantName } = require(join(ROOT, 'orchestrations/plugins/providers/codemie-web/registry.js'));
const cfg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/codemie-web.json'), 'utf8'));
const keyVar: string = cfg.namePrefixFrom;
const projectKey = (/^JIRA_PROJECT_KEY=(\S+)/m.exec(readFileSync(join(ROOT, 'orchestrations/projects/metrolinx/config.env'), 'utf8')) || [])[1];

describe('a CodeMie assistant carries its project\'s tracker prefix', () => {
  it('the engine config declares which variable carries the prefix', () => {
    expect(typeof keyVar, 'codemie-web.json declares no namePrefixFrom').toBe('string');
    expect(projectKey, 'the project declares no tracker key to prove this with').toBeTruthy();
  });

  it('with the project\'s key in the run\'s environment, the name opens with it in brackets', () => {
    const name = assistantName('cx-shared', 'story-writer', cfg, { [keyVar]: projectKey });
    expect(name.startsWith(`[${projectKey}] `)).toBe(true);
    expect(name).toContain('cx-shared');
    expect(name).toContain('story-writer');
  });

  it('with no key, the plain name — no empty brackets', () => {
    const name = assistantName('cx-shared', 'story-writer', cfg, {});
    expect(name).not.toMatch(/\[\s*\]/);
    expect(name.startsWith('[')).toBe(false);
  });
});
