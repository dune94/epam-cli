/**
 * A CRITERION A REMEDIATOR PROPOSES IS JUDGED BY THE PRD-CHANGE REVIEWER BEFORE IT REACHES THE PLAN.
 *
 * AMSD-2974 rehearsal rv3 (2026-10-14, live tokens): the review remediator turned each review's findings into new
 * criteria — one demanded that a test "refactor the makeHeaderPortal call to a named-parameter object" — and wrote
 * them straight into the PRD. The failure-analyst's criteria are judged by the prd-change-reviewer agent; the gate,
 * review and lint remediators wrote theirs with no agent judging them. Operator: "Agentic only ... correct the agentic
 * process around this for root cause." Every remediator now goes through the same reviewer: apply_reviewed_acs.
 *
 * EXECUTED at £0: the real apply_reviewed_acs and the real run_prd_change_reviewer, from a scripts directory where only
 * ai-run.sh — the model — is a stand-in. It judges from what it was shown: a criterion carrying the planted marker
 * fails, anything else passes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintProjectPrompts } from '../../helpers/project-prompts';

const REAL = join(__dirname, '../../../orchestrations/scripts');
const AGENTS = join(__dirname, '../../../orchestrations/agents');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A scripts dir of links to the real one, with ai-run.sh replaced by the stand-in model. */
function scripts(d: string, gateUp = true) {
  const s = join(d, 'scripts'); mkdirSync(s);
  for (const f of readdirSync(REAL)) if (f !== 'ai-run.sh') symlinkSync(join(REAL, f), join(s, f));
  writeFileSync(join(s, 'ai-run.sh'), `#!/usr/bin/env bash
p=$(cat); printf '%s' "$p" > "${d}/reviewer-prompt.txt"
${gateUp ? '' : 'exit 1'}
case "$p" in *PLANTED_BAD*) echo '{"verdict":"fail","issues":["prescribes the form of a test, not a behaviour"]}' ;; *) echo '{"verdict":"pass","issues":[]}' ;; esac
`);
  chmodSync(join(s, 'ai-run.sh'), 0o755);
  return s;
}

function apply(acs: string[], opts: { gateUp?: boolean; applier?: string; key?: string; orchestrator?: boolean; agentsDirOnly?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'reviewed-acs-')); dirs.push(d);
  const s = scripts(d, opts.gateUp !== false);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S', acceptanceCriteria: ['the plan criterion'] }] }));
  writeFileSync(join(d, 'profiles.json'), readFileSync(join(AGENTS, 'profiles.canonical.json'), 'utf8'));
  const raw = join(d, 'raw.txt');
  writeFileSync(raw, `remediator says:\n${JSON.stringify({ story_id: 'S', [opts.key || 'acs']: acs })}`);
  const r = spawnSync('bash', ['-c', `
    SCRIPT_DIR=${JSON.stringify(s)}; LOG_DIR=${JSON.stringify(d)}; ORCH_GATE_PROVIDER=stub; export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(mintProjectPrompts())}; ${opts.agentsDirOnly ? `EPAM_AGENTS_DIR=${JSON.stringify(d)}` : `${opts.orchestrator ? 'AGENT_PROFILES_FILE' : 'profiles_file'}=${JSON.stringify(join(AGENTS, 'profiles.canonical.json'))}`}
    log(){ echo "LOG $*" >&2; }; warning(){ echo "WARN $*" >&2; }; error(){ echo "ERR $*" >&2; }; success(){ echo "OK $*" >&2; }
    seam_model_or_fail(){ echo stub-model; }
    . "$SCRIPT_DIR/lib/reviewed-acs.sh"
    apply_reviewed_acs ${JSON.stringify(prd)} S ${JSON.stringify(raw)} ${opts.applier || 'ac-apply.py'}`], { encoding: 'utf8', timeout: 60000 });
  const story = JSON.parse(readFileSync(prd, 'utf8')).stories[0];
  const texts = story.acceptanceCriteria.map((a: unknown) => (typeof a === 'string' ? a : (a as { text: string }).text));
  let prompt = ''; try { prompt = readFileSync(join(d, 'reviewer-prompt.txt'), 'utf8'); } catch { /* never called */ }
  return { added: r.stdout.trim(), err: r.stderr, texts, prompt };
}

describe('a remediator\'s criteria are judged before they reach the plan', () => {
  it('the reviewer approves: the criterion is added, and the reviewer saw it', () => {
    const r = apply(['the toast is announced as a status message']);
    expect(r.added, r.err).toBe('1');
    expect(r.texts).toContain('the toast is announced as a status message');
    expect(r.prompt).toContain('the toast is announced as a status message');
  });

  it('the reviewer rejects: NOTHING reaches the plan — the plan is byte-for-byte as it was', () => {
    const r = apply(['PLANTED_BAD the test must call makeHeaderPortal with a named-parameter object']);
    expect(r.added, r.err).toBe('0');
    expect(r.texts).toEqual(['the plan criterion']);
    expect(r.err).toMatch(/REJECTED|rejected|not approved/i);
  });

  it('a reviewer that cannot run is not an approval — nothing is added', () => {
    const r = apply(['the toast is announced as a status message'], { gateUp: false });
    expect(r.added, r.err).toBe('0');
    expect(r.texts).toEqual(['the plan criterion']);
  });

  it('in the orchestrator, which names the roster AGENT_PROFILES_FILE, the reviewer still judges — and approves', () => {
    const r = apply(['the toast is announced as a status message'], { orchestrator: true });
    expect(r.added, r.err).toBe('1');
  });

  it('where only the agents directory is known (the gates\' own scope), the reviewer still has its profile and approves', () => {
    const r = apply(['the toast is announced as a status message'], { agentsDirOnly: true });
    expect(r.added, r.err).toBe('1');
  });

  it('the lint remediator goes through the same reviewer', () => {
    const r = apply(['PLANTED_BAD lint must be satisfied by renaming the variable'], { applier: 'lint-ac.py', key: 'new_acs' });
    expect(r.added, r.err).toBe('0');
    expect(r.prompt).toContain('PLANTED_BAD');
  });
});
