/**
 * THE KB SYNTHESIZER'S MODEL CALL IS IN THE LEDGER.
 *
 * Every other model call lands in phase-cost.jsonl and agent-activity.jsonl through
 * lib/cost-emitter.js; the synthesizer's did not. It ran, admitted a constraint into
 * constraints.json, and no ledger row said a model had been called — the £0 greenfield harness
 * reported the seam never executed over its own admitted rule (run 30, 2026-09-14). Judged by
 * executing the real synthesizer with a runner that writes the JSON result a runner writes, and
 * reading the ledger back.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LIB = resolve(__dirname, '../../../orchestrations/scripts/lib');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * A seam-declared prompt renders from THIS PROJECT's copy; the mint builds that copy from the
 * template through the contract. The same build, for a project directory of this test's own.
 */
function projectWithPrompt(id: string): string {
  const { buildGeneratedDoc } = require(join(LIB, 'project-prompt-contract.js'));
  const tpl = JSON.parse(readFileSync(join(LIB, '..', '..', 'prompts', 'templates', `${id}.json`), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'kb-proj-')); dirs.push(dir); mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts', `${id}.json`), JSON.stringify(buildGeneratedDoc(tpl, tpl.body)));
  return dir;
}

describe("the KB synthesizer's model call is in the ledger", () => {
  it('a synthesis that admits a rule leaves a kb-synthesizer row in phase-cost.jsonl and the activity log', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-ledger-')); dirs.push(root);
    const logDir = join(root, 'logs'); mkdirSync(logDir);
    for (const m of ['kb-store.js', 'kb-arbitration.js', 'kb-synthesizer.js']) delete require.cache[require.resolve(join(LIB, m))];
    const store = require(join(LIB, 'kb-store.js')); store.configure({ root });
    const synth = require(join(LIB, 'kb-synthesizer.js'));
    for (let i = 0; i < 2; i += 1) store.recordEpisode({ id: `ep-${i}-${Date.now()}`, signature: 'TS2532', agent_role: 'impl-agent', story_id: 'KB-1', diagnosis: 'd' });
    // A runner that answers as a runner does: the reply on stdout, and its JSON result — usage
    // and cost — where ORCH_JSON_RESULT points, exactly as llm-handler.sh does.
    const runner = join(root, 'runner.sh');
    writeFileSync(runner, `#!/usr/bin/env bash
cat >/dev/null
[ -n "\${ORCH_JSON_RESULT:-}" ] && printf '%s' '{"type":"result","result":"","usage":{"input_tokens":120,"output_tokens":30},"total_cost_usd":0.0042,"modelUsage":{"m":{"inputTokens":120,"outputTokens":30,"costUSD":0.0042}}}' > "$ORCH_JSON_RESULT"
echo '{"enforcement":{"kind":"gate","check":"tsc"},"reason":"the same TS2532 twice"}'
`); chmodSync(runner, 0o755);
    const prev = { LOG_DIR: process.env.LOG_DIR, ACTIVITY_FILE: process.env.ACTIVITY_FILE, EPAM_PROJECT_CONFIG_DIR: process.env.EPAM_PROJECT_CONFIG_DIR };
    process.env.LOG_DIR = logDir; process.env.ACTIVITY_FILE = join(logDir, 'agent-activity.jsonl');
    process.env.EPAM_PROJECT_CONFIG_DIR = projectWithPrompt('kb-enforcement-synthesis');
    let r: any;
    try { r = await synth.maybeSynthesize(store, { agent_role: 'impl-agent', signature: 'TS2532', runner, model: 'm', provider: 'p' }); }
    finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    expect(r, 'the rule was admitted').toBeTruthy();
    const ledger = join(logDir, 'phase-cost.jsonl');
    expect(existsSync(ledger), 'no ledger row was written for the synthesizer call').toBe(true);
    const rows = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const mine = rows.filter((x) => x.agent_name === 'kb-synthesizer');
    expect(mine.length).toBe(1);
    expect(Number(mine[0].task_cost_usd ?? mine[0].cost_usd ?? 0)).toBeGreaterThan(0);
    const activity = readFileSync(join(logDir, 'agent-activity.jsonl'), 'utf8');
    expect(activity).toContain('kb-synthesizer');
  });
});
