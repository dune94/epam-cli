/**
 * THE BASELINE RUNS THE SAME SUITE COMMAND AS THE STORY — ONE DEFINITION.
 *
 * AMSD-2974 writer run, 2026-10-03: a story's verification ran the project's CLOCK-PINNED command
 * (testCommandFor), the baseline it is judged against ran the plain test.command. On cx-shared the
 * pin itself fails ten date-picker tests (its global Date collides with jest fake timers): the
 * baseline recorded none, so all ten were charged to the story — failures the writer could not
 * cause or fix, retried until the attempts ran out. Both runs must be the same command, so what the
 * codeline already fails is subtracted and a story is judged only on what it changes.
 *
 * EXECUTED: the real baseline runner (_run_project_verification, lib/tsc-baseline-gate.sh) and the
 * real plugin (plugins/verification-plugin.js), on a codeline whose suite fails only when pinned.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations');
const work = mkdtempSync(join(tmpdir(), 'same-suite-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const root = join(work, 'codeline'); mkdirSync(join(root, '.epam'), { recursive: true });
const instant = '2026-01-15T15:00:00Z';
// A suite that fails ONLY under the pinned clock — the shape of cx-shared's date-picker specs.
writeFileSync(join(root, 'check.js'), `if (Date.now() === new Date(${JSON.stringify(instant)}).getTime()) { console.log('FAIL check.js'); process.exit(1); } console.log('ok');\n`);
writeFileSync(join(root, '.epam', 'verification.json'), JSON.stringify({ test: {
  command: 'node check.js', clockInstant: instant, clockPinnedCommand: 'node -r {setupFile} check.js' } }));

const plugin = require(join(ORCH, 'plugins/verification-plugin.js'));

function baselineRunner() {
  return spawnSync('bash', ['-c', `source ${JSON.stringify(join(ORCH, 'scripts/lib/tsc-baseline-gate.sh'))} 2>/dev/null; _run_project_verification ${JSON.stringify(root)} test`],
    { encoding: 'utf8', env: { ...process.env, AUTOMATION_DIR: ORCH, NODE_BIN: process.execPath } });
}

describe('the baseline runs the same suite command as the story', () => {
  it('the story\'s command is the pinned one, and the pinned suite fails here', () => {
    const cmd = plugin.testCommandFor(root);
    expect(cmd).toContain('-r ');
    expect(spawnSync('bash', ['-c', cmd], { cwd: root, encoding: 'utf8' }).status).toBe(1);
  });

  it('the baseline runner runs that same pinned command — so it sees the same failure', () => {
    const r = baselineRunner();
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('FAIL check.js');
  });

  it('with no pin declared both run the plain command, unchanged', () => {
    const plain = join(work, 'plain'); mkdirSync(join(plain, '.epam'), { recursive: true });
    writeFileSync(join(plain, 'check.js'), "console.log('ok');\n");
    writeFileSync(join(plain, '.epam', 'verification.json'), JSON.stringify({ test: { command: 'node check.js' } }));
    expect(plugin.testCommandFor(plain)).toBe('node check.js');
    const r = spawnSync('bash', ['-c', `source ${JSON.stringify(join(ORCH, 'scripts/lib/tsc-baseline-gate.sh'))} 2>/dev/null; _run_project_verification ${JSON.stringify(plain)} test`],
      { encoding: 'utf8', env: { ...process.env, AUTOMATION_DIR: ORCH, NODE_BIN: process.execPath } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
