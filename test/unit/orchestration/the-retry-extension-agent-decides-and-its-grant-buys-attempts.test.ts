/**
 * THE RETRY-EXTENSION AGENT DECIDES, AND WHAT IT GRANTS BUYS ATTEMPTS.
 *
 * Assessed 2026-10-08 across every run on disk: the coordinator (lib/retry-extension.sh) had never granted an extension.
 *  - AMSD-2974: 4 decisions, all by a deterministic veto (HEALING_BROKEN ever) — the agent was never asked — and none
 *    recorded: the decisions ledger was empty.
 *  - regintel: 4 calls, all "coordinator unavailable", the reason thrown away with stderr.
 *  - Its "distinct_diagnoses" counted exact strings, the healing check paraphrases: three wordings of one bug were
 *    "3 distinct, treat as ground truth" to the agent, which then granted retries for a repeat.
 * Operator, 2026-10-08: the agent decides (the repeats are its evidence), every outcome is recorded, the call's errors
 * are kept, one definition of a repeated root cause.
 *
 * EXECUTED: the engine loaded as claude.sh loads it (sourced, every library), with only the model runner (ai-run.sh)
 * replaced. Part 1 calls run_retry_extension_coordinator; part 2 runs the real implement_story to exhaustion and asserts
 * the loop starts another attempt after a grant — and does not without one.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

type Reply = { extend: boolean; extraRetries: number; reason: string } | 'fail';

function engine(opts: { reply: Reply; heal?: object[]; enabled?: boolean; implement?: boolean; noPersona?: boolean }) {
  const d = mkdtempSync(join(tmpdir(), 'retry-ext-')); dirs.push(d);
  const shadow = join(d, 'scripts'); mkdirSync(shadow);
  // $(dirname SCRIPT_DIR)/agents is where the coordinator reads its persona, as in a run.
  if (!opts.noPersona) symlinkSync(join(ROOT, 'orchestrations/agents'), join(d, 'agents'));
  for (const e of readdirSync(SCRIPTS)) if (e !== 'ai-run.sh' && e !== 'update-monitor.sh') symlinkSync(join(SCRIPTS, e), join(shadow, e));
  // The model. The coordinator's prompt is kept per call; a writer attempt fails; a failed coordinator call says why.
  const reply = opts.reply === 'fail' ? '' : JSON.stringify(opts.reply);
  writeFileSync(join(shadow, 'ai-run.sh'), `#!/usr/bin/env bash
p="$(cat)"; echo "\${EPAM_AGENT_NAME:-?}" >> ${JSON.stringify(join(d, 'calls'))}
if [ "\${EPAM_AGENT_NAME:-}" = "retry-extension-coordinator" ]; then
  printf '%s' "$p" > ${JSON.stringify(join(d, 'coordinator-prompt.txt'))}
  ${opts.reply === 'fail' ? 'echo "provider refused: model not available" >&2; exit 7' : `printf '%s' ${JSON.stringify(reply)}`}
  exit 0
fi
echo '{"type":"result","is_error":true,"result":"could not finish"}'; exit 1
`);
  writeFileSync(join(shadow, 'update-monitor.sh'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(shadow, 'ai-run.sh'), 0o755); chmodSync(join(shadow, 'update-monitor.sh'), 0o755);
  const logs = join(d, 'logs'); mkdirSync(logs);
  for (const e of opts.heal ?? []) writeFileSync(join(logs, 'healing-events.jsonl'), `${JSON.stringify(e)}\n`, { flag: 'a' });
  const project = join(d, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'roster.json'), JSON.stringify({ agents: { 'toast-messaging-engineer': { kind: 'implementer', persona: 'You implement toast messaging.' } } }));
  const cl = join(d, 'codeline'); mkdirSync(cl);
  const git = (...a: string[]) => spawnSync('git', ['-C', cl, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]);
  git('init', '-q', '-b', 'develop'); writeFileSync(join(cl, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-qm', 'base'); git('checkout', '-q', '-b', 'bugfix/AI-S-1');
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ implementationOrder: { core: ['S-1'] }, stories: [{ id: 'S-1', phase: 'core', title: 't', agentRole: 'toast-messaging-engineer', status: 'in-progress', acceptanceCriteria: ['a', 'b', 'c', 'd', 'e', 'f'], technicalNotes: { files: ['a.txt'] } }] }));
  const call = opts.implement
    ? 'MAX_RETRIES=1; implement_story S-1; echo "RC=$?"'
    : 'retry_count=12; MAX_RETRIES=11; echo "GRANTED=$(run_retry_extension_coordinator S-1)"';
  const sh = join(d, 'run.sh');
  writeFileSync(sh, `cd ${JSON.stringify(cl)}\n. "$SCRIPT_DIR/claude.sh"\nset +e\n${call}\n`);
  const r = spawnSync('bash', [sh], {
    encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env, SCRIPT_DIR: shadow, AUTOMATION_DIR: join(ROOT, 'orchestrations'), NODE_BIN: process.execPath,
      PROJECT_ROOT: cl, OUTPUT_DIR: cl, PRD_FILE: prd, MAIN_PRD_FILE: prd, LOG_DIR: logs, PHASE: 'core', EPAM_PROJECT_CONFIG_DIR: project,
      ORCH_GATE_PROVIDER: 'copilot', EPAM_RETRY_EXTENSION_ENABLED: opts.enabled === false ? '0' : '1', EPAM_RETRY_EXTENSION_MAX: '2', RETRY_DELAY: '0', TMPDIR: d,
    },
  });
  const out = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  if (process.env.RX_DEBUG) console.log(out.slice(-2500));
  const ledgerFile = join(logs, 'retry-extension-decisions.jsonl');
  const ledger = existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const prompt = existsSync(join(d, 'coordinator-prompt.txt')) ? readFileSync(join(d, 'coordinator-prompt.txt'), 'utf8') : '';
  const calls = existsSync(join(d, 'calls')) ? readFileSync(join(d, 'calls'), 'utf8').trim().split('\n') : [];
  const errlog = existsSync(join(logs, 'retry-extension-coordinator.log')) ? readFileSync(join(logs, 'retry-extension-coordinator.log'), 'utf8') : '';
  return { out, ledger, prompt, calls, errlog, granted: Number((/GRANTED=(\d+)/.exec(out) || [])[1] ?? -1) };
}

const ev = (retry: number, diagnosis: string, extra: object = {}) => ({ ts: 't', story_id: 'S-1', retry, rung: Math.floor(retry / 2), target: 'skill', diagnosis, patches_applied: 0, ...extra });
const CONVERGING = [ev(0, 'the toast region lacks role=status'), ev(1, 'the close button has no accessible name'), ev(2, 'errors are announced with role=status instead of role=alert'), ev(3, 'focus is not returned to the trigger on close')];
const PARAPHRASED = [ev(0, 'the close button has no accessible name'), ev(1, 'the close button still has no accessible name'), ev(2, 'close button accessible name is still missing')];
const BROKEN = [...PARAPHRASED, { ...ev(2, 'close button accessible name is still missing'), event: 'HEALING_BROKEN', repeated_diagnosis: 'close button accessible name is still missing', count: 2 }];
const YES = { extend: true, extraRetries: 3, reason: '4 distinct root causes, groundedness 0.82' };
const NO = { extend: false, extraRetries: 0, reason: 'one root cause recurred 3 times' };

describe('the coordinator: the agent decides on the whole evidence', () => {
  it('converging: the agent is asked, its grant is capped at the role maximum, and the decision is recorded', () => {
    const r = engine({ reply: YES, heal: CONVERGING });
    expect(r.calls, r.out).toEqual(['retry-extension-coordinator']);
    expect(r.granted).toBe(2);
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]).toMatchObject({ decidedBy: 'agent', extend: true, extraRetriesGranted: 2 });
    expect(r.ledger[0].evidence.distinct_diagnoses).toBe(4);
    expect(r.prompt, 'the agent was asked with an empty prompt').toContain('retry-extension coordinator');
    expect(r.prompt).toContain('"distinct_diagnoses":4');
  });

  it('HEALING_BROKEN no longer vetoes: the agent is asked, and sees the repeated root cause', () => {
    const r = engine({ reply: NO, heal: BROKEN });
    expect(r.calls, r.out).toEqual(['retry-extension-coordinator']);
    expect(r.prompt).toContain('repeated_root_causes');
    expect(r.prompt).toContain('close button accessible name is still missing');
    expect(r.prompt).not.toMatch(/Every self-heal attempt so far produced a DISTINCT diagnosis/);
    expect(r.granted).toBe(0);
    expect(r.ledger[0]).toMatchObject({ decidedBy: 'agent', extend: false, extraRetriesGranted: 0 });
    expect(r.ledger[0].evidence.healing_broken_ever).toBe(true);
  });

  it('three wordings of one root cause are ONE distinct root cause — the same definition the healing check uses', () => {
    const r = engine({ reply: NO, heal: PARAPHRASED });
    expect(r.ledger[0].evidence.distinct_diagnoses, r.out).toBe(1);
    expect(r.ledger[0].evidence.total_heal_events).toBe(3);
  });

  it('a failed call grants nothing, is recorded as such, and keeps its reason', () => {
    const r = engine({ reply: 'fail', heal: CONVERGING });
    expect(r.granted, r.out).toBe(0);
    expect(r.ledger[0]).toMatchObject({ decidedBy: 'agent-unavailable', extend: false, extraRetriesGranted: 0 });
    expect(r.errlog).toContain('provider refused: model not available');
  });

  // Found writing this test: a prompt that failed to render was sent anyway — the agent answered an empty page.
  it('a prompt that does not render is never sent: no call, nothing granted, recorded', () => {
    const r = engine({ reply: YES, heal: CONVERGING, noPersona: true });
    expect(r.out).toMatch(/prompt did not render/);
    expect(r.calls).toEqual([]);
    expect(r.granted).toBe(0);
    expect(r.ledger[0]).toMatchObject({ decidedBy: 'prompt-unrendered', extraRetriesGranted: 0 });
  });

  it('disabled: no agent call, and the ledger says so', () => {
    const r = engine({ reply: YES, heal: CONVERGING, enabled: false });
    expect(r.calls).toEqual([]);
    expect(r.granted).toBe(0);
    expect(r.ledger[0]).toMatchObject({ decidedBy: 'disabled', extraRetriesGranted: 0 });
  });
});

describe('implement_story: a grant buys attempts', () => {
  it('the retries spent, the agent grants: the loop starts another attempt past the old ceiling', () => {
    const r = engine({ reply: YES, heal: CONVERGING, implement: true });
    expect(r.out).toMatch(/\[RetryExtension\] S-1: extending by 2/);
    expect(r.out, 'no attempt ran after the grant').toMatch(/InferenceLadder\[Rung1\/R2\]/);
    expect(r.ledger[0]).toMatchObject({ decidedBy: 'agent', extraRetriesGranted: 2 });
  });

  it('the agent declines: no attempt past the ceiling, the story fails there', () => {
    const r = engine({ reply: NO, heal: CONVERGING, implement: true });
    expect(r.calls).toContain('retry-extension-coordinator');
    expect(r.out).not.toMatch(/R2\]/);
    expect(r.out).toMatch(/Failed to implement S-1 after 2 attempts/);
    expect(r.ledger[0]).toMatchObject({ decidedBy: 'agent', extraRetriesGranted: 0 });
  });
});
