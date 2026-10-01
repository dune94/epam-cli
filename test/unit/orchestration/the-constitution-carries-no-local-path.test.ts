/**
 * THE CONSTITUTION CARRIES NO LOCAL PATH.
 *
 * Operator, 2026-10-01: "ensure hard coded local paths are not generated into prompts or SI text.
 * This is not permitted. Relative paths only." The constitution is in every agent's SI, and its
 * filesystem rule rendered the run's absolute project root into all of them (115 of 115 calls in
 * the brownfield rehearsal) — and into every stored CodeMie assistant the team can see.
 *
 * EXECUTED: the real renderer, for an absolute root on this machine, checked by the rehearsal's own
 * local-path rule.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localPathFindings } from '../../mock-agent/si-check';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { constitution } = require(join(__dirname, '../../../orchestrations/scripts/lib/agent-contract.js'));

describe('the constitution carries no local path', () => {
  it('rendered for an absolute project root, it names the root without its path', () => {
    const root = join(tmpdir(), 'a-run', 'codelines', 'a-repo');
    const text = constitution(root);
    expect(text, 'the constitution rendered nothing — this proves nothing').toMatch(/Filesystem boundary/);
    expect(text).not.toContain(root);
    const call = { n: 1, seam: 's', template: '', coverage: 1, story: '', attempt: 1, req: { system: text, messages: [{ role: 'user', text: 'p' }], tools: [] } } as any;
    expect(localPathFindings(call)).toEqual([]);
  });
});
