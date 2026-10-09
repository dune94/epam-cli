/**
 * THE MOCK DIAGNOSES AN AGENT THAT PRODUCED NOTHING USABLE.
 *
 * Fresh rehearsal of AMSD-2974, 2026-10-09: the repro-test writer answered "I could not write a reproducing test", and
 * agent self-heal (agent-attempt-analyst.sh → seam agent-failure-analyst) asked for a diagnosis. Its template asks for
 * prose, never shows a "diagnosis" key, so the mock's diagnosing behaviour did not recognise it and answered "OK" — no
 * JSON for a contract requiring "diagnosis" — and refused itself as stale five times. A model reads the prompt's own
 * sections: what the agent produced, why it was refused, the class's hint. So does the mock now.
 *
 * EXECUTED: the real template (prompts/templates/agent-failure-analyst.json) with its placeholders filled as the
 * analyst fills them, answered by the mock's seam.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFailureDiagnosis } from './seams/analyst';

const T = JSON.parse(readFileSync(join(__dirname, '../../orchestrations/prompts/templates/agent-failure-analyst.json'), 'utf8')).bodies;
const render = (v: Record<string, string>) => Object.entries(v).reduce((s, [k, x]) => s.split(k).join(x), T.prompt as string);

describe('a diagnosis of the agent that failed', () => {
  const prompt = render({
    __CLASS_HINT__: T.hint_no_file, __FAILURE_CLASS__: 'no_file',
    __FAILURE_REASON__: 'the required test file was not written at src/x/__tests__/X.spec.tsx',
    __FAILED_OUTPUT__: 'I could not write a reproducing test: the prompt gave no readable example, diff or path.',
    __CONTEXT__: 'Write ONE test that reproduces the defect the fix corrected.', __FIX_SITES__: '(none)',
  });
  const a = JSON.parse(agentFailureDiagnosis(prompt));
  it('names what the agent actually said, and why it was refused', () => {
    expect(a.diagnosis).toContain('could not write a reproducing test');
    expect(a.diagnosis).toContain('src/x/__tests__/X.spec.tsx');
  });
  it('prescribes from the class hint the prompt carries, not generic advice', () => {
    expect(a.diagnosis).toMatch(/FIRST action|exact required path/);
  });
  it('is one prose diagnosis under the contract\'s key', () => {
    expect(typeof a.diagnosis).toBe('string');
    expect(a.diagnosis.length).toBeGreaterThan(40);
  });
});
