/**
 * A GATE FINDING THAT ONLY A TEST CAN RESOLVE REACHES THE AGENT THAT OWNS THE TESTS — AND PRODUCES A TEST COMMIT.
 *
 * AMSD-2974 live run L2 (2026-10-14): the 7.x line's mutant-hunter found mutations that survive because the test's mock
 * returned top === bottom — the code was right, the test could not tell a mutant from it. Gate self-heal sent every
 * finding to story-ac-remediator and back to the CODE writer, who is forbidden to touch tests; it committed nothing,
 * the same code failed the same gate, five rounds, killed.
 *
 * Now the gate-finding-analyst judges `work`. EXECUTED, the real code throughout, only the model stood in:
 *   - the remediation block of run_testing_gates (lib/gates-testing.sh), on a real git codeline, with the REAL
 *     brownfield-repro-test-writer.sh behind it: a `tests` finding → the test-writer strengthens the change's test and
 *     COMMITS it, the remediator is never asked, the block returns PHASE_EXIT_TESTS_STRENGTHENED (4);
 *   - NEGATIVE: a `code` finding → story-ac-remediator, exit 2, no test commit (the route as it was);
 *   - NEGATIVE: greenfield, where the implementer owns its tests → the code route even for `tests`;
 *   - the writer's own contract: an unchanged test is a FAILED attempt (with the reason fed back), an unparseable rewrite
 *     restores the committed test instead of deleting it, and with no finding a change that carries a test is left alone.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintProjectPrompts } from '../../helpers/project-prompts';
import { shellFunction } from '../../lib/engine-source';

const S = join(__dirname, '../../../orchestrations/scripts');
const WRITER = join(S, 'brownfield-repro-test-writer.sh');
const CANONICAL = join(__dirname, '../../../orchestrations/agents/profiles.canonical.json');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (repo: string, a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

const TEST_REL = 'src/svc/discount.spec.ts';
const ORIGINAL_TEST = `import { it, expect } from 'vitest';\nimport { match } from './discount';\nit('matches', () => expect(match('a#1','a')).toBe(true));\n`;
const FINDING = {
  gate: 'mutant-hunter', story_id: 'AMSD-1820', file: 'src/svc/discount.ts', line: 1, rule: 'mutation-survived',
  message: 'MUTANT_MARKER — split("#")[0] → split("#")[1] survives: no case has a suffix that differs',
  suggested_fix: 'Add a case where the part after # differs from the part before it',
};

/** develop baseline; a story branch carrying the fix AND its test (the test-writer's earlier commit). */
function makeEstate() {
  const d = mkdtempSync(join(tmpdir(), 'gate-finding-tw-')); dirs.push(d);
  const repo = join(d, 'repo'); mkdirSync(join(repo, 'src', 'svc'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'develop']);
  git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'src/svc/discount.ts'), 'export const match = (a:string,b:string)=>a===b;\n');
  writeFileSync(join(repo, 'src/svc/other.spec.ts'), `import { it, expect } from 'vitest';\nit('x', () => expect(1).toBe(1));\n`);
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'baseline']);
  git(repo, ['checkout', '-q', '-b', 'AI-AMSD-1820']);
  writeFileSync(join(repo, 'src/svc/discount.ts'), 'export const match=(a:string,b:string)=>a.split("#")[0]===b;\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'AMSD-1820: story complete (1 file(s))']);
  writeFileSync(join(repo, TEST_REL), ORIGINAL_TEST);
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'AMSD-1820: add bug-reproducing test']);
  // The project's test runner, answering as vitest does: a SYNTAX_BROKEN file does not transform.
  mkdirSync(join(repo, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(repo, 'node_modules/.bin/vitest'), `#!/usr/bin/env bash
for f in "$@"; do [ -f "$PWD/$f" ] && grep -q SYNTAX_BROKEN "$PWD/$f" && { echo "Error: Transform failed with 1 error:"; echo " Tests  no tests"; exit 1; }; done
echo " Test Files  1 passed (1)"; echo "      Tests  2 passed (2)"; exit 0
`);
  chmodSync(join(repo, 'node_modules/.bin/vitest'), 0o755);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  const logs = join(d, 'logs'); mkdirSync(logs);
  const gateLog = join(logs, 'mutant-hunter-core.log');
  writeFileSync(gateLog, JSON.stringify({ agent: 'mutant-hunter', summary: { mutationScore: 17 }, mutations: [{ file: FINDING.file, line: 1, status: 'survived', relatedTest: 'GATE_EVIDENCE_MARKER' }] }));
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ project: { outputDir: repo }, implementationOrder: { core: ['AMSD-1820'] },
    stories: [{ id: 'AMSD-1820', status: 'completed', storyKind: 'defect', agentRole: 'typescript-engineer', acceptanceCriteria: ['a'], verificationCriteria: ['match ignores the suffix'] }] }));
  const agents = join(d, 'agents'); mkdirSync(agents);
  writeFileSync(join(agents, 'profiles.json'), readFileSync(CANONICAL, 'utf8'));
  return { d, repo, logs, gateLog, prd, agents, prompts: join(d, 'prompts') };
}

/**
 * The model, stood in. Every prompt is kept (prompts/<agent>-<n>.txt) — the artefact the tests read. The analyst
 * answers with the L2 shape and STUB_WORK; the test-writer acts per STUB_TEST: strengthen | same | broken | none.
 */
function stubModel(e: ReturnType<typeof makeEstate>) {
  mkdirSync(e.prompts, { recursive: true });
  const p = join(e.d, 'stub-model.sh');
  writeFileSync(p, `#!/usr/bin/env bash
a="\${EPAM_AGENT_NAME:-unknown}"; n=$(ls ${JSON.stringify(e.prompts)} | grep -c "^$a-" || true)
cat > ${JSON.stringify(e.prompts)}/"$a-$n.txt"
case "$a" in
  gate-finding-analyst) printf 'Verbatim: "status": "survived"\\n\`\`\`json\\n%s\\n\`\`\`\\n' "$STUB_FINDING" ;;
  story-ac-remediator)  printf '{"story_id":"AMSD-1820","acs_added":1,"acs":["MUST NOT read only the part before #"]}\\n' ;;
  profile-augmentor)    printf '{"profile_updated": false}\\n' ;;
  prd-change-reviewer)  printf '{"verdict":"pass","issues":[]}\\n' ;;
  repro-test-writer)
    [ -n "\${EPAM_ALLOWED_WRITE_PATHS:-}" ] || { echo "corrective"; exit 0; }
    t="$PROJECT_ROOT/$EPAM_ALLOWED_WRITE_PATHS"
    case "\${STUB_TEST:-none}" in
      strengthen) printf "%s" "$(cat "$t")" > "$t.new"; printf "\\nit('suffix differs', () => expect(match('a#2','a')).toBe(true));\\n" >> "$t.new"; mv "$t.new" "$t" ;;
      same)       cp "$t" "$t.new"; sleep 1; mv "$t.new" "$t" ;;
      broken)     printf "// SYNTAX_BROKEN\\nconst x = {,\\n" > "$t" ;;
      none)       : ;;
    esac ;;
  *) echo "corrective" ;;
esac
`);
  chmodSync(p, 0o755);
  return p;
}

function env(e: ReturnType<typeof makeEstate>, work: string, extra: Record<string, string> = {}) {
  return {
    ...process.env, EPAM_PROJECT_CONFIG_DIR: mintProjectPrompts(), PROJECT_ROOT: e.repo, PRD_FILE: e.prd, LOG_DIR: e.logs,
    JIRA_BASELINE_BRANCH: 'develop', EPAM_BROWNFIELD: '1', AI_RUNNER_CMD: stubModel(e), EPAM_AGENTS_DIR: e.agents,
    REPRO_TEST_WRITER_MAX_ATTEMPTS: '2', EPAM_TEST_TARGET_ASK: '0',
    STUB_FINDING: JSON.stringify({ ...FINDING, work }), ...extra,
  } as Record<string, string>;
}

const promptsOf = (e: ReturnType<typeof makeEstate>, agent: string) =>
  existsSync(e.prompts) ? readdirSync(e.prompts).filter((f) => f.startsWith(`${agent}-`)).sort().map((f) => readFileSync(join(e.prompts, f), 'utf8')) : [];

// ── The remediation block of run_testing_gates, executed ─────────────────────────────────────────────────────────
const GT = readFileSync(join(S, 'lib/gates-testing.sh'), 'utf8');
const REMEDIATION = (() => {
  // From just after the gates' monitor event — everything that decides what the gates' findings become.
  const ev = GT.indexOf('"Testing gates $verdict for $phase_id (${duration_ms}ms)"');
  const a = GT.indexOf('\n', ev) + 1;
  const b = GT.indexOf('\n    success "Step 4.2: Testing gates PASSED"\n    return 0\n}') + 1;
  if (a < 0 || b < 0 || b < a) throw new Error('the remediation block of run_testing_gates was not found — the harness is stale');
  return GT.slice(a, b);
})();

function remediate(work: string, extra: Record<string, string> = {}, e = makeEstate()) {
  const fns = [shellFunction(join(S, 'lib/gates-testing.sh'), '_gate_attribute_from_log'), shellFunction(join(S, 'lib/repro-baseline.sh'), 'repro_writer_baseline')].join('\n');
  const script = [
    // The orchestrator's own shell options: set -e, no pipefail, no -u (run-agent-orchestration.sh:75). set -e is what
    // turns the gates' return into the phase's exit, so the block runs under it, in a subshell.
    `SCRIPT_DIR=${JSON.stringify(S)}; AUTOMATION_DIR=${JSON.stringify(join(S, '..'))}; NODE_BIN=${JSON.stringify(process.execPath)}; CLAUDE_CMD=claude; ORCH_GATE_PROVIDER=stub`,
    'info(){ echo "INFO $*"; }; warning(){ echo "WARN $*"; }; error(){ echo "ERR $*"; }; success(){ echo "OK $*"; }; log(){ echo "LOG $*"; }',
    `. ${JSON.stringify(join(S, 'lib/flags.sh'))}; . ${JSON.stringify(join(S, 'lib/jq-vals.sh'))}; . ${JSON.stringify(join(S, 'lib/render-engine-prompt.sh'))}; . ${JSON.stringify(join(S, 'lib/phase-exit.sh'))}; . ${JSON.stringify(join(S, 'lib/reviewed-acs.sh'))}`,
    'seam_model_or_fail(){ echo stub-model; }',
    fns,
    // A failing gate (failed=1, its log in _failing_logs) or, with WARN=1, a gate that only warned.
    'rem() { local phase_id=core sast_exit=0 spec_exit=0 review_exit=0 mutant_exit=0 fuzz_exit=0 perf_exit=0; local failed=1 _failing_logs=("$GATE_LOG") _log_labels=(mutant-hunter) _warn_logs=() _warn_labels=(); if [ "${WARN:-0}" = 1 ]; then failed=0; _failing_logs=(); _log_labels=(); _warn_logs=("$GATE_LOG"); _warn_labels=(mutant-hunter); fi; local _profiles_file="$EPAM_AGENTS_DIR/profiles.json";',
    REMEDIATION,
    'return 0; }',
    '( set -e; rem ); echo "RC=$?"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 120000, env: { ...env(e, work, extra), GATE_LOG: e.gateLog, STUB_TEST: 'strengthen' } });
  const out = `${r.stdout}${r.stderr}`;
  return { e, out, rc: Number((out.match(/^RC=(\d+)$/m) || [])[1]), log: git(e.repo, ['log', '--format=%s', 'develop..HEAD']) };
}

describe('a gate finding that only a test can resolve reaches the test-writer', () => {
  it('`tests` (brownfield): the test-writer commits the strengthened test; the remediator is never asked; exit 4', () => {
    const r = remediate('tests');
    expect(r.rc, r.out).toBe(4);
    expect(r.log, r.out).toContain('AMSD-1820: add strengthened test for the mutant-hunter finding');
    // The effect, on disk: the change's own test, with its original case AND the new one.
    const t = readFileSync(join(r.e.repo, TEST_REL), 'utf8');
    expect(t).toContain(ORIGINAL_TEST.trim());
    expect(t).toContain('suffix differs');
    expect(git(r.e.repo, ['show', '--name-only', '--format=', 'HEAD']).trim()).toBe(TEST_REL);
    // The writer was briefed with the finding and the gate's own report — the artefact, not the wiring.
    const wp = promptsOf(r.e, 'repro-test-writer').filter((p) => p.includes('A QUALITY GATE FOUND THE TEST INSUFFICIENT'));
    expect(wp.length, r.out).toBe(1);
    expect(wp[0]).toContain('MUTANT_MARKER');
    expect(wp[0]).toContain('GATE_EVIDENCE_MARKER');
    expect(wp[0]).toContain(TEST_REL);
    expect(promptsOf(r.e, 'story-ac-remediator')).toHaveLength(0);
    expect(promptsOf(r.e, 'profile-augmentor')).toHaveLength(0);
  });

  it('the analyst is asked who can resolve the finding', () => {
    const r = remediate('tests');
    const ap = promptsOf(r.e, 'gate-finding-analyst');
    expect(ap.length).toBeGreaterThan(0);
    expect(ap[0]).toContain('"work"');
    expect(ap[0]).toContain('"tests"');
  });

  it('NEGATIVE: `code` → the remediator, exit 2, no test commit', () => {
    const r = remediate('code');
    expect(r.rc, r.out).toBe(2);
    expect(promptsOf(r.e, 'story-ac-remediator').length, r.out).toBeGreaterThan(0);
    expect(promptsOf(r.e, 'repro-test-writer')).toHaveLength(0);
    expect(r.log).not.toContain('strengthened test');
  });

  it('NEGATIVE: greenfield — the implementer owns its tests, so a `tests` finding takes the code route', () => {
    const r = remediate('tests', { EPAM_BROWNFIELD: '0' });
    expect(r.rc, r.out).toBe(2);
    expect(promptsOf(r.e, 'repro-test-writer')).toHaveLength(0);
  });

  it('a gate that only WARNED: its finding is used — routed to the test-writer, which commits; exit 4', () => {
    const r = remediate('tests', { WARN: '1', ORCH_RUN_ID: 'run-w' });
    expect(r.rc, r.out).toBe(4);
    expect(r.log).toContain('AMSD-1820: add strengthened test for the mutant-hunter finding');
  });

  it('a warning raised again in a later round is acted on again — no counter decides, the agents do', () => {
    // The once-per-gate-per-run marker (4e6b490f6) was a guard the operator never approved: removed 2026-10-14.
    const first = remediate('tests', { WARN: '1', ORCH_RUN_ID: 'run-w' });
    expect(first.rc, first.out).toBe(4);
    const again = remediate('tests', { WARN: '1', ORCH_RUN_ID: 'run-w' }, first.e);
    expect(again.rc, again.out).toBe(4);
    expect(promptsOf(first.e, 'gate-finding-analyst')).toHaveLength(2);
  });

  it('the remediator is told what the codeline declares', () => {
    const r = remediate('code');
    const p = promptsOf(r.e, 'story-ac-remediator')[0];
    expect(p, r.out).toContain('"manifestFile"');
    expect(p).toContain('"declared"');
  });
});

describe('the test-writer, given a gate finding', () => {
  function write(mode: string, finding: boolean, pre?: (repo: string) => void) {
    const e = makeEstate();
    if (pre) pre(e.repo);
    const ff = join(e.logs, 'gate-finding-core-mutant-hunter.json');
    writeFileSync(ff, JSON.stringify({ ...FINDING, work: 'tests' }));
    const extra: Record<string, string> = { STUB_TEST: mode };
    if (finding) Object.assign(extra, { EPAM_TEST_FINDING_FILE: ff, EPAM_TEST_FINDING_GATE: 'mutant-hunter', EPAM_TEST_FINDING_LOG: e.gateLog });
    const r = spawnSync('bash', [WRITER, 'AMSD-1820'], { encoding: 'utf8', timeout: 120000, env: env(e, 'tests', extra) });
    return { e, out: `${r.stdout}${r.stderr}`, rc: r.status, log: git(e.repo, ['log', '--format=%s', 'develop..HEAD']) };
  }

  it('an unchanged test is a FAILED attempt: no commit, non-zero exit, and the next attempt is told why', () => {
    const r = write('same', true);
    expect(r.rc, r.out).not.toBe(0);
    expect(r.log).not.toContain('strengthened test');
    expect(r.out).toContain('class=unchanged');
    const wp = promptsOf(r.e, 'repro-test-writer').filter((p) => p.includes('A QUALITY GATE FOUND'));
    expect(wp.length, r.out).toBe(2);
    expect(wp[0]).not.toContain('LEFT THE TEST UNCHANGED');
    expect(wp[1]).toContain('LEFT THE TEST UNCHANGED');
  });

  it('an unparseable rewrite restores the committed test — it is never deleted', () => {
    const r = write('broken', true);
    expect(r.rc, r.out).not.toBe(0);
    expect(readFileSync(join(r.e.repo, TEST_REL), 'utf8')).toBe(ORIGINAL_TEST);
    expect(git(r.e.repo, ['status', '--porcelain', '--', TEST_REL]).trim()).toBe('');
  });

  it('the test-writer is told what the codeline declares — it may use only those packages', () => {
    // rv3 (live, 2026-10-14): asked for an accessibility scan, it imported a package the codeline does not declare.
    const r = write('strengthen', true, (repo) => {
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { 'declared-test-lib': '1.0.0' } }));
    });
    const wp = promptsOf(r.e, 'repro-test-writer').filter((p) => p.includes('A QUALITY GATE FOUND'));
    expect(wp.length, r.out).toBeGreaterThan(0);
    expect(wp[0]).toContain('declared-test-lib');
    expect(wp[0]).toContain('"manifestRead": true');
  });

  it('NEGATIVE: with no finding, a change that carries a test is left alone, as before', () => {
    const r = write('strengthen', false);
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain('a test already accompanies the change');
    expect(promptsOf(r.e, 'repro-test-writer')).toHaveLength(0);
    expect(readFileSync(join(r.e.repo, TEST_REL), 'utf8')).toBe(ORIGINAL_TEST);
  });
});
