/**
 * THE PIPELINE NEVER LOOPS — A SELF-HEALING RETRY THAT CHANGED NOTHING IS NOT REPEATED, AT EVERY RETRY SITE.
 *
 * AMSD-2974 live run L2 (2026-10-14): the 7.x line's mutant-hunter gate failed; gate self-heal added criteria and
 * returned "remediated, retry" (exit 2); the retry re-ran the code writer, which committed nothing ("not my part this
 * turn; it belongs to the test-writer"); the same code failed the same gate; again — five rounds, ~$2.50 each, killed.
 * Operator: "pipeline should NEVER get into a loop!!!"
 *
 * EXECUTED, at all four retry sites — the launcher's run_phase (orchestrate.sh), the release-line loop
 * (lib/release-lines.sh) and both lane loops (lib/codeline-lanes.sh), each its real source — with a stand-in phase that
 * always answers exit 2, on a real git repository:
 *   - committing nothing: exactly one retry, then the site fails;
 *   - NEGATIVE: committing every round, then answering 0: the site keeps retrying and succeeds.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
const LOGS = 'log(){ echo "LOG $*"; }; info(){ echo "INFO $*"; }; warning(){ echo "WARN $*"; }; error(){ echo "ERR $*"; }; success(){ echo "OK $*"; }; fail(){ echo "FAIL $*"; exit 1; }';

/** A repository and a stand-in phase: answers exits[i] on call i; commits on every call when `commits`. */
function estate(exits: number[], commits: boolean) {
  const d = mkdtempSync(join(tmpdir(), 'never-loops-'));
  const repo = join(d, 'repo'); mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  writeFileSync(join(repo, 'f.txt'), '0\n'); git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  const n = join(d, 'n'); writeFileSync(n, '0');
  const phase = join(d, 'phase.sh');
  writeFileSync(phase, `#!/bin/bash
i=$(cat ${JSON.stringify(n)}); echo $((i+1)) > ${JSON.stringify(n)}
${commits ? `echo "$i" > ${JSON.stringify(join(repo, 'f.txt'))}; git -C ${JSON.stringify(repo)} -c user.email=t@t -c user.name=t commit -qam "round $i"` : ''}
codes=(${exits.join(' ')}); exit \${codes[$i]:-\${codes[\${#codes[@]}-1]}}
`);
  chmodSync(phase, 0o755);
  const calls = () => Number(readFileSync(n, 'utf8').trim());
  return { d, repo, phase, calls };
}

/** The lines from `while phase_exit_is_retryable "$<var>"` through its `done`, the nth such loop in the file. */
function loopSlice(file: string, nth: number) {
  const lines = readFileSync(join(S, file), 'utf8').split('\n');
  const starts = lines.map((l, i) => (/^\s*while phase_exit_is_retryable /.test(l) ? i : -1)).filter((i) => i >= 0);
  const s = starts[nth]; if (s === undefined) throw new Error(`retry loop ${nth} not found in ${file} — the harness is stale`);
  const indent = lines[s].match(/^\s*/)![0];
  const e = lines.findIndex((l, i) => i > s && l === `${indent}done`);
  return lines.slice(s, e + 1).join('\n');
}

describe('the pipeline never loops', () => {
  describe('the launcher (orchestrate.sh run_phase)', () => {
    const run = (exits: number[], commits: boolean) => {
      const e = estate(exits, commits);
      const scripts = join(e.d, 'scripts'); mkdirSync(join(scripts, 'lib'), { recursive: true });
      writeFileSync(join(scripts, 'run-agent-orchestration.sh'), `#!/bin/bash\nexec ${JSON.stringify(e.phase)}\n`);
      const prd = join(e.d, 'prd.json'); writeFileSync(prd, JSON.stringify({ project: { outputDir: e.repo } }));
      const src = readFileSync(join(S, 'orchestrate.sh'), 'utf8');
      const a = src.indexOf('run_phase() {'); const fn = src.slice(a, src.indexOf('\n}\n', a) + 3);
      // The launcher's own shell options (orchestrate.sh: set -euo pipefail) — its exit capture through `| tee` relies on pipefail.
      const r = spawnSync('bash', ['-c', `set -uo pipefail\n${LOGS}\nSCRIPT_DIR=${JSON.stringify(scripts)}; REPO_ROOT=${JSON.stringify(e.d)}; PRD_FILE=${JSON.stringify(prd)}; LOG_FILE=/dev/null; EPAM_BROWNFIELD=1\n. ${JSON.stringify(join(S, 'lib/phase-exit.sh'))}\n${fn}\nrun_phase core; echo "RC=$?"`], { encoding: 'utf8', timeout: 60000 });
      return { out: r.stdout + r.stderr, calls: e.calls() };
    };
    it('a retry that committed nothing is not repeated — two calls, then the phase fails', () => {
      const r = run([2], false);
      expect(r.calls, r.out).toBe(2);
      expect(r.out).toMatch(/FAIL|RC=1/);
    });
    it('NEGATIVE: a retry that commits keeps going until the gates pass', () => {
      const r = run([2, 2, 0], true);
      expect(r.calls, r.out).toBe(3);
      expect(r.out).toContain('Self-healing retry succeeded');
    });
  });

  describe('a release line (lib/release-lines.sh)', () => {
    const run = (exits: number[], commits: boolean) => {
      const e = estate(exits, commits);
      const loop = loopSlice('lib/release-lines.sh', 0);
      const r = spawnSync('bash', ['-c', `${LOGS}\n. ${JSON.stringify(join(S, 'lib/phase-exit.sh'))}\nf(){ _wt=${JSON.stringify(e.repo)}; _phase=core; _cl=lib; _line=1.x; _line_phase(){ ${JSON.stringify(e.phase)}; }; _pex=0; _line_phase || _pex=$?\n${loop}\necho "PEX=$_pex"; }; f`], { encoding: 'utf8', timeout: 60000 });
      return { out: r.stdout + r.stderr, calls: e.calls(), pex: Number((r.stdout.match(/PEX=(\d+)/) || [])[1]) };
    };
    it('a retry that committed nothing is not repeated — two calls, the line fails', () => {
      const r = run([2], false);
      expect(r.calls, r.out).toBe(2);
      expect(r.pex).not.toBe(0);
      expect(r.out).toContain('changed nothing in the codeline');
    });
    it('NEGATIVE: a retry that commits keeps going until the gates pass', () => {
      const r = run([2, 2, 0], true);
      expect(r.calls, r.out).toBe(3);
      expect(r.pex).toBe(0);
    });
  });

  for (const nth of [0, 1]) {
    describe(`a lane (lib/codeline-lanes.sh, retry loop ${nth + 1})`, () => {
      const run = (exits: number[], commits: boolean) => {
        const e = estate(exits, commits);
        const loop = loopSlice('lib/codeline-lanes.sh', nth);
        // The loop re-invokes the phase as `bash "$0" --reset`: $0 is the stand-in.
        const r = spawnSync('bash', ['-c', `${LOGS}\n. ${JSON.stringify(join(S, 'lib/phase-exit.sh'))}\n_wt=${JSON.stringify(e.repo)}; _phase=core; _cl=lib; _lane_log_dir=${JSON.stringify(e.d)}; _cl_prd=/dev/null; _log_file=/dev/null\nbash "$0"; _pex=$?\n${loop}\necho "PEX=$_pex"`, e.phase], { encoding: 'utf8', timeout: 60000 });
        return { out: r.stdout + r.stderr, calls: e.calls(), pex: Number((r.stdout.match(/PEX=(\d+)/) || [])[1]) };
      };
      it('a retry that committed nothing is not repeated — two calls, the lane fails', () => {
        const r = run([2], false);
        expect(r.calls, r.out).toBe(2);
        expect(r.pex).not.toBe(0);
        expect(r.out).toContain('changed nothing in the codeline');
      });
      it('NEGATIVE: a retry that commits keeps going until the gates pass', () => {
        const r = run([2, 2, 0], true);
        expect(r.calls, r.out).toBe(3);
        expect(r.pex).toBe(0);
      });
    });
  }
});
