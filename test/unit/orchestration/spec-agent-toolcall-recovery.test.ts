/**
 * Spec agent answered via a write_file TOOL CALL instead of tagged JSON inline
 * (found live 2026-07-24, AMSD-1820 run: glm-5.1 emitted `<tool_use>...write_file...`
 * wrapping its real spec JSON in the call's `content` arg). extractTaggedJson only
 * handled `<_TAG>`/`<-TAG>`/code-fences, so it returned null → speckit null → FATAL
 * abort. The answer is RECOVERABLE — it's sitting in the tool call's content field.
 *
 * This is the same failure class as the detective "answered by writing a file" bug,
 * but for openspec/speckit. extractTaggedJson must unwrap a tool-call wrapper and
 * recover the JSON payload. General (any model / any tag), no model-specific hardcoding.
 */
import { describe, it, expect } from 'vitest';

const { extractTaggedJson } = require('../../../orchestrations/scripts/spec-mode-runner.js');

// The exact shape emitted live: a write_file tool call whose `content` is the real
// (escaped) spec JSON payload the pipeline actually wanted.
const PAYLOAD = { acceptanceCriteria: ['Given a return trip with a promo code, the email shows the discount'], notes: 'defect fix', splitStories: [] };
const TOOL_USE_OUTPUT = `<tool_use>
<server_name>filesystem</server_name>
<tool_name>write_file</tool_name>
<arguments>
${JSON.stringify({ path: '/tmp/.speckit/AMSD-1820/out.json', content: JSON.stringify(PAYLOAD) })}
</arguments>
</tool_use>`;

describe('extractTaggedJson — recover a payload the model hid inside a write_file tool call', () => {
  it('unwraps a <tool_use> write_file call and returns the JSON from its content arg', () => {
    const result = extractTaggedJson(TOOL_USE_OUTPUT, 'SPEC_AGENT');
    expect(result).not.toBeNull();
    expect(result.acceptanceCriteria).toEqual(PAYLOAD.acceptanceCriteria);
    expect(result.notes).toBe('defect fix');
  });

  it('recovers a DIFFERENT tool-call shape: <tool_name>WriteFile</tool_name><input>{...}</input>', () => {
    // Found live 2026-07-24 (MODEL_REVIEW): a different provider used `<input>` (not
    // `<arguments>`) and `file_path` (not `path`). The unwrapper must be format-general.
    const out = `<tool_name>WriteFile</tool_name>\n<input>${JSON.stringify({ file_path: '/tmp/model-review-core.json', content: JSON.stringify(PAYLOAD) })}</input>`;
    const result = extractTaggedJson(out, 'MODEL_REVIEW');
    expect(result).not.toBeNull();
    expect(result.acceptanceCriteria).toEqual(PAYLOAD.acceptanceCriteria);
  });

  it('still works normally when the model returns a proper <TAG> JSON (no regression)', () => {
    const tagged = `<SPEC_AGENT>${JSON.stringify(PAYLOAD)}</SPEC_AGENT>`;
    const result = extractTaggedJson(tagged, 'SPEC_AGENT');
    expect(result.acceptanceCriteria).toEqual(PAYLOAD.acceptanceCriteria);
  });

  it('returns null for genuinely unparseable output (no false recovery)', () => {
    expect(extractTaggedJson('the model rambled with no json at all', 'SPEC_AGENT')).toBeNull();
  });
});
