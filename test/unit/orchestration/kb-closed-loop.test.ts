/**
 * The self-heal loop must actually CLOSE.
 *
 * record → synthesize → apply → tick
 *
 * Found 2026-07-25 by tracing callers rather than trusting the flag: `record` and
 * `apply` are both wired into claude.sh (guarded by EPAM_KB_SELFHEAL), but nothing
 * anywhere calls `synthesize` or the arbitration TTL `tick`. So even with the flag
 * ON the loop is record → apply-finds-nothing, forever: episodes accumulate, no
 * constraint is ever created, and `apply` has nothing to look up. The KB would be
 * write-only, and — worse — it would LOOK enabled.
 *
 * (The earlier claim in this session that the KB had "zero callers" was wrong: it
 * came from a grep that excluded lib/kb-*, which is where every caller goes
 * through. The real defect is narrower and more specific than "not wired".)
 *
 * This test drives the whole loop through the shell seam the pipeline uses, so it
 * fails if any link is missing:
 *   1. two failures with the same signature are recorded as episodes
 *   2. synthesis turns them into ONE arbitrated, schema-valid constraint
 *   3. apply compiles that constraint to env — never prose
 *   4. tick ages rules that did not fire, so stale knowledge expires
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const KB_CLI = join(SCRIPTS, 'lib/kb-cli.js');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'kb-loop-'));
  dirs.push(root);
  return root;
}

/** Stub standing in for ai-run.sh so synthesis calls no model. */
function stubRunner(json: string) {
  const d = mkdtempSync(join(tmpdir(), 'kb-loop-run-'));
  dirs.push(d);
  const p = join(d, 'runner.sh');
  writeFileSync(p, `#!/usr/bin/env bash\ncat >/dev/null\ncat <<'JSONEOF'\n${json}\nJSONEOF\n`);
  chmodSync(p, 0o755);
  return p;
}

function cli(root: string, args: string[], extraEnv: Record<string, string> = {}) {
  return execFileSync(NODE20, [KB_CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KB_ROOT: root, ...extraEnv },
  }).trim();
}

const SIG = 'TS2532';
const ROLE = 'impl-agent';
const RULE = JSON.stringify({
  enforcement: { kind: 'param', name: 'EPAM_REASONING_EFFORT', value: 'high' },
  reason: 'agent exhausted turns before writing the deliverable',
});

describe('self-heal loop — record → synthesize → apply → tick', () => {
  it('closes: two episodes become a constraint that compiles to enforcement', () => {
    const root = sandbox();

    // 1. RECORD — same signature twice (the synthesis threshold).
    for (let i = 0; i < 2; i++) {
      const sig = execFileSync(NODE20,
        [KB_CLI, 'record', '--agent-role', ROLE, '--story', 'S-1', '--id', `ep-${i}`],
        { encoding: 'utf8', input: `src/foo.ts(12,5): error ${SIG}: Object is possibly 'undefined'.`,
          env: { ...process.env, KB_ROOT: root } }).trim();
      expect(sig, 'record did not derive a signature from the tool output').toBeTruthy();
    }

    // 2. SYNTHESIZE — must exist as a pipeline-reachable command.
    const out = cli(root, ['synthesize-auto', '--agent-role', ROLE, '--signature', SIG],
      { AI_RUNNER_CMD: stubRunner(RULE) });
    expect(out, 'no constraint id returned — synthesis is not reachable from the CLI').toBeTruthy();

    const constraints = JSON.parse(readFileSync(join(root, 'constraints.json'), 'utf8'));
    expect(constraints.length, 'synthesis produced no stored constraint').toBe(1);

    // 3. APPLY — compiles to env exports, and to nothing else.
    const applied = cli(root, ['apply', '--agent-role', ROLE, '--signatures', SIG]);
    expect(applied).toMatch(/export EPAM_REASONING_EFFORT=/);
    expect(applied).toMatch(/export KB_FIRED=/);
    expect(applied,
      'the human-readable reason leaked into the applied output — enforcement only, never prose')
      .not.toMatch(/exhausted turns/);
  });

  it('tick ages a rule that never fires, so stale knowledge expires', () => {
    const root = sandbox();
    execFileSync(NODE20, [KB_CLI, 'record', '--agent-role', ROLE, '--story', 'S-1', '--id', 'e1'],
      { encoding: 'utf8', input: `src/foo.ts(12,5): error ${SIG}: Object is possibly 'undefined'.`, env: { ...process.env, KB_ROOT: root } });
    execFileSync(NODE20, [KB_CLI, 'record', '--agent-role', ROLE, '--story', 'S-1', '--id', 'e2'],
      { encoding: 'utf8', input: `src/foo.ts(12,5): error ${SIG}: Object is possibly 'undefined'.`, env: { ...process.env, KB_ROOT: root } });
    cli(root, ['synthesize-auto', '--agent-role', ROLE, '--signature', SIG],
      { AI_RUNNER_CMD: stubRunner(RULE) });

    const before = JSON.parse(readFileSync(join(root, 'constraints.json'), 'utf8'))[0];
    expect(before.cycles_idle).toBe(0);

    // A cycle in which NOTHING fired.
    cli(root, ['tick', '--fired', '']);

    const after = JSON.parse(readFileSync(join(root, 'constraints.json'), 'utf8'))[0];
    expect(after.cycles_idle,
      'tick is not reachable from the CLI, so no rule ever ages and stale knowledge is trusted forever')
      .toBe(1);
  });
});

describe('self-heal loop — the shell seam the pipeline actually uses', () => {
  it('kb-apply.sh exposes synthesis and tick, not just record and apply', () => {
    const src = readFileSync(join(SCRIPTS, 'lib/kb-apply.sh'), 'utf8');
    expect(src, 'no synthesis entry point — episodes accumulate but no rule is ever built')
      .toMatch(/kb_maybe_synthesize/);
    expect(src, 'no TTL entry point — rules never age out for re-validation')
      .toMatch(/kb_tick/);
  });

  it('claude.sh drives synthesis after recording a failure', () => {
    const src = readFileSync(join(SCRIPTS, 'claude.sh'), 'utf8');
    expect(src,
      'claude.sh records episodes but never synthesises, so apply can only ever find nothing')
      .toMatch(/kb_maybe_synthesize/);
  });
});
