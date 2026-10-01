/**
 * NO LOCAL PATH LEAVES THE HUB — every model call, however its prompt was built.
 *
 * Operator, 2026-10-01: "hard coded local paths are not generated into prompts or SI text. This is
 * not permitted. Relative paths only." Filling placeholders relatively was not enough: prompts built
 * inline (the mint's, the prompt builder's generator) never pass a renderer, and still carried the
 * codelines' absolute paths (50 of 101 rehearsal prompts). Every call passes the hub, so the hub
 * makes the prompt and the SI relative before the runner sees either.
 *
 * EXECUTED: the real llm-handler.sh with a stand-in runner that records what it received.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localPathFindings } from '../../mock-agent/si-check';

const ROOT = join(__dirname, '../../..');
const HUB = join(ROOT, 'orchestrations/scripts/llm-handler.sh');
const SETS = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8'));
const SET: string = SETS.defaultSet;
const RUNNERS = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config', SETS.sets[SET].settingsFile), 'utf8')).runners || {};
const RUNNER = Object.keys(RUNNERS).find((r) => RUNNERS[r].siChannel && RUNNERS[r].siChannel.flag) as string;
const SEAM = Object.keys(JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles)
  .find((s) => JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles[s].si) as string;

const work = mkdtempSync(join(tmpdir(), 'hub-paths-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const estate = join(work, 'codelines'); const codeline = join(estate, 'site-a'); mkdirSync(join(codeline, 'src'), { recursive: true });

describe('no local path leaves the hub', () => {
  it('the runner receives the prompt and the SI with the run\'s paths relative', () => {
    const rec = join(work, 'rec'); const stub = join(work, RUNNER);
    writeFileSync(stub, ['#!/usr/bin/env bash', `cat > ${JSON.stringify(rec + '.stdin')}`,
      `for a in "$@"; do [ -f "$a" ] && cat "$a" >> ${JSON.stringify(rec + '.files')}; done`,
      `printf '%s' '{"result":"ok","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}'`].join('\n'));
    chmodSync(stub, 0o755);
    const prompt = `Read ${join(codeline, 'src', 'a.ts')} and compare with ${join(estate, 'shared-lib', 'x.ts')}.`;
    const r = spawnSync('bash', [HUB, '--provider', RUNNER], {
      input: prompt, encoding: 'utf8', cwd: ROOT,
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, CLAUDE_CMD: stub, NODE_BIN: process.execPath, EPAM_PROVIDER_SET: SET,
        EPAM_AGENT_NAME: SEAM, EPAM_PROJECT_CONFIG_DIR: '', PROJECT_ROOT: codeline, JIRA_CODELINE_ROOT: estate, EPAM_PLAN_EXECUTE: '0' },
    });
    expect(r.status, r.stderr.slice(-1500)).toBe(0);
    const stdin = existsSync(rec + '.stdin') ? readFileSync(rec + '.stdin', 'utf8') : '';
    const files = existsSync(rec + '.files') ? readFileSync(rec + '.files', 'utf8') : '';
    expect(stdin, 'the runner received no prompt — this proves nothing').toContain('Read ');
    expect(stdin).toContain('src/a.ts');
    expect(stdin).toContain('shared-lib/x.ts');
    const call = { n: 1, seam: SEAM, template: '', coverage: 1, story: '', attempt: 1, req: { system: files, messages: [{ role: 'user', text: stdin }], tools: [] } } as any;
    expect(localPathFindings(call)).toEqual([]);
  });
});
