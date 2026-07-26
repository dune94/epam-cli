/**
 * A QA gate that can call write_file will eventually "answer" by writing a file.
 *
 * Live metrolinx 2026-07-26, run 3. perf-sentinel's entire log was:
 *
 *     The file has been written successfully.
 *
 * Both attempts exhausted, no verdict, ~20 minutes of budget spent reviewing
 * nothing. fuzz-weaver produced a 0-byte log in the same run. Two of six quality
 * gates passed the phase without examining anything.
 *
 * This exact failure was diagnosed and structurally fixed for the
 * code-graph-detective on 2026-07-23 — EPAM_ALLOWED_TOOLS='bash', so the tool
 * is never handed to the model and the failure becomes unreachable. The
 * mechanism's own documentation (src/tools/createTools.ts) names the intended
 * beneficiaries: "Read-only agents (the code-graph-detective, review-agent, and
 * the source-reading QA gates) must never be able to reach write_file — a bug
 * found live 2026-07-23 where the detective 'answered' by calling WriteFile and
 * its real output was lost. Prompt instructions could not prevent that; this
 * does."
 *
 * The QA gates never got the wiring. Instead the pipeline accumulated two
 * work-arounds for the symptom: a retry that detects "has been written" and
 * prepends a corrective paragraph, and a recovery pass that searches the
 * project for the file the model wrote. Both are prose-and-cleanup against a
 * capability that should simply not be there.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyToolAllowlist } from '../../../src/tools/createTools';
import { createTools } from '../../../src/tools/createTools';

const REPO_ROOT = join(__dirname, '../../../');
const orchSrc = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

/**
 * The allowlist VALUE the orchestration script gives its tool-enabled agents.
 * EPAM_ALLOWED_TOOLS is set from a shell variable, so resolve that variable's
 * default rather than capturing the literal "${...}" reference — capturing the
 * reference would make every allowlist "match nothing", which is precisely the
 * silent all-tools-disabled state these tests exist to catch.
 */
function configuredAllowlist(): string | null {
  const varRef = orchSrc.match(/EPAM_ALLOWED_TOOLS="\$\{([A-Z_]+)\}"/);
  if (varRef) {
    const def = new RegExp(`${varRef[1]}="\\$\\{${varRef[1]}:-([^}"]+)\\}"`).exec(orchSrc);
    return def ? def[1] : null;
  }
  const inline = orchSrc.match(/EPAM_ALLOWED_TOOLS="?\$\{[A-Z_]+:-([^}"]+)\}"?/) ||
                 orchSrc.match(/EPAM_ALLOWED_TOOLS="([^"$]+)"/);
  return inline ? inline[1] : null;
}

describe('the QA gates are structurally prevented from writing files', () => {
  it('sets an explicit tool allowlist', () => {
    expect(configuredAllowlist(),
      'no EPAM_ALLOWED_TOOLS is set for tool-enabled gate agents, so write_file is ' +
      'handed to every one of them — perf-sentinel used it and reviewed nothing')
      .toBeTruthy();
  });

  it('the allowlist really excludes write_file — not just by looking right', () => {
    // Assert on BEHAVIOUR of the allowlist mechanism with the configured value,
    // so a typo ("readfile,bash" vs "read_file,bash") cannot pass this test.
    const allowlist = configuredAllowlist();
    expect(allowlist).toBeTruthy();
    const allowed = applyToolAllowlist([...createTools()], allowlist!);
    const names = allowed.map(t => t.name);

    expect(names, `write_file survived the allowlist ${JSON.stringify(allowlist)}`)
      .not.toContain('write_file');
    expect(allowed.length, 'the allowlist matched nothing — a typo would disable ALL tools, ' +
      'leaving the gates unable to read source and hallucinating findings instead')
      .toBeGreaterThan(0);
  });

  it('still allows the gates to READ source — that is why they have tools at all', () => {
    // "Without tool access these agents hallucinate findings about files they
    // cannot verify" — run_orch_prompt_with_tools' own comment.
    const allowed = applyToolAllowlist([...createTools()], configuredAllowlist()!);
    const names = allowed.map(t => t.name);
    expect(names, 'the gates can no longer read files').toContain('read_file');
  });

  it('is applied on the QA gate retry path, not only the helper', () => {
    // _run_qa_gate_with_retry calls run_orch_prompt directly rather than going
    // through run_orch_prompt_with_tools, so wiring only the helper would leave
    // every actual gate invocation unrestricted.
    const start = orchSrc.indexOf('_run_qa_gate_with_retry() {');
    expect(start, '_run_qa_gate_with_retry not found').toBeGreaterThan(-1);
    const body = orchSrc.slice(start, start + 4000);
    expect(body, 'the retry path invokes the model without the allowlist')
      .toMatch(/EPAM_ALLOWED_TOOLS/);
  });

  it('remains overridable per project', () => {
    // Stack specifics belong in per-project config, never hardcoded in the engine.
    expect(orchSrc).toMatch(/ORCH_GATE_ALLOWED_TOOLS="\$\{ORCH_GATE_ALLOWED_TOOLS:-/);
  });
});
