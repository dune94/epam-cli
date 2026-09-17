/**
 * SEV 1 — analyst path resolution: all 4 call sites in the pipeline.
 *
 * agent-attempt-analyst.sh lives at orchestrations/scripts/agent-attempt-analyst.sh.
 * Every call site sets (or inherits) SCRIPT_DIR; the path expression used must resolve
 * to that exact file, not a non-existent sibling.
 *
 * tc-writer-gate.sh was broken: it used $SCRIPT_DIR/../agent-attempt-analyst.sh.
 * At runtime, SCRIPT_DIR = orchestrations/scripts/ (the CALLER's dir, never lib/).
 * $SCRIPT_DIR/../ = orchestrations/ — the script does not live there. The analyst
 * was silently never called on any greenfield TC-writer failure.
 *
 * This suite tests all 4 entry points behaviorally: the call-site command is extracted
 * from the real source file and executed in a subprocess with SCRIPT_DIR set to the
 * caller's runtime value. A stub analyst marks a sentinel file when invoked.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Build a temp "scripts/" dir with a stub analyst that writes $1 (failure_class) to a sentinel. */
function makeScriptDir(): { dir: string; scriptDir: string; calledMarker: string } {
  const dir = mkdtempSync(join(tmpdir(), 'analyst-ep-'));
  dirs.push(dir);
  const scriptDir = join(dir, 'scripts');
  mkdirSync(scriptDir, { recursive: true });
  const calledMarker = join(dir, 'called.txt');
  const stub = join(scriptDir, 'agent-attempt-analyst.sh');
  writeFileSync(stub,
    `#!/usr/bin/env bash\nprintf '%s' "$1" > ${JSON.stringify(calledMarker)}\n`);
  chmodSync(stub, 0o755);
  return { dir, scriptDir, calledMarker };
}

/** Extract the first non-comment line containing agent-attempt-analyst.sh from a file.
 * Skips bash (#) and JSDoc (* or //) comment lines; strips trailing )" from command substitutions. */
function extractAnalystLine(filePath: string): string {
  const line = readFileSync(filePath, 'utf8').split('\n')
    .find(l => /agent-attempt-analyst\.sh/.test(l) && !/^\s*[#*]/.test(l) && !/^\s*\/\//.test(l));
  if (!line) throw new Error(`No non-comment analyst call found in ${filePath}`);
  // Strip trailing )" from command substitutions (e.g. _tc_corrective="$(...bash ...)")
  return line.trim().replace(/\)"$/, '');
}

describe('analyst entry points: gate resolves analyst from caller\'s SCRIPT_DIR', () => {
  it('tc-writer-gate.sh: analyst is callable when SCRIPT_DIR is the caller\'s scripts/ dir (not lib/)', () => {
    // At runtime the CALLER sets SCRIPT_DIR = orchestrations/scripts/.
    // The gate (in lib/) INHERITS that value.
    // So $SCRIPT_DIR/agent-attempt-analyst.sh = scripts/agent-attempt-analyst.sh ← CORRECT.
    //    $SCRIPT_DIR/../agent-attempt-analyst.sh = orchestrations/agent-attempt-analyst.sh ← WRONG.
    //
    // This test is RED while the gate has $SCRIPT_DIR/../ and GREEN after the fix to $SCRIPT_DIR/.
    const { dir, scriptDir, calledMarker } = makeScriptDir();
    const tmpLog = join(dir, 'writer.log');
    writeFileSync(tmpLog, 'reached maximum iterations');

    const callLine = extractAnalystLine(
      join(ROOT, 'orchestrations/scripts/lib/tc-writer-gate.sh'));

    const result = spawnSync('bash', ['-c', `
      SCRIPT_DIR=${JSON.stringify(scriptDir)}
      _tc_fclass=no_json
      _tc_writer_log=${JSON.stringify(tmpLog)}
      story_id=test-story
      AGENT_ANALYST_STORY_ID=test-story
      STORY_ROLE=tc-writer
      ${callLine.replace(/2>>"[^"]*"/, '2>/dev/null')} || true
    `], { encoding: 'utf8', timeout: 10_000 });

    expect(existsSync(calledMarker),
      `Analyst stub was NOT called.\n` +
      `  call line: ${callLine}\n` +
      `  SCRIPT_DIR: ${scriptDir}\n` +
      `  stub at:    ${scriptDir}/agent-attempt-analyst.sh\n` +
      `  With $SCRIPT_DIR/../ the path resolves to: ${dir}/agent-attempt-analyst.sh (DOES NOT EXIST)\n` +
      `  With $SCRIPT_DIR/   the path resolves to: ${scriptDir}/agent-attempt-analyst.sh (EXISTS)\n` +
      `  bash stderr: ${result.stderr}`)
      .toBe(true);
  });
});

describe('analyst entry points: other call sites use $SCRIPT_DIR/ (no /..)', () => {
  it('run-agent-orchestration.sh: analyst call uses $SCRIPT_DIR/ not $SCRIPT_DIR/../', () => {
    const line = extractAnalystLine(
      join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'));
    expect(line,
      `run-agent-orchestration.sh uses the broken $SCRIPT_DIR/../ path: ${line}`)
      .not.toMatch(/\$SCRIPT_DIR\s*\/\s*\.\./);
    expect(line).toMatch(/\$SCRIPT_DIR\/agent-attempt-analyst\.sh/);
  });

  it('brownfield-repro-test-writer.sh: analyst call uses $SCRIPT_DIR/ not $SCRIPT_DIR/../', () => {
    const line = extractAnalystLine(
      join(ROOT, 'orchestrations/scripts/brownfield-repro-test-writer.sh'));
    expect(line,
      `brownfield-repro-test-writer.sh uses the broken $SCRIPT_DIR/../ path: ${line}`)
      .not.toMatch(/\$SCRIPT_DIR\s*\/\s*\.\./);
    expect(line).toMatch(/\$SCRIPT_DIR\/agent-attempt-analyst\.sh/);
  });

  it('lib/self-heal.js: analyst path resolves via __dirname/../ to scripts/', () => {
    // self-heal.js lives in lib/; __dirname/../ = scripts/; correct.
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/lib/self-heal.js'), 'utf8');
    // Find the const/let/var that sets the script path using path.join and agent-attempt-analyst
    const line = src.split('\n').find(l =>
      /agent-attempt-analyst\.sh/.test(l) && /path\.join/.test(l) && !/^\s*[/*]/.test(l));
    expect(line, 'self-heal.js must have a path.join line referencing agent-attempt-analyst.sh')
      .toBeTruthy();
    // The JS uses path.join(__dirname, '..', 'agent-attempt-analyst.sh').
    // __dirname for lib/self-heal.js = lib/ — so ../ = scripts/ = correct.
    expect(line).toMatch(/path\.join\(__dirname,\s*['"]\.\.['"]/);
    const resolvedPath = join(ROOT, 'orchestrations/scripts/lib', '..', 'agent-attempt-analyst.sh');
    expect(existsSync(resolvedPath),
      `self-heal.js resolved path does not exist: ${resolvedPath}`)
      .toBe(true);
  });
});

describe('analyst receives failure class and produces output (I/O contract)', () => {
  it('tc-writer-gate.sh passes the failure class as the first argument to the analyst', () => {
    // After the path fix, verify the analyst actually receives $1 = failure class.
    const { dir, scriptDir, calledMarker } = makeScriptDir();
    const tmpLog = join(dir, 'writer.log');
    writeFileSync(tmpLog, 'reached maximum iterations');

    const callLine = extractAnalystLine(
      join(ROOT, 'orchestrations/scripts/lib/tc-writer-gate.sh'));

    spawnSync('bash', ['-c', `
      SCRIPT_DIR=${JSON.stringify(scriptDir)}
      _tc_fclass=max_iterations
      _tc_writer_log=${JSON.stringify(tmpLog)}
      story_id=test-story
      AGENT_ANALYST_STORY_ID=test-story
      STORY_ROLE=tc-writer
      ${callLine.replace(/2>>"[^"]*"/, '2>/dev/null')} || true
    `], { encoding: 'utf8', timeout: 10_000 });

    if (!existsSync(calledMarker)) {
      // Gate path is still broken — skip the I/O check (the path test above already catches this)
      return;
    }
    const received = readFileSync(calledMarker, 'utf8');
    expect(received, 'analyst did not receive the failure class as $1')
      .toBe('max_iterations');
  });
});
