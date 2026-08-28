/**
 * A RESUME USES THE ROSTER IT IS RESUMING WITH.
 *
 * WRITTEN BEFORE THE FIX. FOUND WHILE ASSEMBLING LAUNCH PARAMETERS, 2026-08-13.
 *
 * The checkpoint machinery decides what a resume skips, and for every stage past the mint it says:
 *
 *     post-roster)
 *       # The roster and the assignments are on disk and the mint is not repeated —
 *       # re-minting would propose against an already-minted roster and the merge is
 *       # additive, so a resume would accumulate near-duplicate roles.
 *       echo "EPAM_SKIP_AGENT_MINT=1"
 *
 * The orchestrator then overrides it:
 *
 *     if [ "${EPAM_SKIP_AGENT_MINT:-0}" != "1" ] || [ -n "${EPAM_RESUME_RUN:-}" ]; then
 *
 * The `||` means setting a resume id FORCES the mint on, exactly contradicting the instruction the
 * checkpoint just issued. Every checkpoint-based resume re-mints, and because the merge is
 * additive it accumulates near-duplicate roles on each one. The operator has already had a run
 * where the roster changed underneath them and said so in plain terms.
 *
 * THE FIX MUST NOT SIMPLY DELETE THE CLAUSE. Whatever it was reaching for, the danger it guards
 * against is real: skipping the mint when no roster exists would hand stories to agents that were
 * never defined. So the skip is honoured, and a MISSING roster becomes a loud refusal instead of a
 * silent re-mint — the same shape as every other guard here: never guess, never proceed on
 * unknown state.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The REAL decision, lifted from the script and executed — never a paraphrase of it. */
function mintDecision(env: Record<string, string>, opts: { roster?: unknown } = {}): string {
  const src = readFileSync(ORCH, 'utf8');
  const start = src.indexOf('  if [ "${EPAM_SKIP_AGENT_MINT:-0}"');
  expect(start, 'the mint decision moved — this test is anchored on it').toBeGreaterThan(0);
  // Up to the mint invocation itself; the branch body is replaced by a marker below.
  const end = src.indexOf('log "[jira] Minting project agents and assigning roles..."', start);
  expect(end).toBeGreaterThan(start);
  const decision = src.slice(start, end);

  const dir = mkdtempSync(join(tmpdir(), 'mint-decision-')); dirs.push(dir);
  const agentsDir = join(dir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  if (opts.roster !== undefined) {
    writeFileSync(join(agentsDir, 'profiles.json'), JSON.stringify(opts.roster));
  }

  const assignments = env.EPAM_SKIP_AGENT_MINT === '1' ? '' : '';
  // Wrapped in a function because that is where it lives: the block uses `return 1` to abandon
  // the pipeline, which is a syntax error at top level and would let execution carry on.
  const script = `set -uo pipefail
EPAM_AGENTS_DIR=${JSON.stringify(agentsDir)}
${Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n')}
NODE_BIN=${JSON.stringify(process.execPath)}
log() { printf '%s\\n' "$*"; }
error() { printf 'ERROR %s\\n' "$*"; }
_run_jira_pipeline() {
${decision}
  echo MINTED
else
  echo USED_EXISTING_ROSTER
fi
}
_run_jira_pipeline || echo "PIPELINE_REFUSED"
${assignments}`;
  try {
    return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
  } catch (e: any) {
    return `EXIT_${e.status}: ${((e.stdout || '') + (e.stderr || '')).trim()}`;
  }
}

const ROSTER = { profiles: { 'contentstack-live-preview-integration-engineer': 'brief' } };

describe('A RESUME KEEPS ITS ROSTER', () => {
  it('a resume told to skip the mint does NOT mint', () => {
    // The live case: the checkpoint says skip, the orchestrator mints anyway, and the roster the
    // operator settled on accumulates near-duplicate roles.
    const out = mintDecision(
      { EPAM_SKIP_AGENT_MINT: '1', EPAM_RESUME_RUN: '20260813T004900Z' },
      { roster: ROSTER },
    );
    expect(out, 'a resume re-minted the roster it was told to keep').not.toContain('MINTED');
    expect(out).toContain('USED_EXISTING_ROSTER');
  });

  it('a NON-resume run with the skip set also does not mint', () => {
    const out = mintDecision({ EPAM_SKIP_AGENT_MINT: '1' }, { roster: ROSTER });
    expect(out).toContain('USED_EXISTING_ROSTER');
  });
});

describe('A FRESH RUN STILL MINTS', () => {
  it('no skip means the mint runs, as it always has', () => {
    // The counterweight: fixing the override must not stop a first run from building a roster.
    expect(mintDecision({}, { roster: undefined })).toContain('MINTED');
  });

  it('an explicit skip=0 mints', () => {
    expect(mintDecision({ EPAM_SKIP_AGENT_MINT: '0' }, { roster: ROSTER })).toContain('MINTED');
  });
});

describe('SKIPPING A ROSTER THAT IS NOT THERE IS REFUSED, NOT GUESSED', () => {
  it('skip with NO roster on disk fails loudly instead of running storyless', () => {
    // Whatever the `|| resume` clause was reaching for, this is the danger worth keeping: skipping
    // the mint when nothing was ever minted would hand stories to agents that do not exist. The
    // pipeline's rule everywhere else is to refuse rather than proceed on unknown state.
    const out = mintDecision(
      { EPAM_SKIP_AGENT_MINT: '1', EPAM_RESUME_RUN: '20260813T004900Z' },
      { roster: undefined },
    );
    expect(out, 'a resume skipped the mint with no roster on disk and carried on')
      .not.toContain('USED_EXISTING_ROSTER');
    expect(out, 'the pipeline continued instead of refusing').toContain('PIPELINE_REFUSED');
    expect(out, 'the refusal did not say what was missing').toMatch(/roster|profiles/i);
  });

  it('an EMPTY roster counts as no roster', () => {
    const out = mintDecision(
      { EPAM_SKIP_AGENT_MINT: '1', EPAM_RESUME_RUN: 'r' },
      { roster: { profiles: {} } },
    );
    expect(out, 'an empty roster was accepted as a settled one').not.toContain('USED_EXISTING_ROSTER');
  });
});
