/**
 * THE WRITER RECEIVES WHAT SELF-HEAL LEARNED.
 *
 * AMSD-2974 run 9 (2026-10-10): the analyst's diagnosis of a failed writer attempt is recorded as an episode under the
 * story's own agent (failure-healing.sh resolves the role from the PRD's agentRole when STORY_ROLE is unset) and synthesis
 * turns it into a constraint for that agent. The writer's next attempt loads constraints in story-attempt.sh with
 * `kb_apply_constraints "${STORY_ROLE:-}" "story:<id>"` — and STORY_ROLE is set by no writer-path caller, so the loader
 * returned at once on an empty role: every retry ran without what the KB had learned.
 *
 * EXECUTED: the real self-heal block lifted from lib/story-attempt.sh and the real kb-apply.sh / kb-cli.js, against a
 * KB holding one constraint for the story's agent and one episode for the story. Asserts the effect — the constraint
 * fired and its knob reached the shell — and the negatives: another agent's constraint does not fire, and a story with
 * no assigned agent applies nothing rather than guessing.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const STORY = 'T-1';

/** The writer's self-heal load block, exactly as story-attempt.sh has it. */
function writerLoadBlock(): string {
  const src = readFileSync(join(SCRIPTS, 'lib/story-attempt.sh'), 'utf8');
  const start = src.indexOf('# ── Self-heal KB (pillar 3: enforcement)');
  const end = src.indexOf('# Resolve aiProvider -> which CLI binary to use', start);
  if (start < 0 || end < 0) throw new Error('the writer\'s self-heal block was not found — harness is stale');
  return src.slice(start, end);
}

function run(opts: { agentRole?: string; constraintRole: string }) {
  const d = mkdtempSync(join(tmpdir(), 'writer-heal-'));
  const kb = join(d, 'kb'); mkdirSync(kb);
  const signature = 'class:verification-failed';
  writeFileSync(join(kb, 'constraints.json'), JSON.stringify([{
    id: `${opts.constraintRole}-raise-budget`, scope: { agent_role: opts.constraintRole }, trigger: { signature },
    enforcement: { kind: 'param', name: 'EPAM_MAX_ITERATIONS', value: 77 },
    reason: 'fixture', origin_episodes: ['evt-1'], ttl_cycles: 20, status: 'active', cycles_idle: 0,
  }], null, 2));
  writeFileSync(join(kb, 'healing-events.jsonl'), `${JSON.stringify({
    ts: '2026-10-10T00:00:00Z', id: 'evt-1', agent_role: opts.constraintRole, failure_class: 'verification-failed',
    story_id: STORY, phase: 'core', model: null, diagnosis: 'fixture', signature, signature_source: 'failure_class',
  })}\n`);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: STORY, ...(opts.agentRole ? { agentRole: opts.agentRole } : {}) }] }));
  const script = [
    'set -uo pipefail',
    'log(){ printf "%s\\n" "$*"; }',
    'kb_tick(){ :; }',
    `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}`,
    `PRD_FILE=${JSON.stringify(prd)}`,
    'STORY_MAX_ITERATIONS=10; STORY_MAX_OUTPUT_TOKENS=1000',
    'attempt(){',
    `  local story_id=${JSON.stringify(STORY)}`,
    writerLoadBlock(),
    '  printf "FIRED=%s\\nMAXITER=%s\\n" "${KB_LAST_FIRED:-}" "${EPAM_MAX_ITERATIONS:-unset}"',
    '}',
    'attempt',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', NODE_BIN: process.execPath, EPAM_PROJECT_CONFIG_DIR: d },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const field = (k: string) => (out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
  return { out, fired: field('FIRED'), maxIter: field('MAXITER') };
}

describe('the writer\'s next attempt receives the constraint learned for its own agent', () => {
  it('STORY_ROLE unset (as every writer caller leaves it): the story\'s agent is resolved and its constraint fires', () => {
    const r = run({ agentRole: 'toast-engineer', constraintRole: 'toast-engineer' });
    expect(r.fired, `the block did not run to its report:\n${r.out}`).toBeDefined();
    expect(r.fired, `nothing applied — the writer retries without what self-heal learned:\n${r.out}`).toBe('toast-engineer-raise-budget');
    expect(r.maxIter, 'the constraint fired but its knob never reached the shell').toBe('77');
  });

  it('another agent\'s constraint does not fire for this story', () => {
    const r = run({ agentRole: 'toast-engineer', constraintRole: 'someone-else' });
    expect(r.fired, r.out).toBe('');
    expect(r.maxIter).toBe('unset');
  });

  it('a story with no assigned agent applies nothing — no role is guessed', () => {
    const r = run({ constraintRole: 'toast-engineer' });
    expect(r.fired, r.out).toBe('');
    expect(r.maxIter).toBe('unset');
  });
});
