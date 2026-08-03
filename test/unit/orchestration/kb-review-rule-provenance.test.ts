/**
 * Every "LEARNED REVIEW RULE" must carry its provenance.
 *
 * On escalation, run-agent-orchestration.sh appends each blocker DESCRIPTION to
 * kb-scratchpad/KB-review-agent.md, and team-lead-review.sh injects that file into the
 * reviewer prompt as "LEARNED REVIEW RULES (from prior runs — apply these)". So a single
 * sentence a reviewer wrote once becomes a standing rule applied to future work.
 *
 * Written unattributed, such a rule is unauditable: you cannot tell whether it was learned
 * from real code or from a bad input, and you cannot expire it. That matters because it
 * has already happened in spirit — a fabricated fixture's requirements reached a REAL
 * run's reviewer (2026-08-03) via a project-config fact, and the resulting blockers are
 * exactly what this file accumulates. The KB is cleared per run by pre-run-reset, so the
 * hazard is within-run and forward-looking rather than historical — but an anonymous rule
 * is indistinguishable from a well-founded one either way.
 *
 * Stamping story id and run id costs nothing and makes every rule traceable to the run
 * that produced it. This does NOT judge whether a rule is correct — that is the larger
 * self-heal provenance work (backlogged); it makes the question answerable at all.
 *
 * Real bash execution against real fixtures. Zero LLM calls.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run the REAL KB-append snippet from the orchestrator against a fixture feedback file. */
function appendKbRule(opts: { story: string; runId: string; description: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'kb-prov-'));
  dirs.push(dir);
  const logDir = join(dir, 'logs');
  mkdirSync(join(logDir, 'kb-scratchpad'), { recursive: true });
  const fb = join(logDir, `review-feedback-${opts.story}.json`);
  writeFileSync(
    fb,
    JSON.stringify({
      verdict: 'changes_requested',
      issues: [
        { severity: 'blocker', description: opts.description },
        { severity: 'minor', description: 'a minor note that must NOT become a standing rule' },
      ],
    }),
  );

  // Extract the real append line rather than reimplementing it.
  const marker = "jq -r ";
  const kbIdx = orchSrc.indexOf('kb-scratchpad/KB-review-agent.md');
  expect(kbIdx, 'KB append site not found in the orchestrator').toBeGreaterThan(-1);
  const lineStart = orchSrc.lastIndexOf(marker, kbIdx);
  const lineEnd = orchSrc.indexOf('\n', kbIdx) + 1;
  const appendSnippet = orchSrc.slice(lineStart, lineEnd);

  const script = join(dir, 'probe.sh');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `LOG_DIR=${JSON.stringify(logDir)}`,
      `_fb=${JSON.stringify(fb)}`,
      `_fb_story=${JSON.stringify(opts.story)}`,
      `ORCH_RUN_ID=${JSON.stringify(opts.runId)}`,
      appendSnippet,
    ].join('\n'),
  );
  spawnSync('bash', [script], { encoding: 'utf8', timeout: 15000 });
  return readFileSync(join(logDir, 'kb-scratchpad/KB-review-agent.md'), 'utf8');
}

describe('KB review rules are attributable', () => {
  const description = 'The live_preview block must include a preview token.';

  it('still records the blocker text itself', () => {
    const out = appendKbRule({ story: 'ABC-1', runId: '20260803T000000Z', description });
    expect(out).toContain(description);
  });

  it('records WHICH STORY produced the rule', () => {
    const out = appendKbRule({ story: 'ABC-1', runId: '20260803T000000Z', description });
    expect(
      out,
      'an unattributed rule cannot be audited or expired — you cannot tell whether it was ' +
        'learned from real code or from a bad input',
    ).toContain('ABC-1');
  });

  it('records WHICH RUN produced the rule', () => {
    const out = appendKbRule({ story: 'ABC-1', runId: '20260803T000000Z', description });
    expect(out).toContain('20260803T000000Z');
  });

  it('still promotes ONLY blockers — a minor note never becomes a standing rule', () => {
    const out = appendKbRule({ story: 'ABC-1', runId: '20260803T000000Z', description });
    expect(out).not.toContain('must NOT become a standing rule');
  });
});
