/**
 * Dynamic retry-extension coordinator (2026-07-12, user request): a story
 * that exhausted MAX_RETRIES with genuine, converging progress (each
 * failure a DIFFERENT diagnosed bug, not a repeat) shouldn't necessarily be
 * abandoned at a fixed, one-size-fits-all ceiling. This is a bounded,
 * evidence-gated extension of that ceiling -- deterministic evidence
 * (computed from healing-events.jsonl + failure-diagnosis-groundedness.jsonl,
 * both already built) is gathered first, and the LLM is only consulted when
 * that evidence is genuinely ambiguous. See
 * orchestrations/scripts/claude.sh's compute_retry_extension_evidence() and
 * run_retry_extension_coordinator() docstrings for the full design.
 *
 * Scope note on the "full loop integration" test: implement_story() is a
 * ~700-line function with many internal dependencies (build_implementation_
 * prompt, run_external_verification, run_tsc_verification, etc.). Rather
 * than stub every one of those to exercise the whole function end-to-end,
 * this file verifies the NEW logic (compute_retry_extension_evidence,
 * run_retry_extension_coordinator) via real execution -- where actual bugs
 * would hide -- and verifies the surrounding while/break/continue wiring
 * into implement_story() via static source-position assertions, which is
 * proportionate for that trivial control-flow wrapping (already additionally
 * verified via bash -n and shellcheck -S error).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(claudeSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

describe('retry-extension-coordinator — static wiring', () => {
  it('compute_retry_extension_evidence is defined', () => {
    expect(claudeSrc).toMatch(/compute_retry_extension_evidence\s*\(\)/);
  });

  it('run_retry_extension_coordinator is defined', () => {
    expect(claudeSrc).toMatch(/run_retry_extension_coordinator\s*\(\)/);
  });

  it('implement_story shadows MAX_RETRIES locally (bash local semantics guarantee restoration on every exit path)', () => {
    const implIdx = claudeSrc.indexOf('implement_story() {');
    const shadowIdx = claudeSrc.indexOf('local MAX_RETRIES="$MAX_RETRIES"', implIdx);
    expect(shadowIdx).toBeGreaterThan(implIdx);
    // INSIDE the function, not within N bytes of its start. `implIdx + 2000` measured
    // distance rather than containment, so any declaration added above this one failed the
    // test without changing what it guards — bash `local` semantics hold wherever in the
    // function the shadow is declared.
    const implEnd = claudeSrc.indexOf('\n}', implIdx);
    expect(implEnd, 'implement_story is not closed as expected').toBeGreaterThan(implIdx);
    expect(shadowIdx, 'MAX_RETRIES is shadowed outside implement_story').toBeLessThan(implEnd);
  });

  it('the extension call happens between the inner retry loop\'s "done" and the final failure block', () => {
    const implIdx = claudeSrc.indexOf('implement_story() {');
    const failIdx = claudeSrc.indexOf('error "Failed to implement $story_id after', implIdx);
    const extIdx = claudeSrc.indexOf('run_retry_extension_coordinator "$story_id"', implIdx);
    expect(extIdx).toBeGreaterThan(implIdx);
    expect(extIdx).toBeLessThan(failIdx);
  });

  it('the coordinator is only invoked once per story (guarded by _retry_extension_used)', () => {
    const fnStart = claudeSrc.indexOf('implement_story() {');
    const extIdx = claudeSrc.indexOf('run_retry_extension_coordinator "$story_id"', fnStart);
    const surrounding = claudeSrc.slice(extIdx - 300, extIdx + 50);
    expect(surrounding).toMatch(/_retry_extension_used.*-eq 0/);
    expect(surrounding).toMatch(/_retry_extension_used=1/);
  });

  it('run_retry_extension_coordinator is gated by EPAM_RETRY_EXTENSION_ENABLED and fails closed by default', () => {
    const fnBody = extractFunctionBody('run_retry_extension_coordinator');
    expect(fnBody).toMatch(/EPAM_RETRY_EXTENSION_ENABLED/);
    // The very first real check must be the enabled gate, echoing 0 (no
    // extension) when disabled -- proves the default (unset) behavior is
    // "off", not "on unless configured otherwise".
    const gateIdx = fnBody.indexOf('EPAM_RETRY_EXTENSION_ENABLED');
    const echoIdx = fnBody.indexOf('echo 0', gateIdx);
    expect(echoIdx).toBeGreaterThan(gateIdx);
    expect(echoIdx).toBeLessThan(gateIdx + 100);
  });

  it('caps extraRetries at the resolved per-role max regardless of what the LLM requests', () => {
    const fnBody = extractFunctionBody('run_retry_extension_coordinator');
    // The flat EPAM_RETRY_EXTENSION_MAX cap now lives inside
    // resolve_role_retry_extension_max() (its role-agnostic fallback), not
    // as a literal in this function -- see the dedicated
    // role-based-generic-escalation.test.ts for real-execution coverage of
    // that function's cap behavior, including the flat-default case.
    expect(fnBody).toMatch(/_max=\$\(resolve_role_retry_extension_max "\$story_id"\)/);
    expect(fnBody).toMatch(/"\$granted" -gt "\$_max"/);
    const roleMaxFnBody = extractFunctionBody('resolve_role_retry_extension_max');
    expect(roleMaxFnBody).toMatch(/EPAM_RETRY_EXTENSION_MAX/);
  });
});

describe('compute_retry_extension_evidence() — REAL execution', () => {
  function run(opts: { storyId: string; healingEvents: any[]; groundednessEntries: any[] }): any {
    const dir = mkdtempSync(join(tmpdir(), 'retry-ext-evidence-'));
    try {
      writeFileSync(join(dir, 'healing-events.jsonl'), opts.healingEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
      writeFileSync(
        join(dir, 'failure-diagnosis-groundedness.jsonl'),
        opts.groundednessEntries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      );
      const fnBody = extractFunctionBody('compute_retry_extension_evidence');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `LOG_DIR=${JSON.stringify(dir)}`,
          fnBody,
          `compute_retry_extension_evidence ${JSON.stringify(opts.storyId)}`,
        ].join('\n'),
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      return JSON.parse(output.trim());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('counts distinct diagnoses correctly and reports no HEALING_BROKEN when all diagnoses differ', () => {
    const result = run({
      storyId: 'SKY-003-test',
      healingEvents: [
        { ts: 't1', story_id: 'SKY-003-test', retry: 0, target: 'skill', diagnosis: 'bug A' },
        { ts: 't2', story_id: 'SKY-003-test', retry: 1, target: 'skill', diagnosis: 'bug B' },
        { ts: 't3', story_id: 'SKY-999-other', retry: 0, target: 'skill', diagnosis: 'unrelated story' },
      ],
      groundednessEntries: [
        { storyId: 'SKY-003-test', diagnosis: 'bug A', skipped: false, score: 0.9 },
        { storyId: 'SKY-003-test', diagnosis: 'bug B', skipped: false, score: 0.7 },
      ],
    });
    expect(result.total_heal_events).toBe(2);
    expect(result.distinct_diagnoses).toBe(2);
    expect(result.healing_broken_ever).toBe(false);
    expect(result.groundedness_sample_count).toBe(2);
    expect(result.avg_groundedness).toBeCloseTo(0.8, 5);
  });

  it('detects a repeated (non-distinct) diagnosis', () => {
    const result = run({
      storyId: 'SKY-004',
      healingEvents: [
        { ts: 't1', story_id: 'SKY-004', retry: 0, target: 'skill', diagnosis: 'same bug' },
        { ts: 't2', story_id: 'SKY-004', retry: 1, target: 'skill', diagnosis: 'same bug' },
      ],
      groundednessEntries: [],
    });
    expect(result.total_heal_events).toBe(2);
    expect(result.distinct_diagnoses).toBe(1);
  });

  it('detects a HEALING_BROKEN sentinel for this story', () => {
    const result = run({
      storyId: 'SKY-004',
      healingEvents: [
        { ts: 't1', story_id: 'SKY-004', retry: 0, target: 'skill', diagnosis: 'bug A' },
        { ts: 't2', story_id: 'SKY-004', event: 'HEALING_BROKEN', repeated_diagnosis: 'bug A', count: 2 },
      ],
      groundednessEntries: [],
    });
    expect(result.healing_broken_ever).toBe(true);
  });

  it('is a clean zero-state when neither log has any entry for this story', () => {
    const result = run({
      storyId: 'SKY-NONEXISTENT',
      healingEvents: [{ ts: 't1', story_id: 'SKY-OTHER', retry: 0, target: 'skill', diagnosis: 'x' }],
      groundednessEntries: [],
    });
    expect(result.total_heal_events).toBe(0);
    expect(result.distinct_diagnoses).toBe(0);
    expect(result.healing_broken_ever).toBe(false);
    expect(result.groundedness_sample_count).toBe(0);
  });
});

describe('run_retry_extension_coordinator() — REAL execution', () => {
  function run(opts: {
    storyId: string;
    healingEvents: any[];
    groundednessEntries: any[];
    enabled?: string;
    maxExtension?: string;
    gateResponse?: string;
    gateShouldNotBeCalled?: boolean;
  }): { granted: number; logOutput: string; decisionLog: any[] } {
    const dir = mkdtempSync(join(tmpdir(), 'retry-ext-coord-'));
    try {
      writeFileSync(join(dir, 'healing-events.jsonl'), opts.healingEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
      writeFileSync(
        join(dir, 'failure-diagnosis-groundedness.jsonl'),
        opts.groundednessEntries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      );

      const scriptDir = join(dir, 'scripts');
      mkdirSync(scriptDir, { recursive: true });
      // Stub ai-run.sh -- if the deterministic pre-gate is working, this
      // stub asserting-fails should NEVER actually be invoked for the
      // "should not be called" test cases.
      writeFileSync(
        join(scriptDir, 'ai-run.sh'),
        opts.gateShouldNotBeCalled
          ? '#!/usr/bin/env bash\necho "ERROR: ai-run.sh should not have been called" >&2\nexit 1\n'
          : `#!/usr/bin/env bash\ncat >/dev/null\necho ${JSON.stringify(opts.gateResponse ?? '{"extend":false,"extraRetries":0,"reason":"stub"}')}\n`,
        { mode: 0o755 },
      );

      const profilesDir = join(dir, 'agents');
      mkdirSync(profilesDir, { recursive: true });
      writeFileSync(join(profilesDir, 'profiles.json'), JSON.stringify({ 'retry-extension-coordinator': 'test profile' }));

      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({ stories: [{ id: opts.storyId, acceptanceCriteria: ['AC1', 'AC2'] }] }));

      const evidenceFnBody = extractFunctionBody('compute_retry_extension_evidence');
      const roleMaxFnBody = extractFunctionBody('resolve_role_retry_extension_max');
      const coordFnBody = extractFunctionBody('run_retry_extension_coordinator');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `LOG_DIR=${JSON.stringify(dir)}`,
          `SCRIPT_DIR=${JSON.stringify(scriptDir)}`,
          `PRD_FILE=${JSON.stringify(prdPath)}`,
          `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
          `EPAM_CLI=epam`,
          opts.enabled !== undefined ? `EPAM_RETRY_EXTENSION_ENABLED=${JSON.stringify(opts.enabled)}` : '',
          opts.maxExtension !== undefined ? `EPAM_RETRY_EXTENSION_MAX=${JSON.stringify(opts.maxExtension)}` : '',
          `ORCH_GATE_PROVIDER=openrouter`,
          `ORCH_GATE_MODEL=test-model`,
          'log() { echo "LOG: $*" >&2; }',
          'warning() { echo "WARN: $*" >&2; }',
          evidenceFnBody,
          roleMaxFnBody,
          coordFnBody,
          `run_retry_extension_coordinator ${JSON.stringify(opts.storyId)}`,
          'echo "RC=$?"',
        ]
          .filter(Boolean)
          .join('\n'),
      );

      const stderrPath = join(dir, 'stderr.log');
      const wrapperPath = join(dir, 'run-wrapper.sh');
      writeFileSync(wrapperPath, `bash ${JSON.stringify(scriptPath)} 2> ${JSON.stringify(stderrPath)}`);
      let stdout = '';
      try {
        stdout = execFileSync('bash', [wrapperPath], { encoding: 'utf8' });
      } catch (e: any) {
        stdout = (e.stdout ?? '').toString();
      }
      const stderr = readFileSync(stderrPath, 'utf8');

      const grantedLine = stdout.split('\n').find((l) => /^\d+$/.test(l.trim()));
      const granted = grantedLine ? parseInt(grantedLine.trim(), 10) : -1;

      let decisionLog: any[] = [];
      try {
        decisionLog = readFileSync(join(dir, 'retry-extension-decisions.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        /* no decisions logged */
      }

      return { granted, logOutput: stdout + stderr, decisionLog };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('grants 0 (no-op) when EPAM_RETRY_EXTENSION_ENABLED is unset (default off)', () => {
    const { granted, decisionLog } = run({
      storyId: 'SKY-999',
      healingEvents: [{ ts: 't1', story_id: 'SKY-999', retry: 0, target: 'skill', diagnosis: 'bug A' }],
      groundednessEntries: [],
      gateShouldNotBeCalled: true,
    });
    expect(granted).toBe(0);
    expect(decisionLog).toHaveLength(0);
  });

  it('does NOT call the gate model when a diagnosis repeated (deterministic pre-gate fires)', () => {
    const { granted, logOutput } = run({
      storyId: 'SKY-999',
      enabled: '1',
      healingEvents: [
        { ts: 't1', story_id: 'SKY-999', retry: 0, target: 'skill', diagnosis: 'same bug' },
        { ts: 't2', story_id: 'SKY-999', retry: 1, target: 'skill', diagnosis: 'same bug' },
      ],
      groundednessEntries: [],
      gateShouldNotBeCalled: true,
    });
    expect(granted).toBe(0);
    expect(logOutput).not.toMatch(/ERROR: ai-run\.sh should not have been called/);
    expect(logOutput).toMatch(/non-convergence/);
  });

  it('does NOT call the gate model when HEALING_BROKEN fired for this story (deterministic pre-gate fires)', () => {
    const { granted, logOutput } = run({
      storyId: 'SKY-999',
      enabled: '1',
      healingEvents: [
        { ts: 't1', story_id: 'SKY-999', retry: 0, target: 'skill', diagnosis: 'bug A' },
        { ts: 't2', story_id: 'SKY-999', event: 'HEALING_BROKEN', repeated_diagnosis: 'bug A', count: 2 },
      ],
      groundednessEntries: [],
      gateShouldNotBeCalled: true,
    });
    expect(granted).toBe(0);
    expect(logOutput).not.toMatch(/ERROR: ai-run\.sh should not have been called/);
  });

  it('grants the requested extension (within cap) when evidence is clean and the gate approves', () => {
    const { granted, decisionLog } = run({
      storyId: 'SKY-003-test',
      enabled: '1',
      healingEvents: [
        { ts: 't1', story_id: 'SKY-003-test', retry: 0, target: 'skill', diagnosis: 'bug A' },
        { ts: 't2', story_id: 'SKY-003-test', retry: 1, target: 'skill', diagnosis: 'bug B' },
      ],
      groundednessEntries: [
        { storyId: 'SKY-003-test', diagnosis: 'bug A', skipped: false, score: 0.9 },
        { storyId: 'SKY-003-test', diagnosis: 'bug B', skipped: false, score: 0.8 },
      ],
      gateResponse: '{"extend":true,"extraRetries":2,"reason":"consistently grounded, distinct progress"}',
    });
    expect(granted).toBe(2);
    expect(decisionLog).toHaveLength(1);
    expect(decisionLog[0].extend).toBe(true);
    expect(decisionLog[0].extraRetriesGranted).toBe(2);
  });

  it('caps the granted extension at EPAM_RETRY_EXTENSION_MAX even when the gate requests more', () => {
    const { granted } = run({
      storyId: 'SKY-003-test',
      enabled: '1',
      maxExtension: '1',
      healingEvents: [
        { ts: 't1', story_id: 'SKY-003-test', retry: 0, target: 'skill', diagnosis: 'bug A' },
        { ts: 't2', story_id: 'SKY-003-test', retry: 1, target: 'skill', diagnosis: 'bug B' },
      ],
      groundednessEntries: [{ storyId: 'SKY-003-test', diagnosis: 'bug A', skipped: false, score: 0.9 }],
      gateResponse: '{"extend":true,"extraRetries":3,"reason":"go big"}',
    });
    expect(granted).toBe(1);
  });

  it('fails closed (grants 0) when the gate model returns malformed JSON', () => {
    const { granted, decisionLog } = run({
      storyId: 'SKY-003-test',
      enabled: '1',
      healingEvents: [
        { ts: 't1', story_id: 'SKY-003-test', retry: 0, target: 'skill', diagnosis: 'bug A' },
        { ts: 't2', story_id: 'SKY-003-test', retry: 1, target: 'skill', diagnosis: 'bug B' },
      ],
      groundednessEntries: [],
      gateResponse: 'not valid json at all',
    });
    expect(granted).toBe(0);
    expect(decisionLog[0].extend).toBe(false);
  });

  it('fails closed (grants 0) when the gate explicitly declines', () => {
    const { granted } = run({
      storyId: 'SKY-003-test',
      enabled: '1',
      healingEvents: [
        { ts: 't1', story_id: 'SKY-003-test', retry: 0, target: 'skill', diagnosis: 'bug A' },
        { ts: 't2', story_id: 'SKY-003-test', retry: 1, target: 'skill', diagnosis: 'bug B' },
      ],
      groundednessEntries: [],
      gateResponse: '{"extend":false,"extraRetries":0,"reason":"low confidence overall"}',
    });
    expect(granted).toBe(0);
  });
});
