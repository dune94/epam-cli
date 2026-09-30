/**
 * THE SDK PATH (invoke.py, EPAM_SDK_INVOKE=1) CARRIES THE AGENT'S STANDING INSTRUCTIONS.
 *
 * Operator, 2026-09-29: "Ensure each provider has a proper agent si transit." invoke.py sends a
 * system field only when --system-prompt is passed, and the hub never passed one. It now takes the
 * SI the hub resolved for the call (EPAM_SI_FILE) when no --system-prompt is given.
 *
 * LEVEL OF PROOF, stated: invoke.py calls the Anthropic API itself and has no model-free path, so
 * this executes its system-prompt resolution — the real function, a real SI file — and asserts
 * the system field build_messages produces. It does not prove the API received it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles;
const SI = reg[Object.keys(reg).find((s) => reg[s].si) as string].si;

function systemFor(env: Record<string, string>, cliSystem = ''): string {
  const r = spawnSync('python3', ['-c', `
import sys, json; sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import invoke
system, _ = invoke.build_messages("THE TASK", False, invoke.resolve_system_prompt(${JSON.stringify(cliSystem)}))
print(json.dumps(system))`], { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.stringify(JSON.parse(r.stdout));
}

describe('the SDK path carries the agent\'s SI', () => {
  it('with no --system-prompt, the system field is the SI the hub resolved', () => {
    const d = mkdtempSync(join(tmpdir(), 'sdk-si-'));
    try {
      writeFileSync(join(d, 'si'), SI);
      expect(systemFor({ EPAM_SI_FILE: join(d, 'si') })).toContain(JSON.stringify(SI.trim()).slice(1, 40));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('an explicit --system-prompt still wins', () => {
    const d = mkdtempSync(join(tmpdir(), 'sdk-si-'));
    try {
      writeFileSync(join(d, 'si'), SI);
      const s = systemFor({ EPAM_SI_FILE: join(d, 'si') }, 'EXPLICIT');
      expect(s).toContain('EXPLICIT');
      expect(s).not.toContain(JSON.stringify(SI.trim()).slice(1, 40));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('no SI anywhere: no system field — never an invented one', () => {
    expect(systemFor({ EPAM_SI_FILE: '' })).toBe('null');
  });
});
