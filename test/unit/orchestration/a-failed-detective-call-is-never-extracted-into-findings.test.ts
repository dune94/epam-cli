/**
 * A FAILED DETECTIVE CALL IS NEVER "EXTRACTED" INTO FINDINGS.
 *
 * Live 2026-10-02, AMSD-2974, the detective re-run on copilot: every call failed to start the CLI
 * ("[copilot] call failed (invocation): unrecognized subcommand '--available-tools=bash'"). The
 * call salvages its output on failure, so phase 1 handed the ERROR TEXT on; phase 2 (a no-tools
 * "extract the JSON from this investigation" turn) ran on it and "recovered 1 fix-site(s)" for
 * every codeline — sites no investigation produced, one in a file that does not exist. They were
 * written to the PRD.
 *
 * Phase 2 exists for a phase 1 that INVESTIGATED and ended in prose. A call that failed did not
 * investigate: it stays a failure, and the detective's own retry and ladder take it from there.
 *
 * EXECUTED: the real runCodeGraphDetective, with a stand-in runner that fails the way the live one
 * did — and that would answer with findings if it were ever asked to extract, which is the
 * fabrication this proves cannot happen. Alongside it, the case phase 2 exists for still works.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations');
const work = mkdtempSync(join(tmpdir(), 'failed-detective-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const repo = join(work, 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0' }));
writeFileSync(join(repo, 'src', 'toast.ts'), 'export const toast = 1;\n');
const proj = join(work, 'project'); mkdirSync(join(proj, 'prompts'), { recursive: true });
copyFileSync(join(ORCH, 'prompts/templates/code-graph-detective.json'), join(proj, 'prompts', 'code-graph-detective.json'));
const EXTRACT_MARK = JSON.parse(readFileSync(join(ORCH, 'prompts/templates/detective-extract.json'), 'utf8')).body.slice(0, 60);

/** A runner: fails every investigation the given way; answers an extraction with findings. */
function runner(name: string, investigation: string, exitCode: number) {
  const calls = join(work, `${name}.calls`);
  const sh = join(work, `${name}.sh`);
  writeFileSync(join(work, `${name}.mark`), EXTRACT_MARK);
  writeFileSync(sh, `#!/bin/bash
IN="$(cat)"
if printf '%s' "$IN" | grep -qF -f ${JSON.stringify(join(work, `${name}.mark`))}; then
  echo extract >> ${JSON.stringify(calls)}
  echo '[{"file":"src/toast.ts","function":"toast","reason":"invented","fix":"f","changeRequired":true}]'
  exit 0
fi
echo investigate >> ${JSON.stringify(calls)}
printf '%s\\n' ${JSON.stringify(investigation)}
exit ${exitCode}
`);
  chmodSync(sh, 0o755);
  return { sh, calls };
}

async function detect(r: { sh: string }) {
  const saved = { ...process.env };
  Object.assign(process.env, { EPAM_BROWNFIELD: '1', EPAM_PROJECT_CONFIG_DIR: proj, PROJECT_ROOT: repo, AI_RUNNER_CMD: r.sh, EPAM_ORCHESTRATION_PROVIDER: process.env.EPAM_ORCHESTRATION_PROVIDER || 'openrouter', SPEC_MODE_NO_MAIN: '1' });
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const spec = require(join(ORCH, 'scripts/spec-mode-runner.js'));
    const logDir = join(work, `logs-${Math.random().toString(36).slice(2)}`); mkdirSync(logDir, { recursive: true });
    return await spec.runCodeGraphDetective({ id: 'S-1', title: 'toast', description: 'make the toast accessible', codeline: 'r' }, logDir, { promptExec: { cmd: r.sh, args: [] } });
  } finally { process.env = saved; }
}
const calls = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : []);

describe('a failed call stays a failure', () => {
  it('the runner never starts: no extraction is asked for, and no fix site comes back', async () => {
    const r = runner('fails', "[copilot] call failed (invocation): unrecognized subcommand '--available-tools=bash'", 1);
    const findings = await detect(r);
    expect(calls(r.calls).filter((c) => c === 'investigate').length, 'the detective never tried').toBeGreaterThan(0);
    expect(calls(r.calls), 'a failed call was handed to extraction').not.toContain('extract');
    expect(findings || []).toEqual([]);
  }, 170000);
});

describe('the case extraction exists for still works', () => {
  it('a completed investigation that ended in prose is extracted', async () => {
    const r = runner('prose', 'I traced the toast to src/toast.ts, where the message is rendered without a live region.', 0);
    const findings = await detect(r);
    expect(calls(r.calls)).toContain('extract');
    expect((findings || []).map((f: any) => f.file)).toContain('src/toast.ts');
  }, 170000);
});
