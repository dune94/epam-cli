/**
 * LIVE integration test — mimics claude.sh's run_failure_analyst step with a
 * real model call (same gate model this pipeline uses: minimax/MiniMax-M3),
 * feeding it the exact recurring failure class this session kept hitting:
 * a test file importing supertest without adding it to devDependencies.
 *
 * Requires MINIMAX_API_KEY. Skipped automatically if not set.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = join(__dirname, '../../');
const PROFILES = join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const AI_RUN = join(REPO_ROOT, 'orchestrations/scripts/ai-run.sh');

const hasKey = !!process.env.MINIMAX_API_KEY;

const VERIFICATION_FAILURE = `
## Verification Failure

The orchestrator ran \`npm test\` after your files were written and it failed (exit code 1).

\`\`\`
Error: Cannot find module 'supertest'
Require stack:
- src/server.test.ts
FAIL src/server.test.ts
\`\`\`
`;

describe.skipIf(!hasKey)('failure-analyst — LIVE call, real model, recurring supertest failure', () => {
  it('diagnoses the missing devDependency and does not pick target=none', () => {
    const profiles = JSON.parse(readFileSync(PROFILES, 'utf8'));
    const analystProfile = profiles['failure-analyst'];
    expect(analystProfile).toBeTruthy();

    const prompt = `${analystProfile}

STORY: SKY-TEST
AGENT ROLE: typescript-engineer

CURRENT TEST CRITERIA (TC facts when available, ACs as fallback):
- Server exposes GET /health returning 200

AGENT SKILL ADDENDUM (instructions in the agent's system prompt):
(none)

TEST FAILURE OUTPUT:
${VERIFICATION_FAILURE}

Output ONLY a single JSON object. No markdown fences, no prose outside the JSON:
{"diagnosis":"<one sentence>","target":"prd|tc|skill|kb|tool|none","ac_patches":[],"tc_patches":[],"skill_note":"<if target=skill or target=kb>","tool_spec":{"name":"...","purpose":"...","recipe":"..."},"reason":"<why this prevents recurrence>"}

Decision rules:
- target=tool: the failure is a repeated MECHANICAL step (not a knowledge gap) — e.g. "add a package to package.json and install it before importing it". Provide tool_spec.
- target=kb: a reusable coding rule all future agents with this role should know.
- target=none: transient code mistake, not a real pattern.
Keep diagnosis under 20 words, reason under 15 words.`;

    const raw = execFileSync(
      'bash',
      [AI_RUN, '--provider', 'minimax', '--model', 'MiniMax-M3'],
      { input: prompt, encoding: 'utf8', timeout: 60_000 }
    );

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    expect(jsonMatch).toBeTruthy();
    const parsed = JSON.parse(jsonMatch![0]);

    // The model must recognize this as a fixable, non-transient pattern —
    // NOT target=none (which would mean "just retry and hope"), and the
    // diagnosis must actually name the real cause.
    expect(parsed.target).not.toBe('none');
    expect(['tool', 'kb', 'skill']).toContain(parsed.target);
    expect(parsed.diagnosis.toLowerCase()).toMatch(/supertest|devdependenc|dependency|install|module/);
  }, 70_000);
});
