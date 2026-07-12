/**
 * Step 4.2's story-ac-remediator must apply ACs to the PRD deterministically
 * in bash/Python, not trust the LLM agent to write the file itself — and the
 * JSON extraction must tolerate ACs whose text embeds literal braces.
 *
 * Root cause this fixes (found live, 2026-07-11, tier3-travel-app run): a
 * SAST sentinel blocker flagged a real tsconfig.json typo
 * ("allowEmptyInputs" is not a valid TypeScript compiler option) on SKY-001.
 * gate-finding-analyst correctly mapped it; story-ac-remediator's own
 * response contained a well-formed `{"acs_added":2,"acs":[...]}` with two
 * genuinely concrete, machine-verifiable ACs (one of which embedded a
 * `node -e "...{ ... } else { ... }..."` verification snippet) — but the PRD
 * was never actually updated (confirmed directly via `jq` afterward), because
 * the prior implementation gave the agent real Bash/WriteFile tool access
 * (AI_GATE_ALLOW_TOOLS=1) and just trusted its own claim to have "written the
 * updated PRD back to the file." An LLM narrating that it wrote a file is not
 * the same as it having called a tool to do so — same class of defect already
 * fixed elsewhere this session for run_plan_mode and run_pre_phase_assessment.
 * Compounding it: even the SUCCESS-detection regex
 * (`\{[^{}]*"acs_added"[^{}]*\}`) requires the ENTIRE JSON blob to contain
 * zero brace characters anywhere — including inside string values — so an AC
 * whose verification snippet embeds `{ }` (extremely common for "verify with
 * node -e" style ACs, which the remediator's own profile is instructed to
 * produce) would have broken detection even if the write had succeeded.
 *
 * Fix: remove tool access; the agent's ONLY job is to emit the JSON. Bash
 * parses it with a real JSON scanner (json.JSONDecoder.raw_decode, which
 * respects string escaping/nesting regardless of embedded braces) and
 * applies the "acs" array to the PRD itself, deterministically — mirroring
 * the Step 3.8 lint-gate remediator's already-correct architecture (whose own
 * regex had the identical embedded-brace defect and is fixed the same way).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('story-ac-remediator (Step 4.2) — wiring (static)', () => {
  it('no longer grants the agent tool access (AI_GATE_ALLOW_TOOLS) for this call', () => {
    const idx = orchSrc.indexOf('[story-ac-remediator] Augmenting ACs for story');
    const block = orchSrc.slice(idx, idx + 1200);
    expect(block).not.toMatch(/AI_GATE_ALLOW_TOOLS=1/);
  });

  it('no longer instructs the agent to write the PRD file itself', () => {
    const idx = orchSrc.indexOf('[story-ac-remediator] Augmenting ACs for story');
    const block = orchSrc.slice(idx, idx + 1500);
    expect(block).not.toMatch(/Write the updated PRD back to the file/);
    expect(block).toMatch(/do not write any files yourself/);
  });

  it('applies the AC list via a real JSON scanner (raw_decode), not a brace-free regex', () => {
    const idx = orchSrc.indexOf('AC_APPLY_PY');
    expect(idx).toBeGreaterThan(-1);
    const block = orchSrc.slice(idx, idx + 1500);
    expect(block).toMatch(/decoder\.raw_decode/);
    expect(block).not.toMatch(/re\.finditer\(r'\\\{\[\^\{\}\]/);
  });

  it('the lint-gate remediator (Step 3.8) uses the same robust scanner, not its old brace-free regex', () => {
    const idx = orchSrc.indexOf('LINT_AC_PY');
    const block = orchSrc.slice(idx, idx + 1200);
    expect(block).toMatch(/decoder\.raw_decode/);
    expect(block).not.toMatch(/re\.search\(r'\\\{\[\^\{\}\]/);
  });
});

describe('story-ac-remediator AC-apply script — REAL execution', () => {
  function extractApplyScript(): string {
    const start = orchSrc.indexOf("<<'AC_APPLY_PY'") + "<<'AC_APPLY_PY'".length;
    const end = orchSrc.indexOf('AC_APPLY_PY', start);
    return orchSrc.slice(start, end);
  }

  function run(opts: { agentResponse: string; existingACs?: string[] }): { added: number; prdACs: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'ac-apply-'));
    try {
      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({
          stories: [{ id: 'SKY-001', acceptanceCriteria: (opts.existingACs ?? []).map((t) => ({ text: t, status: 'pending' })) }],
        }),
      );
      const responsePath = join(dir, 'response.txt');
      writeFileSync(responsePath, opts.agentResponse);
      const script = extractApplyScript();
      const output = execFileSync('python3', ['-', prdPath, 'SKY-001', responsePath], {
        input: script,
        encoding: 'utf8',
      });
      const added = parseInt(output.trim(), 10);
      const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
      const prdACs = prd.stories[0].acceptanceCriteria.map((a: any) => a.text);
      return { added, prdACs };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live shape and proves the fix: an AC embedding literal braces (a node -e verification snippet) is still parsed and applied', () => {
    const embeddedBraceAC =
      'tsconfig.json must not contain any unknown TypeScript compiler options - verify with: node -e "const c=require(\'./tsconfig.json\'); if (Object.keys(c.compilerOptions).length > 0) { console.log(\'FAIL\'); } else { console.log(\'PASS\'); }"';
    const response = JSON.stringify({
      story_id: 'SKY-001',
      acs_added: 2,
      acs: [
        "tsconfig.json must not contain the invalid compiler option 'allowEmptyInputs'",
        embeddedBraceAC,
      ],
    });
    const { added, prdACs } = run({ agentResponse: response });
    expect(added).toBe(2);
    expect(prdACs).toContain(embeddedBraceAC);
  });

  it('does not duplicate an AC that already exists on the story', () => {
    const response = JSON.stringify({
      story_id: 'SKY-001',
      acs_added: 1,
      acs: ['tsconfig.json must not have extra options'],
    });
    const { added, prdACs } = run({
      existingACs: ['tsconfig.json must not have extra options'],
      agentResponse: response,
    });
    expect(added).toBe(0);
    expect(prdACs.filter((a) => a === 'tsconfig.json must not have extra options')).toHaveLength(1);
  });

  it('respects the 24-AC cap and adds nothing beyond it', () => {
    const existing = Array.from({ length: 24 }, (_, i) => `existing AC ${i}`);
    const response = JSON.stringify({ story_id: 'SKY-001', acs_added: 1, acs: ['one more AC'] });
    const { added, prdACs } = run({ existingACs: existing, agentResponse: response });
    expect(added).toBe(0);
    expect(prdACs).toHaveLength(24);
  });

  it('applies nothing (and does not crash) when the agent reports "already covered" (acs_added: 0, no acs key)', () => {
    const response = JSON.stringify({ story_id: 'SKY-001', acs_added: 0, reason: 'already covered' });
    const { added, prdACs } = run({ agentResponse: response });
    expect(added).toBe(0);
    expect(prdACs).toEqual([]);
  });

  it('applies nothing when the response is garbage (no valid JSON object at all)', () => {
    const { added } = run({ agentResponse: 'I could not complete this task, sorry.' });
    expect(added).toBe(0);
  });
});
