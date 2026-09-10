/**
 * THE RUN'S TRUE COST WAS NOT DETERMINABLE FROM ITS OWN LEDGER.
 *
 * phase-cost.jsonl carries records from TWO emitters with FOUR status values, and every real call
 * is recorded TWICE:
 *
 *   - a writer call  -> `attempt` (claude.sh append_cost_record) + `completed` (terminal restatement)
 *   - an agent call  -> `agent`   (lib/cost-emitter.js)          + `completed` (terminal restatement)
 *
 * Nothing declared which rows were disjoint, so every consumer that summed the file double-counted.
 * On run 20260908T215555Z a naive sum reports $2.47 for a run that cost $1.2368.
 *
 * That is not only a reporting error. `claude.sh`'s budget guard and `check-phase-gate.sh` both sum
 * every row, so a story is halted at HALF its configured hard limit and a phase gate judges a run
 * twice as expensive as it was.
 *
 * The rule, derived from the data and now declared in ONE place: a row is BILLABLE when its status
 * is `attempt` or `agent`. Terminal rows (`completed`, `failed`) restate a call already recorded.
 * Proof that the rule is right and complete: summing the billable rows and summing the terminal
 * rows give the SAME total from opposite directions — $1.2368 either way.
 *
 * The fixture is a real ledger from a real run, copied byte-for-byte, never hand-authored.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/ledger-tokens.sh');
const FIXTURE = join(ROOT, 'test/fixtures/ledger/real-run-20260908T215555Z.jsonl');

/** Run a shell snippet with the ledger library sourced. */
function sh(body: string, stdinFile?: string) {
  const d = mkdtempSync(join(tmpdir(), 'ledger-'));
  const s = join(d, 'h.sh');
  writeFileSync(s, `#!/usr/bin/env bash\nset -uo pipefail\nsource "${LIB}"\n${body}\n`);
  const r = spawnSync('bash', [s], {
    encoding: 'utf8', timeout: 60_000,
    input: stdinFile ? readFileSync(stdinFile, 'utf8') : undefined,
  });
  rmSync(d, { recursive: true, force: true });
  return { out: (r.stdout ?? '').trim(), err: r.stderr ?? '', status: r.status };
}

const rows = () => readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const round = (n: number) => Math.round(n * 10000) / 10000;

describe('the ledger has ONE definition of what a run cost', () => {
  it('the fixture really is the ambiguous shape this exists to resolve', () => {
    const s = new Set(rows().map((r) => r.status ?? '(none)'));
    expect(s.has('attempt') && s.has('agent') && s.has('completed'),
      `fixture no longer carries the overlapping statuses: ${[...s].join(',')}`).toBe(true);
    const naive = round(rows().reduce((a, r) => a + Number(r.task_cost_usd || 0), 0));
    expect(naive, 'the naive sum is no longer the double-counted figure').toBe(2.4736);
  });

  it('sums the billable rows to the run\'s real cost, not the double count', () => {
    const r = sh(`ledger_total_cost`, FIXTURE);
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    expect(round(Number(r.out)), `got ${r.out}`).toBe(1.2368);
  });

  it('agrees with the terminal rows summed from the opposite direction', () => {
    const terminal = round(rows()
      .filter((x) => x.status === 'completed' || x.status === 'failed')
      .reduce((a, x) => a + Number(x.task_cost_usd || 0), 0));
    const billable = round(Number(sh(`ledger_total_cost`, FIXTURE).out));
    expect(billable, 'the two views disagree — the disjoint rule is wrong').toBe(terminal);
  });

  it('counts EVERY attempt of a retried story, not just its terminal record', () => {
    const d = mkdtempSync(join(tmpdir(), 'ledger-f-'));
    const f = join(d, 'l.jsonl');
    const mk = (status: string, attempt: number | null, cost: number) =>
      JSON.stringify({ story_id: 'S-1', agent_name: 'w', status, attempt, task_cost_usd: cost });
    // Three real attempts, then one terminal record restating the last.
    writeFileSync(f, [mk('attempt', 1, 1), mk('attempt', 2, 2), mk('attempt', 3, 4), mk('failed', null, 4)].join('\n'));
    const r = sh(`ledger_total_cost`, f);
    rmSync(d, { recursive: true, force: true });
    expect(Number(r.out), 'a retried story must bill all three attempts and not the restatement').toBe(7);
  });

  it('ignores a row with no status — a marker is not a call', () => {
    const d = mkdtempSync(join(tmpdir(), 'ledger-n-'));
    const f = join(d, 'l.jsonl');
    writeFileSync(f, [JSON.stringify({ task_cost_usd: 99 }),
                      JSON.stringify({ status: 'agent', task_cost_usd: 1 })].join('\n'));
    const r = sh(`ledger_total_cost`, f);
    rmSync(d, { recursive: true, force: true });
    expect(Number(r.out)).toBe(1);
  });

  it('prints 0, never null, for an empty ledger', () => {
    const d = mkdtempSync(join(tmpdir(), 'ledger-e-'));
    const f = join(d, 'l.jsonl'); writeFileSync(f, '');
    const r = sh(`ledger_total_cost`, f);
    rmSync(d, { recursive: true, force: true });
    expect(r.out).toBe('0');
  });
});

/**
 * THE CALLER END. A rule declared in one place and not used by the consumers is not a fix — the
 * budget guard, the story guard and the phase gate are the three sites whose WRONG answers had
 * consequences, so each must be shown to source the library and apply the partition.
 */
describe('every consumer that sums the ledger uses the one rule', () => {
  const consumers: Array<[string, string]> = [
    ['orchestrations/scripts/claude.sh', 'the story budget guard — halted at HALF the hard limit'],
    ['orchestrations/scripts/lib/story-guards.sh', 'the per-story cost guard'],
    ['orchestrations/scripts/check-phase-gate.sh', 'the phase gate — judged every phase 2x'],
  ];

  for (const [rel, why] of consumers) {
    it(`${rel.split('/').pop()} applies the partition (${why})`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src.includes('ledger-tokens.sh'),
        `${rel} does not source the library, so LEDGER_BILLABLE_JQ expands EMPTY and its jq filter ` +
        'is malformed — which fails silently into an empty cost').toBe(true);
      expect(src.includes('LEDGER_BILLABLE_JQ'),
        `${rel} still sums every row, terminal restatements included`).toBe(true);
    });
  }

  it('the guards actually run with the rule applied — not just mention it', () => {
    // Executes the real filter against the real ledger, the way the guards now do.
    const r = sh(`jq -s "[.[] | \${LEDGER_BILLABLE_JQ} | (.task_cost_usd // 0)] | add // 0" "${FIXTURE}"`);
    expect(r.status, `the shared filter is not runnable: ${r.err}`).toBe(0);
    expect(round(Number(r.out))).toBe(1.2368);
  });
});
