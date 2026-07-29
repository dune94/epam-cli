/**
 * The health probe must ask the runner the project actually declares.
 *
 * Live metrolinx 2026-07-29. All three lanes halted at Step 5 with "codeline
 * CANNOT BE VERIFIED", on codelines whose dependency trees were fine:
 *
 *   probe picked:  node_modules/.bin/escodegen      <- alphabetically first
 *   node escodegen --version  ->  Error: Invalid option '--version'
 *   jest --version            ->  29.5.0            <- the tree is healthy
 *
 * `ensure_node_modules_healthy` took whatever `find node_modules/.bin | head -1`
 * returned and ran `node <that> --version`. That is an arbitrary package — here
 * a code generator with no --version flag — so the probe reported a broken tree
 * for a working one.
 *
 * It had always done this. The caller's `|| true` swallowed the verdict, so the
 * false negative was invisible until that mask was removed and every lane
 * stopped. Two defects that cancelled out: a probe that lies, and a caller that
 * ignores it. Fixing only the caller made the lie fatal.
 *
 * THREE-VALUED, NOT TWO. "Cannot run the tests" must halt. "Cannot tell" must
 * not — an inconclusive probe that halts is just the escodegen bug again with a
 * different trigger. So: identify the declared runner and probe it; if the
 * project declares no runner we can identify, say so and let the real test
 * command be the signal, because that command is the actual question anyway.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fnSrc(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name} not found`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

/**
 * A codeline with a declared test runner plus a decoy package that sorts first
 * and rejects --version — exactly the live shape.
 */
function codeline(opts: { declaredRunner?: string; runnerWorks?: boolean; decoy?: boolean }) {
  const d = mkdtempSync(join(tmpdir(), 'nm-health-'));
  dirs.push(d);
  const bin = join(d, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });

  writeFileSync(join(d, 'package.json'), JSON.stringify({
    name: 'fixture',
    scripts: opts.declaredRunner ? { test: `${opts.declaredRunner} --ci` } : {},
  }));

  if (opts.decoy !== false) {
    // Sorts before most runners; throws on --version, like escodegen.
    const decoy = join(bin, 'aaa-decoy');
    writeFileSync(decoy, '#!/usr/bin/env node\nconsole.error("Invalid option");process.exit(1);\n');
    chmodSync(decoy, 0o755);
  }
  if (opts.declaredRunner) {
    const r = join(bin, opts.declaredRunner);
    writeFileSync(r, opts.runnerWorks === false
      ? '#!/usr/bin/env node\nprocess.exit(1);\n'
      : '#!/usr/bin/env node\nconsole.log("1.2.3");\n');
    chmodSync(r, 0o755);
  }
  return d;
}

/** Execute the real probe. Returns its exit status and output. */
function probe(root: string) {
  const d = mkdtempSync(join(tmpdir(), 'nm-probe-'));
  dirs.push(d);
  const script = join(d, 'p.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
warning(){ echo "WARN: $*"; }
log(){ echo "LOG: $*"; }
info(){ echo "INFO: $*"; }
error(){ echo "ERROR: $*"; }
success(){ echo "SUCCESS: $*"; }
detect_and_install_dependencies(){ echo "REPAIR_ATTEMPTED"; return 1; }
${fnSrc('ensure_node_modules_healthy')}
ensure_node_modules_healthy ${JSON.stringify(root)} "$(command -v node)" ""
echo "RC=$?"
`);
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  return { rc: Number((out.match(/RC=(\d+)/) || [, '1'])[1]), out };
}

describe('a healthy tree is not condemned by an unrelated package', () => {
  it('passes when the DECLARED runner works, despite a decoy that rejects --version', () => {
    // The exact live failure: escodegen sorted first and threw, so three
    // healthy codelines were declared unverifiable.
    const r = probe(codeline({ declaredRunner: 'jest' }));
    expect(r.rc, `a healthy codeline was condemned:\n${r.out}`).toBe(0);
    expect(r.out, 'a repair was attempted on a healthy tree').not.toMatch(/REPAIR_ATTEMPTED/);
  });
});

describe('a genuinely broken tree is still caught', () => {
  it('fails when the declared runner itself is broken', () => {
    const r = probe(codeline({ declaredRunner: 'jest', runnerWorks: false }));
    expect(r.rc, 'a broken runner was passed as healthy').not.toBe(0);
  });

  it('fails when the declared runner is missing entirely', () => {
    const d = codeline({});
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'f', scripts: { test: 'jest --ci' } }));
    expect(probe(d).rc, 'a missing runner was passed as healthy').not.toBe(0);
  });
});

describe('inconclusive is not the same as broken', () => {
  it('does NOT condemn a project that declares no test script', () => {
    // We cannot identify a runner, so we cannot claim the tree is broken. The
    // real test command is the actual question, and Step 5 runs it next.
    const r = probe(codeline({ declaredRunner: undefined }));
    expect(r.rc,
      `a project with no declared test script was reported unverifiable:\n${r.out}`)
      .toBe(0);
  });

  it('says it could not determine health, rather than asserting failure', () => {
    const r = probe(codeline({ declaredRunner: undefined }));
    expect(r.out).toMatch(/could not|cannot determine|no test script|inconclusive/i);
  });
});
