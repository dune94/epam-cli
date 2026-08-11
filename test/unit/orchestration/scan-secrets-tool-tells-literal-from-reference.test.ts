/**
 * A CREDENTIAL CHECK THE REVIEWER CAN CALL, THAT KNOWS WHAT IT IS LOOKING AT.
 *
 * The commit-time scan matched `credential_name: value` on shape alone and refused the commit
 * for `management_token: CONTENTSTACK_LIVE_PREVIEW_TOKEN` — an environment-derived identifier,
 * the exact pattern its own message recommends. It was removed (2026-08-09) and the check moves
 * to the review stage, where the reviewer already holds the diff.
 *
 * The distinction it must make is mechanical, so it belongs in a tool rather than in a
 * reviewer's judgement:
 *
 *   LEAK       apiKey = "blt9f2c4e7a1d8b3c6e5f0a9d2b4c7e1f8a"   quoted, long, high-entropy
 *   REFERENCE  management_token: CONTENTSTACK_LIVE_PREVIEW_TOKEN   an identifier
 *   REFERENCE  token = process.env.CONTENTSTACK_PREVIEW_TOKEN      an env read
 *
 * A pasted key is ALWAYS a literal. That is what makes the rule safe to state narrowly: nothing
 * that could be a real credential is let through by ignoring identifiers.
 *
 * This is a findings tool, not a gate. It reports; the reviewer decides. That ordering is the
 * one that has worked all week — deterministic evidence, agent judgement, gate on the verdict —
 * rather than a heuristic deciding alone, which is how the old scanner blocked correct work.
 *
 * No project, stack or vendor vocabulary appears here or in the tool: the subjects are the
 * variable names in the diff, and the verdict is entropy and syntax.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const plugin = require('../../../orchestrations/plugins/secret-scan-plugin.js');
const tool = (plugin.tools || []).find(
  (t: any) => (t.name || (t.definition && t.definition.name)) === 'scan_secrets',
);

const run = async (diff: string) => {
  const r = await tool.execute({ diff });
  return typeof r === 'string' ? JSON.parse(r) : (r.content ? JSON.parse(r.content) : r);
};

/**
 * "No findings" is only meaningful if the tool actually RAN. execute() catches its own errors
 * and returns {findings: [], error}, so a crash is indistinguishable from a clean result unless
 * the error is asserted too — a mutation that broke the literal check passed 18 tests because
 * of exactly that.
 */
const expectClean = (r: any) => {
  expect(r.error, `the scan threw instead of clearing the line: ${r.error}`).toBeUndefined();
  expect(r.findings).toEqual([]);
};
const added = (line: string) => `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n+${line}\n`;

describe('the tool is declared the way every other plugin tool is', () => {
  it('it exists and is safe, so read-only seams get it automatically', () => {
    expect(tool, 'no scan_secrets tool is exported').toBeTruthy();
    expect(tool.permission).toBe('safe');
  });

  it('it declares an input schema', () => {
    expect(tool.definition.inputSchema.properties).toBeTruthy();
  });
});

describe('a real leak is reported', () => {
  it('a long quoted credential assigned to a secret-ish name', async () => {
    const r = await run(added('const apiKey = "blt9f2c4e7a1d8b3c6e5f0a9d2b4c7e1f8a";'));
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings[0].line).toContain('apiKey');
  });

  it('a quoted password literal', async () => {
    expect((await run(added('password: "hunter2-not-guessable-9f2c4e7a1d8b";'))).findings.length).toBeGreaterThan(0);
  });

  it('the finding says what it saw, so a reviewer can judge it', async () => {
    const r = await run(added('const secret = "9f2c4e7a1d8b3c6e5f0a9d2b4c7e1f8aa1b2c3d4";'));
    expect(r.findings[0]).toHaveProperty('reason');
    expect(String(r.findings[0].reason)).toMatch(/literal|entropy|quoted/i);
  });
});

describe('THE DEFECT THE OLD GATE HAD: a reference is not a leak', () => {
  it('the exact line that blocked the live run is NOT reported', async () => {
    const r = await run(added('  management_token: CONTENTSTACK_LIVE_PREVIEW_TOKEN,'));
    expect(
      r.findings,
      'an environment-derived identifier was reported as a credential, which is what blocked ' +
      'a correct commit on 2026-08-09',
    ).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('a process.env read is not reported', async () => {
    expectClean(await run(added('const token = process.env.CONTENTSTACK_PREVIEW_TOKEN;')));
  });

  it('a member expression is not reported', async () => {
    expectClean(await run(added('apiKey: config.contentstack.deliveryToken,')));
  });

  it('a short literal is not reported — it cannot be a key', async () => {
    expectClean(await run(added('const token = "";')));
    expectClean(await run(added('password: "todo",')));
  });

  it('an obvious placeholder is not reported', async () => {
    expectClean(await run(added('const apiKey = "your_api_key_here_placeholder";')));
  });
});

describe('it reports rather than decides', () => {
  it('a clean diff returns an empty findings list, not an error', async () => {
    const r = await run(added('const x = 1;'));
    expect(r.findings).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('removed lines are ignored — only what is being ADDED matters', async () => {
    const d = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const apiKey = "blt9f2c4e7a1d8b3c6e5f0a9d2b4c7e1f8a";\n+const apiKey = KEY;\n';
    expect((await run(d)).findings).toEqual([]);
  });

  it('an empty or absent diff does not throw', async () => {
    expect((await run('')).findings).toEqual([]);
    await expect(tool.execute({})).resolves.toBeTruthy();
  });
});

/**
 * WIRED, NOT MERELY AVAILABLE.
 *
 * Every gate found inert this week was present, plausible and never invoked — the finding
 * re-check, the coverage check, the tool grant, `search`. A tool nobody is told to call is the
 * same shape. These assert both halves: the reviewer is GRANTED it (via the project's plugin
 * list, which the grant appends) and TOLD to call it.
 */
describe('the reviewer is both granted the tool and told to use it', () => {
  const fs = require('node:fs');
  const REVIEW = join(__dirname, '../../../orchestrations/scripts/team-lead-review.sh');
  const PLUGINS = join(__dirname, '../../../orchestrations/projects/metrolinx/plugins.json');

  it('the plugin is provisioned for the project', () => {
    const cfg = JSON.parse(fs.readFileSync(PLUGINS, 'utf8'));
    expect(
      cfg.tools.some((t: string) => t.endsWith('secret-scan-plugin.js')),
      'the tool exists but no codeline provisions it, so no agent is granted it',
    ).toBe(true);
  });

  it('the provisioned path resolves to a real file that exports the tool', () => {
    const cfg = JSON.parse(fs.readFileSync(PLUGINS, 'utf8'));
    const p = cfg.tools.find((t: string) => t.endsWith('secret-scan-plugin.js'));
    expect(fs.existsSync(p), `provisioned path does not exist: ${p}`).toBe(true);
    expect(require(p).tools.map((t: any) => t.name)).toContain('scan_secrets');
  });

  it('the reviewer prompt tells it to call scan_secrets with the diff', () => {
    const src = fs.readFileSync(REVIEW, 'utf8');
    const prompt = src.slice(src.indexOf('REVIEW_PROMPT="'), src.indexOf('REVIEW_OUTPUT=$('));
    expect(prompt, 'the tool is granted but nothing asks for it').toMatch(/scan_secrets/);
    expect(prompt).toMatch(/diff/i);
  });

  it('the prompt says a finding is a blocker, so the verdict has teeth', () => {
    const src = fs.readFileSync(REVIEW, 'utf8');
    const prompt = src.slice(src.indexOf('REVIEW_PROMPT="'), src.indexOf('REVIEW_OUTPUT=$('));
    expect(prompt.toLowerCase()).toMatch(/finding is a blocker/);
  });

  it('the grant appends project plugin tools, so provisioning is sufficient', () => {
    const src = fs.readFileSync(REVIEW, 'utf8');
    expect(src).toMatch(/EPAM_ALLOWED_TOOLS="[^"]*_review_plugin_tools/);
  });
});
