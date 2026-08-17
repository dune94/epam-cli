/**
 * STEP 4.2 INJECTS EVIDENCE INTO THE SAST GATE BEFORE THE AGENT JUDGES. THE EVIDENCE-GATHERING
 * WAS WRITTEN INTO THE SCRIPT, AND ONE HALF OF IT ONLY RAN FOR ONE REPOSITORY LAYOUT.
 *
 * The dependency-audit classifier was a 48-line Python program held in a shell single-quoted
 * string and piped to `python3 -`, inside a 1590-line function. It could not be run on its own,
 * could not be tested, and was invisible to every Python tool in the repo — while doing the one
 * job the SAST prompt REQUIRES: tagging each CVE runtime/dev/transitive, because a runtime high is
 * a major finding and a dev-only one is minor regardless of CVSS. (Live 2026-07-26 the agent said
 * it could not comply and left 70 CVEs unclassified.)
 *
 * The semgrep oracle ran only `if [ -d "$PROJECT_ROOT/src" ]`, and scanned only that directory. A
 * repository laying its code out any other way — lib/, app/, pkg/, cmd/, or flat at the root — got
 * NO static-analysis evidence at all, silently, and the agent judged the change without it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const AUDIT = join(SCRIPTS, 'lib/handlers/dependency-audit-summary.py');

/** run_testing_gates only — the rest of the file is not this step. */
function gatesFn(): string {
  const src = readFileSync(ORCH, 'utf8');
  const i = src.indexOf('run_testing_gates() {');
  expect(i, 'run_testing_gates is gone').toBeGreaterThan(-1);
  return src.slice(i, src.indexOf('\n}', i));
}
const code = (s: string) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'sast-oracle-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function summarise(pkg: object, audit: object): string {
  writeFileSync(join(work, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(work, 'audit.json'), JSON.stringify(audit));
  const r = spawnSync('python3', [AUDIT, join(work, 'audit.json'), join(work, 'package.json')], { encoding: 'utf8' });
  expect(r.status, `the handler crashed: ${r.stderr}`).toBe(0);
  return r.stdout;
}

describe('the sast oracles are not written in the script', () => {
  it('the dependency classifier is a runnable file, not a shell string', () => {
    const body = code(gatesFn());
    expect(body, 'a Python program is still embedded in the function').not.toMatch(/_audit_py='/);
    expect(body, 'the handler is not called').toMatch(/dependency-audit-summary\.py/);
  });

  it('it tags a runtime CVE differently from a dev-only one — the rule the prompt depends on', () => {
    const out = summarise(
      { dependencies: { lodash: '^4' }, devDependencies: { vitest: '^2' } },
      { vulnerabilities: {
        lodash: { severity: 'high', via: ['CVE-RUNTIME'] },
        vitest: { severity: 'low', via: ['CVE-DEV'] },
      } },
    );
    expect(out, 'a runtime dependency was not tagged runtime').toMatch(/\(runtime\)\s+lodash/);
    expect(out, 'a dev dependency was not tagged dev').toMatch(/\(dev\)\s+vitest/);
  });

  it('a package in neither list is transitive, not silently runtime', () => {
    // The major/minor rule turns on this. Guessing "runtime" inflates every transitive CVE.
    const out = summarise(
      { dependencies: { lodash: '^4' } },
      { vulnerabilities: { 'deep-thing': { severity: 'critical', via: ['CVE-X'] } } },
    );
    expect(out).toMatch(/\(transitive\)\s+deep-thing/);
  });

  it('says "unclassified" when the manifest tells it nothing, rather than inventing a tag', () => {
    const out = summarise({}, { vulnerabilities: { x: { severity: 'high', via: ['CVE-Y'] } } });
    expect(out).toMatch(/\(unclassified\)/);
  });

  it('the static-analysis oracle assumes no repository layout', () => {
    const body = code(gatesFn());
    const i = body.indexOf('semgrep scan');
    expect(i, 'the semgrep oracle is gone').toBeGreaterThan(-1);
    const block = body.slice(Math.max(0, i - 500), i + 500);
    expect(block, 'semgrep still only runs when the repo happens to use src/')
      .not.toMatch(/\$PROJECT_ROOT\/src/);
  });

  it('no inline python one-liner is left in the gates', () => {
    // json-field.py already existed and did exactly what the inline program did.
    const body = code(gatesFn());
    expect(body, 'an inline python program is still parsing JSON here').not.toMatch(/python3 -c "import/);
  });

  it('a gate still refuses to run when its prompt cannot be rendered', () => {
    // Guard against the fixes above weakening the one thing this block already got right.
    const body = code(gatesFn());
    expect(body, 'the sast gate no longer refuses on an unrendered prompt')
      .toMatch(/cannot render its prompt/);
  });
});
