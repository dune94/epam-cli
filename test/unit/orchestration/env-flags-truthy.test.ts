/**
 * Boolean env flags must accept the same values everywhere.
 *
 * THE BUG (hit live 2026-08-03): a run was launched with SKIP_REGRESSION_GUARD=1 on
 * explicit instruction and Step 5 ran anyway, because the check is
 * `[ "${SKIP_REGRESSION_GUARD:-false}" != "true" ]` — only the literal string `true`
 * works. The flag silently did nothing.
 *
 * THE CLASS, which is the real defect: the pipeline runs TWO incompatible conventions
 * with no shared helper —
 *     != "true"  → SKIP_REGRESSION_GUARD, SKIP_PRE_REVIEW_GATE, SKIP_LINT_GATE, SKIP_AUTO_PR
 *     != "1"     → SKIP_CPA, SKIP_TC_WRITER, SKIP_SKILL_ASSESSMENT, SKIP_GATE_REMEDIATION
 * So `SKIP_REGRESSION_GUARD=1` fails precisely BECAUSE it matches the other half of the
 * codebase. Every flag is a coin flip until one helper owns the decision.
 *
 * A flag that silently does nothing is the same failure mode as a gate that logs instead
 * of blocking: the operator believes an instruction took effect when it did not.
 *
 * Real bash execution throughout. Zero LLM/agent calls.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const FLAGS_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/flags.sh');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runBash(body: string, env: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'flags-'));
  cleanupDirs.push(dir);
  const script = join(dir, 'probe.sh');
  writeFileSync(script, ['#!/usr/bin/env bash', 'set -uo pipefail', body].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 15000, env: { ...process.env, ...env } });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}

describe('is_truthy — one helper owns the decision', () => {
  it('the shared library exists', () => {
    expect(existsSync(FLAGS_LIB)).toBe(true);
  });

  const truthy = ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON'];
  it.each(truthy)('accepts %s', (value) => {
    const out = runBash(
      `source ${JSON.stringify(FLAGS_LIB)}\nif is_truthy "\${FLAG:-}"; then echo YES; else echo NO; fi`,
      { FLAG: value },
    );
    expect(out).toBe('YES');
  });

  const falsy = ['0', 'false', 'FALSE', 'no', 'off', '', 'maybe', 'truthy'];
  it.each(falsy)('rejects %s', (value) => {
    const out = runBash(
      `source ${JSON.stringify(FLAGS_LIB)}\nif is_truthy "\${FLAG:-}"; then echo YES; else echo NO; fi`,
      { FLAG: value },
    );
    expect(out).toBe('NO');
  });

  it('rejects an unset variable without tripping set -u', () => {
    const out = runBash(
      `source ${JSON.stringify(FLAGS_LIB)}\nif is_truthy "\${DEFINITELY_UNSET:-}"; then echo YES; else echo NO; fi`,
    );
    expect(out).toBe('NO');
  });
});

describe('the live bug: SKIP_REGRESSION_GUARD=1 must actually skip', () => {
  // The real condition, as the pipeline evaluates it.
  const guard = (flagExpr: string) =>
    `source ${JSON.stringify(FLAGS_LIB)}\nif ${flagExpr}; then echo RAN; else echo SKIPPED; fi`;

  it('=1 skips (this is what silently failed live)', () => {
    expect(runBash(guard('! is_truthy "${SKIP_REGRESSION_GUARD:-}"'), { SKIP_REGRESSION_GUARD: '1' })).toBe('SKIPPED');
  });

  it('=true still skips (the previously-working spelling must not regress)', () => {
    expect(runBash(guard('! is_truthy "${SKIP_REGRESSION_GUARD:-}"'), { SKIP_REGRESSION_GUARD: 'true' })).toBe('SKIPPED');
  });

  it('unset runs the guard — the safe default is never skipped by accident', () => {
    expect(runBash(guard('! is_truthy "${SKIP_REGRESSION_GUARD:-}"'), { SKIP_REGRESSION_GUARD: '' })).toBe('RAN');
  });

  it('=0 runs the guard', () => {
    expect(runBash(guard('! is_truthy "${SKIP_REGRESSION_GUARD:-}"'), { SKIP_REGRESSION_GUARD: '0' })).toBe('RAN');
  });
});

describe('DRIFT GUARD — no SKIP_* flag is compared against a bare literal', () => {
  it('every SKIP_* check in the pipeline goes through is_truthy', () => {
    const scriptsDir = join(REPO_ROOT, 'orchestrations/scripts');
    const offenders: string[] = [];
    for (const name of readdirSync(scriptsDir).filter((f) => f.endsWith('.sh'))) {
      const file = join(scriptsDir, name);
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*#/.test(line)) return;
        // A SKIP_* variable expanded and compared to a literal "true"/"1"/"false"/"0".
        // `[!=]?=` deliberately covers `=`, `==` AND `!=`: an earlier version of this
        // regex only matched `!=`, which silently exempted every single-`=` site —
        // including the Step 5 checklist row, which would then have displayed "ACTIVE"
        // for a guard that was actually being skipped. A drift guard with a blind spot
        // is worse than none, because it certifies the blind spot as clean.
        if (/\$\{SKIP_[A-Z_]*(:-[^}]*)?\}"?\s*[!=]?=\s*"(true|false|1|0)"/.test(line)) {
          offenders.push(`  ${name}:${i + 1}  ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(
      offenders,
      `A SKIP_* flag compared to a bare literal accepts ONLY that spelling, so the other ` +
        `convention in this same codebase silently does nothing — which is exactly how ` +
        `SKIP_REGRESSION_GUARD=1 was ignored on a real run. Use is_truthy from ` +
        `lib/flags.sh:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
