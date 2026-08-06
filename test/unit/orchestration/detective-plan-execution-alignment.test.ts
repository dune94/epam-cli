/**
 * The detective's plan and its final answer can silently diverge.
 *
 * Empirically confirmed 2026-08-05 against real Langfuse/plan data for AMSD-2041: three
 * separate detective runs all planned to investigate `useContent` ("I'll trace `useContent`
 * to its definition and callees... the fix likely belongs in the content-fetching layer"),
 * and the final answers named completely different files — none of them `useContent` — with
 * zero shared vocabulary between plan and answer. The execute-phase prompt (ai-run.sh)
 * explicitly permits deviating from the plan ("If carrying out the plan showed it to be
 * wrong, say so and answer correctly rather than following it"), but nothing checks whether
 * a deviation actually happened, let alone whether it was justified. The plan is present in
 * context; it was never binding on the output, and the drift was invisible.
 *
 * This does not try to force the model to follow its plan — a plan CAN legitimately turn out
 * to be wrong once the model starts querying. It makes an unexplained divergence OBSERVABLE:
 * a deterministic term-overlap check between the plan text and the final findings, logged
 * loudly (matching the standing no-silent-failure rule) and recorded in the same per-attempt
 * telemetry the detective already writes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SRC_PATH = join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js');
const SRC = readFileSync(SRC_PATH, 'utf8');

function extractFunctionBody(name: string): string {
  const start = SRC.indexOf(`function ${name}(`);
  expect(start, `${name} not found in spec-mode-runner.js`).toBeGreaterThan(0);
  const end = SRC.indexOf('\n}', start) + 2;
  return SRC.slice(start, end);
}

describe('checkPlanExecutionAlignment — deterministic, no LLM call', () => {
  const fnBody = extractFunctionBody('checkPlanExecutionAlignment');
  const mod: { checkPlanExecutionAlignment?: (plan: string, findings: unknown[]) => { aligned: boolean } } = {};
  // eslint-disable-next-line no-new-func
  new Function('mod', `${fnBody}\nmod.checkPlanExecutionAlignment = checkPlanExecutionAlignment;`)(mod);

  it('THE CONFIRMED CASE: plan says useContent, answer names something else entirely — misaligned', () => {
    const plan = "I'll trace `useContent` to its definition and callees to find where content is fetched from Contentstack, then check if there's any existing preview/draft infrastructure. The fix likely belongs in the content-fetching layer (hook or service).";
    const findings = [{
      file: 'src/pages/[[...slug]].tsx',
      function: 'getStaticProps',
      reason: 'renders page content statically without preview support',
    }];
    const result = mod.checkPlanExecutionAlignment!(plan, findings);
    expect(result.aligned, 'plan named useContent; the answer shares no term with it').toBe(false);
  });

  it('a plan that names the SAME file/function the answer lands on is aligned', () => {
    const plan = "I'll examine the useContent hook and trace it to find where content is fetched without preview support.";
    const findings = [{
      file: 'src/hooks/useContent.ts',
      function: 'useContent',
      reason: 'the central content-fetching hook, missing preview support',
    }];
    const result = mod.checkPlanExecutionAlignment!(plan, findings);
    expect(result.aligned).toBe(true);
  });

  it('a plan that explicitly says it changed its mind counts as aligned (deviation is allowed if stated)', () => {
    const plan = "I initially expected useContent, but explore showed contentstackContext.tsx is the real integration point instead — pivoting there.";
    const findings = [{
      file: 'src/context/contentstackContext.tsx',
      function: 'ContentstackContext',
      reason: 'the actual attachment point found via explore',
    }];
    const result = mod.checkPlanExecutionAlignment!(plan, findings);
    expect(result.aligned, 'the plan itself names the same file the answer landed on').toBe(true);
  });

  it('no plan text (plan-execute disabled or unavailable) is treated as aligned — nothing to check against', () => {
    const result = mod.checkPlanExecutionAlignment!('', [{ file: 'src/x.ts', function: 'f', reason: 'r' }]);
    expect(result.aligned).toBe(true);
  });

  it('empty findings is aligned — nothing to be misaligned WITH', () => {
    const result = mod.checkPlanExecutionAlignment!('I will investigate useContent.', []);
    expect(result.aligned).toBe(true);
  });
});

describe('readLatestDetectivePlan — reads the real persisted plans-<phase>.jsonl, best-effort', () => {
  const fnBody = extractFunctionBody('readLatestDetectivePlan');
  const mod: { readLatestDetectivePlan?: (logDir: string, phase: string, storyId: string) => string | null } = {};
  // eslint-disable-next-line no-new-func
  new Function('require', 'mod', `${fnBody}\nmod.readLatestDetectivePlan = readLatestDetectivePlan;`)(require, mod);

  function makeLogDir(lines: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'plans-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plans-core.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return dir;
  }

  it('finds the plan for the right agent + story', () => {
    const dir = makeLogDir([
      { agent: 'SPEC_AGENT', story: 'AMSD-2041', plan: 'wrong agent' },
      { agent: 'code-graph-detective', story: 'OTHER-1', plan: 'wrong story' },
      { agent: 'code-graph-detective', story: 'AMSD-2041', plan: 'the real plan' },
    ]);
    expect(mod.readLatestDetectivePlan!(dir, 'core', 'AMSD-2041')).toBe('the real plan');
  });

  it('takes the LATEST entry when the same story was investigated more than once (retry/ladder escalation)', () => {
    const dir = makeLogDir([
      { agent: 'code-graph-detective', story: 'AMSD-2041', plan: 'first attempt' },
      { agent: 'code-graph-detective', story: 'AMSD-2041', plan: 'escalated retry' },
    ]);
    expect(mod.readLatestDetectivePlan!(dir, 'core', 'AMSD-2041')).toBe('escalated retry');
  });

  it('returns null, not a throw, when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plans-empty-'));
    expect(mod.readLatestDetectivePlan!(dir, 'core', 'AMSD-2041')).toBeNull();
  });

  it('returns null when no matching entry exists', () => {
    const dir = makeLogDir([{ agent: 'code-graph-detective', story: 'OTHER-1', plan: 'x' }]);
    expect(mod.readLatestDetectivePlan!(dir, 'core', 'AMSD-2041')).toBeNull();
  });

  it('tolerates a corrupt line without losing the good ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plans-corrupt-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'plans-core.jsonl'),
      'not json\n' + JSON.stringify({ agent: 'code-graph-detective', story: 'AMSD-2041', plan: 'good one' }) + '\n',
    );
    expect(mod.readLatestDetectivePlan!(dir, 'core', 'AMSD-2041')).toBe('good one');
  });
});

describe('runCodeGraphDetective logs loudly, and records telemetry, on a real misalignment', () => {
  it('the detective wires the alignment check into its own attempt loop', () => {
    const start = SRC.indexOf('async function runCodeGraphDetective(');
    const end = SRC.indexOf('\nasync function ', start + 10);
    const fnSrc = SRC.slice(start, end === -1 ? SRC.length : end);
    expect(fnSrc, 'runCodeGraphDetective must call the alignment check on its own findings').toMatch(/checkPlanExecutionAlignment\(/);
    expect(fnSrc, 'must consult the persisted plan for this exact story').toMatch(/readLatestDetectivePlan\(/);
    expect(fnSrc, 'a misalignment must be LOUD, not swallowed').toMatch(/console\.warn.*plan/i);
    expect(fnSrc, 'must be recorded in per-attempt telemetry, not just printed').toMatch(/planExecutionAligned/);
  });
});
