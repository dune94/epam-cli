/**
 * THE ENGINE MUST NOT NAME A STACK'S TOOLS. VERIFICATION IS DECLARED BY THE PROJECT.
 *
 * `tsc` was invoked from sixteen hardcoded sites across five scripts, each assuming TypeScript,
 * `tsconfig.json`, `src/`, `.ts` and a pinned Node path — including a fully spelled-out
 * `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/tsc` in merge-worktree.sh.
 *
 * Two consequences, both measured 2026-08-10:
 *
 *  1. Any non-TypeScript stack silently PASSED every compile gate, because a missing
 *     `tsconfig.json` was read as "nothing to verify" rather than "I cannot verify this".
 *  2. Even for TypeScript it ran the WRONG check. The Metrolinx repos declare `check-types` as
 *     `tsc --noEmit --incremental` (gotransit) and plain `tsc` (metrolinx — which EMITS files).
 *     The engine ran `tsc --noEmit` on both. It had never once run the projects' own check.
 *
 * This is a SWEEP: it fails on any future engine code that invokes a stack-specific binary for
 * verification. A plugin alone would not prevent that — nothing stops someone adding another
 * direct call. The point is that the whole class becomes impossible to reintroduce.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');

function engineScripts(): Array<{ file: string; lines: string[] }> {
  const files: string[] = [];
  for (const f of readdirSync(SCRIPTS)) if (f.endsWith('.sh')) files.push(join(SCRIPTS, f));
  for (const f of readdirSync(join(SCRIPTS, 'lib'))) if (f.endsWith('.sh')) files.push(join(SCRIPTS, 'lib', f));
  return files.map((file) => ({ file: file.replace(ROOT, ''), lines: readFileSync(file, 'utf8').split('\n') }));
}

/** A line that RUNS a stack-specific checker, as opposed to mentioning one in prose. */
function invocationSites(): string[] {
  const out: string[] = [];
  // Binaries an engine must never name: they belong to one ecosystem.
  // Invocation forms AND bare mentions: a tool named in an instruction is still the engine
  // naming an ecosystem. Deliberately a closed list of ecosystem tools, not a language model
  // of English — it fails on the specific thing the engine must never know about.
  const BINARIES = [/node_modules\/\.bin\/tsc/, /\btsc\b/, /\bmypy\b/, /\bgo\s+build\b/,
                    /\bvitest\b/, /\bjest\b/, /\bnpm\s+test\b/, /\bpytest\b/];
  for (const { file, lines } of engineScripts()) {
    lines.forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith('#')) return;                       // prose
      if (/--showConfig|readlink|echo "tsc=/.test(l)) return;        // diagnostics, not verification
      if (/^(log|echo|success|warning|error|info|printf)\b/.test(t)) return; // a MESSAGE, not a call
      // THE PROSE EXEMPTION IS GONE. It was the reason this sweep reported the class closed
      // while the engine's own NON-NEGOTIABLE contract told every agent, every turn:
      //   "Do NOT run compilers (tsc), test suites (vitest/jest/npm test), or linters."
      // A rule that names a stack is a stack fact whether it is executed or merely stated —
      // it is shipped to the model either way, and cannot be changed per project.
      if (BINARIES.some((re) => re.test(l))) out.push(`${file}:${i + 1}  ${t.slice(0, 90)}`);
    });
  }
  return out;
}

describe('the sweep can actually see invocations — otherwise it passes vacuously', () => {
  it('its own pattern matches a known-bad line', () => {
    const bad = 'cd "$PROJECT_ROOT" && ./node_modules/.bin/tsc --noEmit';
    expect(/node_modules\/\.bin\/tsc/.test(bad)).toBe(true);
  });

  it('there are engine scripts to scan', () => {
    expect(engineScripts().length).toBeGreaterThan(5);
  });
});

describe('THE DEFECT CLASS: no engine script invokes a stack-specific checker', () => {
  it('verification goes through the project-declared command only', () => {
    expect(
      invocationSites(),
      'these run a checker the engine names. Verification is a PROJECT fact — route it through ' +
      '_run_project_verification / the verification plugin, which reads .epam/verification.json',
    ).toEqual([]);
  });
});

describe('the replacement is actually wired', () => {
  const helperUsers = () => engineScripts()
    .filter(({ lines }) => lines.some((l) => l.includes('_run_project_verification')))
    .map(({ file }) => file);

  it('the shared helper is used by the scripts that used to call the binary directly', () => {
    const users = helperUsers();
    for (const expected of ['claude.sh', 'run-agent-orchestration.sh', 'merge-worktree.sh',
                            'brownfield-repro-test-writer.sh']) {
      expect(
        users.some((u) => u.endsWith(expected)),
        `${expected} no longer calls a checker and does not call the helper either — did the ` +
        'verification get dropped rather than migrated?',
      ).toBe(true);
    }
  });

  it('the plugin exists and is registered for the project', () => {
    expect(existsSync(join(ROOT, 'orchestrations/plugins/verification-plugin.js'))).toBe(true);
    const reg = JSON.parse(readFileSync(
      join(ROOT, 'orchestrations/projects/metrolinx/plugins.json'), 'utf8'));
    expect(
      (reg.tools as string[]).some((t) => t.endsWith('verification-plugin.js')),
      'the plugin is not registered, so no agent can call verify_typecheck',
    ).toBe(true);
  });

  it('the manifest is generated at provisioning time, per codeline', () => {
    const gitOps = readFileSync(join(SCRIPTS, 'lib/git-ops.sh'), 'utf8');
    expect(gitOps).toContain('_epam_write_verification_manifest');
    expect(
      gitOps.indexOf('_epam_write_verification_manifest "${_project_root}"'),
      'generation is defined but never called from provisioning',
    ).toBeGreaterThan(-1);
  });

  it('generation asks the plugin rather than reimplementing detection', () => {
    const gitOps = readFileSync(join(SCRIPTS, 'lib/git-ops.sh'), 'utf8');
    const i = gitOps.indexOf('_epam_write_verification_manifest() {');
    expect(gitOps.slice(i, i + 1200)).toContain('detectVerification');
  });
});

describe('the reset no longer consults a compiler at all', () => {
  it('_selective_worktree_reset decides from the SPEC, not from a build', () => {
    const src = readFileSync(join(SCRIPTS, 'claude.sh'), 'utf8');
    const i = src.indexOf('_selective_worktree_reset() {');
    const body = src.slice(i, src.indexOf('\n}\n', i));
    expect(
      body,
      'the keep/discard decision is back on a compile result — for a multi-file feature that is ' +
      'the INVERSE signal, and it destroyed 25 file writes',
    ).not.toContain('run_tsc_verification');
    expect(body).toContain('fixSiteAnalysis');
  });
});
