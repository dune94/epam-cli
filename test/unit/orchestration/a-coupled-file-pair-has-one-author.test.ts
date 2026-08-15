/**
 * A COUPLED FILE PAIR HAS ONE AUTHOR.
 *
 * Live failure, run 20260814T213253Z (metrolinx, AMSD-2041). The writer finished:
 * `npm run test` passed, `tsc` passed, the story was marked completed and 4 files
 * were committed. The team-lead review then blocked it — and cleared the feature
 * explicitly ("the core Live Preview wiring ... is sound"). The single blocking
 * finding was:
 *
 *   "the lockfile declares a root lodash-es dependency that package.json does not
 *    contain, which will break `npm ci`"
 *
 * The cause is visible in the run's own rung attribution:
 *
 *   Rung 2 (moonshotai/kimi-k3):  package-lock.json
 *   Rung 4 (z-ai/glm-5.2):        package.json
 *
 * Two halves of one atomic unit, authored by two DIFFERENT MODELS on two different
 * rungs, neither seeing the other's edit. No writer skill prevents this: the ladder
 * handed the pair to two authors. The rejection then hard-reset the branch to
 * origin/develop, destroying work that had passed its gates.
 *
 * The contrast proves it is the split, not the agent: gotransit ran the SAME ticket
 * with the SAME agent on 2026-08-13 and succeeded. Its diff touched package.json
 * (+1 line) and never touched the lockfile — one member, one author, nothing to
 * reject.
 *
 * SCOPE, deliberately narrow. The invariant asserted here is ONE AUTHOR PER PAIR:
 * if two members of a declared pair both appear in the final diff, the SAME rung
 * must own both. It is NOT asserted that touching one member obliges touching the
 * other — gotransit's accepted run did exactly that, and a gate that failed it
 * would contradict known-good history.
 *
 * The pairs are a PROJECT fact, declared in the codeline's own dependency-check
 * manifest. No filename appears in the gate.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GATE = join(__dirname, '../../../orchestrations/scripts/lib/coupled-pair-gate.sh');

/** Run the real gate function against fixture files. */
function runGate(report: unknown, manifest: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'coupled-pair-'));
  try {
    const reportFile = join(dir, 'report.json');
    const manifestFile = join(dir, 'dependency-check.json');
    writeFileSync(reportFile, JSON.stringify(report));
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const res = spawnSync(
      'bash',
      ['-c', `. "${GATE}"; coupled_pair_check "${reportFile}" "${manifestFile}"`],
      { encoding: 'utf8' },
    );
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The declaration under test — a project fact, not engine knowledge. */
const MANIFEST = { coupledFilePairs: [['package.json', 'package-lock.json']] };

describe('a coupled file pair has one author', () => {
  it('FAILS when two rungs each wrote one half — the live AMSD-2041 shape', () => {
    const res = runGate(
      [
        { rung: '2', model: 'moonshotai/kimi-k3', files: ['package-lock.json'] },
        { rung: '4', model: 'z-ai/glm-5.2', files: ['package.json'] },
      ],
      MANIFEST,
    );

    expect(res.status).not.toBe(0);
    // Names both halves, both rungs and both models — a bare "violation" is not actionable.
    expect(res.stdout + res.stderr).toContain('package.json');
    expect(res.stdout + res.stderr).toContain('package-lock.json');
    expect(res.stdout + res.stderr).toContain('2');
    expect(res.stdout + res.stderr).toContain('4');
  });

  it('PASSES when one rung wrote both halves', () => {
    const res = runGate(
      [{ rung: '4', model: 'z-ai/glm-5.2', files: ['package.json', 'package-lock.json'] }],
      MANIFEST,
    );
    expect(res.status).toBe(0);
  });

  it('PASSES when only one member was touched — the accepted gotransit shape', () => {
    const res = runGate(
      [{ rung: '3', model: 'z-ai/glm-5.2', files: ['package.json', 'src/services/contentstack.ts'] }],
      MANIFEST,
    );
    expect(res.status).toBe(0);
  });

  it('is not vacuous — an undeclared pair cannot be flagged, and says so', () => {
    // Same split, but the project declares no pairs. Absent is UNKNOWN, never "none":
    // the gate must not silently pass as though it had checked something.
    const res = runGate(
      [
        { rung: '2', model: 'moonshotai/kimi-k3', files: ['package-lock.json'] },
        { rung: '4', model: 'z-ai/glm-5.2', files: ['package.json'] },
      ],
      {},
    );
    expect(res.status).toBe(0);
    expect(res.stdout + res.stderr).toMatch(/coupledFilePairs/);
  });

  it('the gate names no file of its own — every pair comes from the declaration', () => {
    const gateSrc = readFileSync(GATE, 'utf8');
    // Strip the docstring: the live failure it documents necessarily names the files.
    const code = gateSrc.replace(/^#.*$/gm, '');
    expect(code).not.toContain('package.json');
    expect(code).not.toContain('package-lock.json');
    expect(code).toContain('coupledFilePairs');
  });

  it('holds for any declared pair — the gate contains no filename of its own', () => {
    const res = runGate(
      [
        { rung: '1', model: 'model-a', files: ['Gemfile'] },
        { rung: '2', model: 'model-b', files: ['Gemfile.lock'] },
      ],
      { coupledFilePairs: [['Gemfile', 'Gemfile.lock']] },
    );
    expect(res.status).not.toBe(0);
    expect(res.stdout + res.stderr).toContain('Gemfile.lock');
  });
});

/**
 * THE RECEIVER, NOT THE CALLER. The gate passing its own unit tests proves nothing about
 * the run: what matters is that claude.sh's success path actually executes it and turns a
 * violation into a retry the writer can act on. This extracts the REAL wiring function
 * from claude.sh and runs it against fixtures — a stub would pass a source-text check
 * while the live path did nothing.
 */
describe('claude.sh feeds a split pair back to the writer', () => {
  const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');

  /** Extract the wiring function verbatim and execute it with the real gate library. */
  function runWiring(reportFiles: Array<{ rung: string; model: string; files: string[] }>) {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const start = src.indexOf('_coupled_pair_gate_for_story() {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}\n', start);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end + 3);

    const dir = mkdtempSync(join(tmpdir(), 'coupled-wiring-'));
    try {
      const logDir = join(dir, 'logs');
      const projectRoot = join(dir, 'repo');
      const epam = join(projectRoot, '.epam');
      mkdirSync(logDir, { recursive: true });
      mkdirSync(epam, { recursive: true });
      writeFileSync(
        join(logDir, 'rung-contribution-report-AMSD-2041.json'),
        JSON.stringify(reportFiles),
      );
      writeFileSync(
        join(epam, 'dependency-check.json'),
        JSON.stringify({ coupledFilePairs: [['package.json', 'package-lock.json']] }),
      );

      const script = `
        set -uo pipefail
        SCRIPT_DIR="${join(__dirname, '../../../orchestrations/scripts')}"
        LOG_DIR="${logDir}"
        PROJECT_ROOT="${projectRoot}"
        EPAM_BROWNFIELD=1
        VERIFICATION_FAILURE=""
        log()     { echo "$*"; }
        error()   { echo "ERROR: $*"; }
        ${fn}
        _coupled_pair_gate_for_story "AMSD-2041" "${join(dir, 'out.txt')}"
        rc=$?
        echo "RC=$rc"
        echo "VF_SET=\${VERIFICATION_FAILURE:+yes}"
        echo "VF=$VERIFICATION_FAILURE"
      `;
      const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      return (res.stdout || '') + (res.stderr || '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('turns a split pair into a retry with writer-actionable guidance', () => {
    const out = runWiring([
      { rung: '2', model: 'moonshotai/kimi-k3', files: ['package-lock.json'] },
      { rung: '4', model: 'z-ai/glm-5.2', files: ['package.json'] },
    ]);

    expect(out).toContain('RC=1');
    expect(out).toContain('VF_SET=yes');
    // The writer must be told to rewrite the pair TOGETHER — naming the violation is not enough.
    expect(out).toMatch(/Verification Failure/);
    expect(out).toMatch(/together/i);
    expect(out).toContain('package-lock.json');
  });

  it('passes the story through untouched when one rung owns both', () => {
    const out = runWiring([
      { rung: '4', model: 'z-ai/glm-5.2', files: ['package.json', 'package-lock.json'] },
    ]);
    expect(out).toContain('RC=0');
    expect(out).toContain('VF_SET=');
    expect(out).not.toContain('VF_SET=yes');
  });
});
