/**
 * code-graph-detective agent — the robust symptom→cause fix-site finder.
 *
 * Deterministic single/union CodeGraph queries reliably surface only the
 * DISPLAY layer a symptom-worded ticket describes (proven live 2026-07-23,
 * AMSD-1820: every ticket-derivable query missed apply-report-discounts.
 * service.ts). Only judgment-driven iteration — an agent that explores, sees
 * it landed on a display file, and traces callers to the CAUSE — converges.
 * runCodeGraphDetective wires that: a tool-using LLM (GLM-5.1) with the
 * codegraph-agent-query.sh tool, iterating to the causal fix site.
 *
 * Fast tests: graceful degradation (never blocks the spec pass).
 * Opt-in real test (RUN_REAL_DETECTIVE=1): a live GLM-5.1 run against the real
 * Metrolinx repo asserting it converges on apply-report-discounts.service.ts —
 * the "finds the right code" proof. Gated because it costs a real LLM call.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { runCodeGraphDetective } = spec;

const ORIG_BF = process.env.EPAM_BROWNFIELD;
function restoreEnv() {
  if (ORIG_BF === undefined) delete process.env.EPAM_BROWNFIELD;
  else process.env.EPAM_BROWNFIELD = ORIG_BF;
}

describe('runCodeGraphDetective — graceful degradation (never blocks spec pass)', () => {
  it('returns [] when not in brownfield mode', async () => {
    delete process.env.EPAM_BROWNFIELD;
    const files = await runCodeGraphDetective({ title: 'x', codeline: 'x' }, null);
    expect(files).toEqual([]);
    restoreEnv();
  });

  it('returns [] when the codeline repo does not exist', async () => {
    process.env.EPAM_BROWNFIELD = '1';
    const prev = process.env.PROJECT_ROOT;
    process.env.PROJECT_ROOT = '/definitely/not/a/repo/path';
    const files = await runCodeGraphDetective({ title: 'x', codeline: 'nope' }, null);
    expect(files).toEqual([]);
    if (prev === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = prev;
    restoreEnv();
  });
});

const RUN_REAL = process.env.RUN_REAL_DETECTIVE === '1';
const REAL_REPO = '/home/bradleyjerome/projects/metrolinx/azure.commerce.cdts';
describe.skipIf(!RUN_REAL || !existsSync(REAL_REPO))('runCodeGraphDetective — REAL GLM-5.1 run (opt-in)', () => {
  it('converges on the causal fix site (apply-report-discounts.service.ts) for the symptom-worded AMSD-1820 ticket', async () => {
    process.env.EPAM_BROWNFIELD = '1';
    process.env.CODEGRAPH_ENABLED = '1';
    process.env.PROJECT_ROOT = REAL_REPO;
    process.env.JIRA_DEFAULT_CODELINE = 'cdts';
    process.env.JIRA_WORKTREE_CDTS = REAL_REPO;
    const story = {
      title: '[Mozio] - The Promo code amount is NOT displayed as expected for Return trip tickets in the Mozio email confirmation',
      description: 'When a return trip ticket has a promo code, the discount amount is not displayed correctly for the return leg in the Mozio email confirmation.',
      acceptanceCriteria: ['The promo code discount amount is shown for the return trip leg', 'No regression for outbound leg discount'],
      codeline: 'cdts',
    };
    const findings = await runCodeGraphDetective(story, '/tmp');
    // Now returns {file, function, reason} findings — the reason carries the
    // root-cause analysis injected into the implementation prompt.
    expect(findings.some((f: any) => f.file.includes('apply-report-discounts.service.ts'))).toBe(true);
    const fix = findings.find((f: any) => f.file.includes('apply-report-discounts.service.ts'));
    expect(fix.reason.length).toBeGreaterThan(0); // a real root-cause explanation, not empty
  }, 5 * 60 * 1000);
});
