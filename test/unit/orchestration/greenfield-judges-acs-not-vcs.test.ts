/**
 * GREENFIELD JUDGES ACCEPTANCE CRITERIA. VERIFICATION CRITERIA ARE BROWNFIELD'S.
 *
 * regintel 20260918T132928Z, core phase on the openrouter set: every non-split story was rejected
 * three times by each spec agent with "verificationCriteria is empty while the description names
 * concrete testable behaviour". The agents had answered — openspec's REGI-002 reply carried four
 * well-formed verificationCriteriaDetail entries — but story.verificationCriteria is only ever
 * populated inside `if (EPAM_BROWNFIELD === '1')`, so on greenfield the answer was discarded and
 * the prd-change-reviewer, whose persona states the VC-model rules, penalised its absence. Model
 * independent: no non-split greenfield story could pass. Scaffold passed only because REGI-001
 * was a split-only change and the reviewer was skipped.
 *
 * Two sites, both mode-aware now:
 *   - the spec agent contract does not ask greenfield for verificationCriteriaDetail (the mirror
 *     of brownfield not being asked for acceptanceCriteria);
 *   - the change reviewer's prompt on greenfield carries the AC-model rules and shows no
 *     verificationCriteria field to trip on. Brownfield is unchanged.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const RUNNER = join(process.cwd(), 'orchestrations/scripts/spec-mode-runner.js');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function contract(brownfield: boolean): any {
  const out = execFileSync(process.execPath, ['-e', `
    process.env.EPAM_BROWNFIELD = ${brownfield ? "'1'" : "'0'"};
    const m = require(${JSON.stringify(RUNNER)});
    process.stdout.write(JSON.stringify(m.specAgentContract()));
  `], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, SPEC_MODE_NO_MAIN: '1' } });
  return JSON.parse(out);
}

/** Run the real reviewPrdChange with a runner that records the prompt and answers "pass". */
function reviewPrompt(brownfield: boolean): { prompt: string; after: any } {
  const d = mkdtempSync(join(tmpdir(), 'gf-review-')); dirs.push(d);
  const runner = join(d, 'fake-runner.sh');
  const captured = join(d, 'prompt.txt');
  writeFileSync(runner, `#!/usr/bin/env bash\ncat > ${JSON.stringify(captured)}\necho '{"verdict":"pass","issues":[]}'\n`);
  chmodSync(runner, 0o755);
  mkdirSync(join(d, 'logs'));
  const story = {
    id: 'REGI-002', title: 'Ingest', description: 'Parse the fixture corpus into 11 ordered EventRecords, verified by tests/test_ingest.py asserting record count and ordering.',
    acceptanceCriteria: ['ingest_fixture returns 11 records RU-001..RU-011 in order'],
    verificationCriteria: [],
  };
  execFileSync(process.execPath, ['-e', `
    process.env.EPAM_BROWNFIELD = ${brownfield ? "'1'" : "'0'"};
    const m = require(${JSON.stringify(RUNNER)});
    const profiles = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(process.cwd(), 'orchestrations/agents/profiles.json'))}, 'utf8'));
    const story = ${JSON.stringify(story)};
    m.reviewPrdChange({ aiRunnerCmd: ${JSON.stringify(runner)}, profiles, storyId: story.id, changeType: 'spec_pass',
      before: m.captureStorySnapshot({ ...story, acceptanceCriteria: [] }), after: m.captureStorySnapshot(story),
      logDir: ${JSON.stringify(join(d, 'logs'))}, splitOccurred: false })
      .then((r) => process.stdout.write(JSON.stringify(r)));
  `], { encoding: 'utf8', timeout: 120_000, env: {
    ...process.env, SPEC_MODE_NO_MAIN: '1',
    // Without a gate provider the reviewer is a declared no-op; the real seam is what is tested.
    ORCH_GATE_PROVIDER: 'openrouter', EPAM_PROVIDER_SET: 'openrouter',
  } });
  const prompt = readFileSync(captured, 'utf8');
  const m = prompt.match(/AFTER:\n(\{.*\})/);
  return { prompt, after: m ? JSON.parse(m[1]) : null };
}

describe('THE SPEC AGENT CONTRACT ASKS EACH MODE ONLY FOR WHAT IT KEEPS', () => {
  it('greenfield is not asked for verificationCriteriaDetail', () => {
    const c = contract(false);
    expect(Object.keys(c.parameters.properties), 'greenfield offers a VC channel whose answer '
      + 'is discarded before the reviewer sees the story').not.toContain('verificationCriteriaDetail');
    expect(c.parameters.required).not.toContain('verificationCriteriaDetail');
    expect(c.parameters.required, 'the ACs ARE greenfield\'s contract').toContain('acceptanceCriteria');
  });

  it('brownfield still requires it', () => {
    const c = contract(true);
    expect(c.parameters.required).toContain('verificationCriteriaDetail');
    expect(c.parameters.properties.verificationCriteriaDetail.minItems).toBe(1);
  });
});

describe('THE CHANGE REVIEWER JUDGES BY THE MODE\'S MODEL', () => {
  it('on greenfield the prompt says the AC model applies and an empty verificationCriteria is not a defect', () => {
    const { prompt } = reviewPrompt(false);
    expect(prompt.length, 'no prompt reached the runner').toBeGreaterThan(0);
    expect(prompt).toMatch(/AC model|acceptance criteria ARE the spec pass/i);
    expect(prompt).toMatch(/verificationCriteria[^.]*(NOT a reason to reject|does not apply|not produced)/i);
  });

  it('on greenfield the AFTER snapshot shows no verificationCriteria field at all', () => {
    const { after } = reviewPrompt(false);
    expect(after, 'the AFTER snapshot could not be read from the prompt').toBeTruthy();
    expect(Object.keys(after)).not.toContain('verificationCriteria');
    expect(after.acceptanceCriteria).toHaveLength(1);
  });

  it('on brownfield the snapshot still carries verificationCriteria and no AC-model override is given', () => {
    const { prompt, after } = reviewPrompt(true);
    expect(Object.keys(after)).toContain('verificationCriteria');
    expect(prompt).not.toMatch(/acceptance criteria ARE the spec pass/i);
  });
});
