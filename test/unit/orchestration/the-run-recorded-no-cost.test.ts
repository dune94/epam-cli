/**
 * THIS RUN RECORDED NO COST — three separate defects behind one message.
 *
 * Cost tracking is the operator's stated priority #1. The mock3 run of 2026-08-17 ended with:
 *
 *   [cost] THIS RUN RECORDED NO COST. 986 model-call result artefact(s) are on disk
 *   [cost] under .../orchestrations/logs, and .../phase-cost.jsonl holds 0 records.
 *
 * Digging into it found the detector was right about the ledger and wrong about the evidence, and
 * that two upstream defects were why the ledger was empty at all.
 *
 * 1. THE TOKEN KEYS. Two producers write the result JSON the cost parser reads, and they spell the
 *    token fields differently — claude.sh's path emits usage.input_tokens, the epam CLI's
 *    buildRunResultJson emits usage.inputTokens. Only snake_case was read, so every call through
 *    the epam provider recorded 0 tokens. Worse: a call whose provider reports $0 (MiniMax and GLM
 *    both do) then parsed as all-zeros and was DISCARDED as "nothing happened" — so costUnknown,
 *    the flag written so a dashboard shows "unknown" instead of a confident $0.00, could never
 *    fire on that path.
 *
 * 2. THE LEDGER NOBODY WROTE TO. JS-side agents emitted cost_snapshot to agent-activity.jsonl
 *    only. Every consumer of MONEY — dashboard, run report, calibrate.py, the cost-variance gate,
 *    the budget guard — reads phase-cost.jsonl, and only claude.sh ever wrote there. A run whose
 *    spend is dominated by the mint, the reviewers and the prompt builder recorded nothing.
 *
 * 3. THE STALE EVIDENCE. claude_outputs/ accumulates across every run and pre-run-reset
 *    deliberately never clears it, while phase-cost.jsonl IS reset per run — so the two sides of
 *    the comparison covered different spans of time. The "986 artefacts" were two days of OTHER
 *    runs; the 08-17 run produced none of its own. Unscoped, the count can never fall back to
 *    zero, so every future run inherits the same accusation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const EMITTER = join(SCRIPTS, 'lib/cost-emitter.js');
const LEDGER_SH = join(SCRIPTS, 'lib/cost-ledger.sh');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseCostRecord, emitCostSnapshot } = require(EMITTER);

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'cost-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

/** Exactly what src/cli/commands/run.ts buildRunResultJson emits. */
const EPAM_SHAPE = {
  result: 'x', model: 'z-ai/glm-5.2', provider: 'openrouter',
  usage: { inputTokens: 406314, outputTokens: 16254, totalTokens: 422568, cached_input_tokens: 299200 },
  cost_usd: 0.1626, cost_is_estimate: false,
};
/** Exactly what claude.sh's CLAUDE_CMD --output-format json path emits. */
const CLAUDE_SHAPE = {
  result: 'x', total_cost_usd: 0.1626,
  usage: { input_tokens: 406314, output_tokens: 16254 },
};

describe('the run recorded no cost', () => {
  describe('1. the two producers spell the token keys differently', () => {
    it('reads camelCase — the epam CLI path', () => {
      const c = parseCostRecord(JSON.stringify(EPAM_SHAPE));
      expect(c.tokensIn, 'every epam-path call recorded 0 input tokens').toBe(406314);
      expect(c.tokensOut).toBe(16254);
      expect(c.costUsd).toBe(0.1626);
    });

    it('still reads snake_case — the claude.sh path must not regress', () => {
      const c = parseCostRecord(JSON.stringify(CLAUDE_SHAPE));
      expect(c.tokensIn).toBe(406314);
      expect(c.tokensOut).toBe(16254);
    });

    it('records cached input separately, never folded into the input total', () => {
      // The two are billed at different rates; one number mixing them cannot be priced afterwards.
      const c = parseCostRecord(JSON.stringify(EPAM_SHAPE));
      expect(c.tokensCached).toBe(299200);
      expect(c.tokensIn, 'cached tokens were folded into the input count').toBe(406314);
    });

    it('A ZERO-COST CALL WITH REAL TOKENS IS FLAGGED, NOT DISCARDED', () => {
      // The live case: MiniMax-M3 / GLM report $0 while consuming tokens. All-zero parses were
      // dropped as "nothing happened", so the calls most needing a flag vanished entirely.
      const zero = { result: 'x', usage: { inputTokens: 34511, outputTokens: 3088 }, cost_usd: 0 };
      const c = parseCostRecord(JSON.stringify(zero));
      expect(c.costUnknown, 'a $0 call with 34k tokens was recorded as genuinely free').toBe(true);

      const res = join(work, 'r.json');
      const act = join(work, 'a.jsonl');
      writeFileSync(res, JSON.stringify(zero));
      const evt = emitCostSnapshot({
        resultFile: res, activityFile: act, ledgerFile: join(work, 'p.jsonl'), agent: 'x',
      });
      expect(evt, 'the zero-cost call emitted nothing at all — invisible spend').not.toBeNull();
      expect(evt.detail.costUnknown).toBe(true);
    });

    it('distinguishes "estimate" from "billed" from "nobody said"', () => {
      expect(parseCostRecord(JSON.stringify(EPAM_SHAPE)).costIsEstimate).toBe(false);
      expect(parseCostRecord(JSON.stringify({ ...EPAM_SHAPE, cost_is_estimate: true })).costIsEstimate).toBe(true);
      // null, not false: an estimate presented as confirmed spend is the bug the field prevents.
      expect(parseCostRecord(JSON.stringify(CLAUDE_SHAPE)).costIsEstimate).toBeNull();
    });

    it('a genuinely empty result still emits nothing', () => {
      const res = join(work, 'r.json');
      writeFileSync(res, JSON.stringify({ result: '' }));
      expect(emitCostSnapshot({
        resultFile: res, activityFile: join(work, 'a.jsonl'), agent: 'x',
      }), 'an empty record cluttered the timeline').toBeNull();
    });
  });

  describe('2. JS-side spend reaches the ledger every reader consumes', () => {
    it('writes phase-cost.jsonl, not only agent-activity.jsonl', () => {
      const res = join(work, 'r.json');
      const led = join(work, 'phase-cost.jsonl');
      writeFileSync(res, JSON.stringify(EPAM_SHAPE));
      process.env.ORCH_RUN_ID = '20260817T140130Z';
      emitCostSnapshot({
        resultFile: res, activityFile: join(work, 'a.jsonl'), ledgerFile: led,
        agent: 'prompt-builder', phase: 'scaffold', model: 'z-ai/glm-5.2', turns: 1,
      });
      expect(existsSync(led), 'the JS side still records spend where no reader looks').toBe(true);

      const rec = JSON.parse(readFileSync(led, 'utf8').trim());
      // Field names must match append_cost_record's exactly — a consumer must never need to know
      // which side of the pipeline paid.
      expect(rec.task_cost_usd).toBe(0.1626);
      expect(rec.task_tokens_in).toBe(406314);
      expect(rec.task_tokens_out).toBe(16254);
      expect(rec.cache_read_tokens).toBe(299200);
      expect(rec.agent_id).toBe('prompt-builder');
    });

    it('every ledger record is run-stamped', () => {
      // The budget guard filters by run precisely so one run is never charged for another's spend.
      const res = join(work, 'r.json');
      const led = join(work, 'phase-cost.jsonl');
      writeFileSync(res, JSON.stringify(EPAM_SHAPE));
      process.env.ORCH_RUN_ID = '20260817T140130Z';
      emitCostSnapshot({ resultFile: res, activityFile: join(work, 'a.jsonl'), ledgerFile: led, agent: 'x' });
      expect(JSON.parse(readFileSync(led, 'utf8').trim()).run_id).toBe('20260817T140130Z');
    });

    it('agent spend is not attributed to a story', () => {
      // A reader summing by story must not silently pick up the mint's cost.
      const res = join(work, 'r.json');
      const led = join(work, 'phase-cost.jsonl');
      writeFileSync(res, JSON.stringify(EPAM_SHAPE));
      emitCostSnapshot({ resultFile: res, activityFile: join(work, 'a.jsonl'), ledgerFile: led, agent: 'mint' });
      const rec = JSON.parse(readFileSync(led, 'utf8').trim());
      expect(rec.story_id).toBeNull();
      expect(rec.status, 'agent records are indistinguishable from story terminal states')
        .toBe('agent');
    });
  });

  describe('3. the evidence is scoped to THIS run', () => {
    function evidence(runId: string, logDir: string) {
      const r = spawnSync('bash', ['-c',
        `. ${JSON.stringify(LEDGER_SH)}
         error(){ echo "ERR: $*" >&2; }; warning(){ echo "WARN: $*" >&2; }
         export LOG_DIR=${JSON.stringify(logDir)}
         export PHASE_COST_FILE=${JSON.stringify(join(logDir, 'empty.jsonl'))}
         : > "$PHASE_COST_FILE"
         export ORCH_RUN_ID=${JSON.stringify(runId)}
         echo "EVIDENCE=$(_cost_ledger_spend_evidence)"
         assert_cost_ledger_not_silently_empty; echo "RC=$?"`,
      ], { encoding: 'utf8' });
      return { out: r.stdout, err: r.stderr };
    }

    /** An artefact stamped as belonging to an older run. */
    function oldArtefact(dir: string) {
      mkdirSync(join(dir, 'claude_outputs'), { recursive: true });
      const f = join(dir, 'claude_outputs', 'OLD-1_result.json');
      writeFileSync(f, JSON.stringify(CLAUDE_SHAPE));
      spawnSync('touch', ['-d', '2026-08-15 12:00:00 UTC', f]);
      return f;
    }

    it('artefacts from EARLIER runs are not counted against this one', () => {
      oldArtefact(work);
      const { out } = evidence('20260817T140130Z', work); // run started after the artefact
      expect(out, 'a run that spent nothing was accused using an older run\'s artefacts')
        .toContain('EVIDENCE=0');
      expect(out).toContain('RC=0');
    });

    it('an artefact from THIS run with an empty ledger still fires', () => {
      // The guard must keep working — this is the condition it exists for.
      oldArtefact(work);
      const { out, err } = evidence('20260801T000000Z', work); // run started before it
      expect(out).toContain('EVIDENCE=1');
      expect(out, 'a real recording failure went unreported').toContain('RC=1');
      expect(err).toMatch(/THIS RUN RECORDED NO COST/);
    });

    it('an unscopeable run id reports UNKNOWN, never an accusation', () => {
      // A resume can carry a custom id. Counting everything would be worse than saying so.
      oldArtefact(work);
      const { out, err } = evidence('resume-abc', work);
      expect(out).toContain('EVIDENCE=unscoped');
      expect(out, 'an unscopeable run was accused on data that is not about it').toContain('RC=0');
      expect(err).toMatch(/could not be scoped/i);
    });
  });
});
