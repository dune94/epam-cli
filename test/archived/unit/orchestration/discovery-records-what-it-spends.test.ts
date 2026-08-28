/**
 * THE REQUIREMENT: every model call the pipeline makes is recorded as spend.
 *
 * Codeline discovery makes TWO model calls per run — the vocabulary agent, then the matcher, one of
 * them at effort:high with a 16k output budget. Neither appears in any cost ledger on disk. Not
 * under `codeline-discovery`, not under `discovery-vocabulary`, not under `unknown`:
 *
 *     656  typescript-engineer
 *     113  contentstack-live-preview-integration-engineer
 *     100  test-engineer
 *      38  review-agent
 *       …  (no discovery agent at any count)
 *
 * The cause is the same one cost-emitter.js was written to fix for spec-mode-runner: a call that
 * spawns ai-run.sh directly, rather than through a path that emits a cost_snapshot, is invisible.
 * ai-run.sh already writes the normalized result JSON to $ORCH_JSON_RESULT whenever that variable
 * is set — it simply was never asked to.
 *
 * The tests drive the real callLlm through a stubbed ai-run.sh that writes a cost record, and
 * require the snapshot to land in the activity log with discovery's own identity on it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'discovery-cost-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

/**
 * An ai-run.sh that behaves like the real one in the only respect this is about: it writes the
 * normalized result JSON to $ORCH_JSON_RESULT. If discovery never sets that variable, the stub
 * writes nothing and no snapshot can exist — which is the failure being guarded.
 */
function stubAiRun(answer: string): string {
  const p = join(work, 'stub-ai-run.sh');
  writeFileSync(p, [
    '#!/usr/bin/env bash',
    'if [ -n "${ORCH_JSON_RESULT:-}" ]; then',
    `  printf '%s' '{"total_cost_usd":0.0123,"usage":{"input_tokens":4096,"output_tokens":512}}' > "$ORCH_JSON_RESULT"`,
    'fi',
    `cat <<'JSON'`,
    answer,
    'JSON',
  ].join('\n'));
  spawnSync('chmod', ['+x', p]);
  return p;
}

/** Two git repos, so the scan has something to describe. */
function codelineRoot(): string {
  const root = join(work, 'codelines');
  for (const name of ['alpha-service', 'beta-service']) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
    writeFileSync(join(dir, 'README.md'), `# ${name}\n\nHandles the ${name} domain for the estate.\n`);
    spawnSync('git', ['-C', dir, 'init', '--quiet']);
  }
  return root;
}

function issuesFile(): string {
  const p = join(work, 'issues.json');
  writeFileSync(p, JSON.stringify([{
    jiraKey: 'W-1',
    title: 'Alpha rounds the wrong way',
    description: 'The alpha-service rounds a boundary value down instead of up.',
    components: ['alpha-service'],
  }]));
  return p;
}

/** Run discovery end to end against the stub, and return the activity log's lines. */
function runDiscovery(): Record<string, unknown>[] {
  const root = codelineRoot();
  const activity = join(work, 'agent-activity.jsonl');
  writeFileSync(activity, '');

  const answer = [
    '<DISCOVERY_VOCABULARY>',
    '{"blacklist":[{"term":"the","reason":"stopword","kind":"noise"}],"whitelist":[]}',
    '</DISCOVERY_VOCABULARY>',
    `{"codelines":[{"name":"alpha-service","path":"${root}/alpha-service","reason":"component","evidence":"the ticket component names it"}]}`,
  ].join('\n');

  const r = spawnSync(process.execPath, [
    join(SCRIPTS, 'lib/codeline-discovery.js'),
    '--issues', issuesFile(),
    '--root', root,
    '--out', join(work, 'discovery.json'),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE: stubAiRun(answer),
      ACTIVITY_FILE: activity,
      LOG_DIR: work,
      EPAM_BROWNFIELD: '1',
    },
  });
  expect(r.status, `discovery exited ${r.status}: ${r.stderr?.slice(-600)}`).toBe(0);

  if (!existsSync(activity)) return [];
  return readFileSync(activity, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('discovery records what it spends', () => {
  it('emits a cost snapshot for its model calls', () => {
    const snapshots = runDiscovery().filter((e) => e.type === 'cost_snapshot');
    expect(snapshots.length,
      'discovery made model calls and recorded no spend — the same invisibility cost-emitter.js '
      + 'was written to fix for spec-mode-runner',
    ).toBeGreaterThan(0);
  });

  it('records BOTH calls — the vocabulary agent and the matcher', () => {
    // One snapshot would mean only the second call is tracked, which is how a stage ends up
    // half-costed and still looks instrumented.
    const snapshots = runDiscovery().filter((e) => e.type === 'cost_snapshot');
    expect(snapshots.length, 'discovery makes two model calls; only some were recorded')
      .toBeGreaterThanOrEqual(2);
  });

  it('carries the cost the provider reported, not a zero', () => {
    const [first] = runDiscovery().filter((e) => e.type === 'cost_snapshot');
    const detail = first.detail as { costUsd: number; tokensIn: number; tokensOut: number };
    expect(detail.costUsd, 'the snapshot recorded no cost').toBeCloseTo(0.0123, 6);
    expect(detail.tokensIn, 'the snapshot recorded no input tokens').toBe(4096);
    expect(detail.tokensOut, 'the snapshot recorded no output tokens').toBe(512);
  });

  it('attributes the spend to discovery, not to whatever ran last', () => {
    const snapshots = runDiscovery().filter((e) => e.type === 'cost_snapshot');
    for (const s of snapshots) {
      expect(String(s.agent || ''),
        'a snapshot with no agent lands in the ledger as unattributed spend').toMatch(/discovery/i);
    }
  });
});
