/**
 * EVERY REVIEW FINDING REACHES THE AGENT THAT OWNS IT — AND THE REVIEW LOOP NEVER RE-REVIEWS UNCHANGED CODE.
 *
 * AMSD-2974 rehearsal rv2 (2026-10-14, live tokens): the 7.x reviewer found two planted gaps; the writer fixed both from
 * its findings (29d10d3). The review then carried one finding about the TESTS ("for the test-writer's separate review;
 * not charged to the implementer") — and, now that every finding is acted on, it went to the CODE writer, who may not
 * touch tests. The writer committed nothing and the unchanged code was reviewed again, twice, escalating to Opus/high.
 * Operator: "do 1, 2, and yes to 3":
 *   1. a finding goes to its owner — `work: "tests"` to the test-writer, `work: "code"` to the writer;
 *   2. a cycle that changed nothing is not reviewed again;
 *   3. a reviewer may retire a criterion the REMEDIATOR added (never one of the plan's) when it cannot be met.
 *
 * EXECUTED at £0, the real run_review_cycle (lib/review-cycle.sh), the real team-lead-review.sh and the real
 * brownfield-repro-test-writer.sh on a real git codeline; only the MODEL (a runner answering from a script and keeping
 * every prompt) and the WRITER (run_story_with_watchdog) are scripted.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mintProjectPrompts } from '../../helpers/project-prompts';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { if (!process.env.KEEP_FIXTURE) for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PLAN_AC = 'the discount matches regardless of suffix';
const REMEDIATION_AC = 'a.spec.ts must run an axe scan with jest-axe';
type Issue = Record<string, unknown>;

/**
 * answers[n-1] is the reviewer's answer on review n (the last repeats). writerCommits: whether the scripted writer
 * changes the code. The test-writer (the real script) is answered by the runner: it appends a case to its target.
 */
function runCycle(answers: Issue[][], writerCommits: boolean) {
  const d = mkdtempSync(join(tmpdir(), 'finding-owner-')); dirs.push(d);
  const logDir = join(d, 'logs'); mkdirSync(logDir);
  const proj = join(d, 'codeline'); mkdirSync(join(proj, 'pkg'), { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: proj, encoding: 'utf8' }).trim();
  writeFileSync(join(proj, 'README.md'), 'base\n'); git('init', '-q', '-b', 'develop'); git('add', '.'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'AI-S-A');   // the story's own branch; develop stays the baseline
  writeFileSync(join(proj, 'pkg/a.ts'), 'export const MARKER_A = 1;\n');
  writeFileSync(join(proj, 'pkg/a.spec.ts'), "import { it, expect } from 'vitest';\nit('a', () => expect(1).toBe(1));\n");
  git('add', '.'); git('commit', '-q', '-m', 'S-A: story complete (2 file(s))');
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), base + '\n');
  writeFileSync(join(logDir, 'story-changes.jsonl'), JSON.stringify({ storyId: 'S-A', sha: git('rev-parse', 'HEAD') }) + '\n');
  writeFileSync(join(logDir, 'phase-cost.jsonl'), JSON.stringify({ story_id: 'S-A', status: 'completed', resolvedModel: 'MiniMax-M3', effort: 'medium' }) + '\n');
  writeFileSync(join(logDir, 'agent-activity.jsonl'), JSON.stringify({ event: 'story_start', storyId: 'S-A', provider: 'minimax', model: 'MiniMax-M3' }) + '\n');
  mkdirSync(join(logDir, 'story-retry-state')); writeFileSync(join(logDir, 'story-retry-state/S-A.count'), '0');
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ project: { name: 'fixture', outputDir: proj }, implementationOrder: { core: ['S-A'] },
    stories: [{ id: 'S-A', jiraKey: 'S-A', title: 'S-A story', description: 'd', agentRole: 'engineer', status: 'completed', completed: true,
      codelines: ['codeline'], technicalNotes: { files: ['pkg/a.ts'] }, verificationCriteria: ['pkg/a.ts present'],
      // The remediator stamps what it adds (ac-apply.py); what the plan is otherwise comes from the plan of record
      // (the-plan-of-record-decides-what-the-plan-is.test.ts) — never from a criterion's shape.
      acceptanceCriteria: [PLAN_AC, { text: REMEDIATION_AC, status: 'pending', origin: 'remediation' }] }] }));

  const calls = join(d, 'calls'); mkdirSync(calls);
  const answersFile = join(d, 'answers.json');
  writeFileSync(answersFile, JSON.stringify(answers.map((issues) => (issues.length
    ? { verdict: 'changes_requested', issues, summary: 'fix' } : { verdict: 'approved', issues: [], summary: 'fine' }))));
  const runner = join(d, 'runner.sh');
  writeFileSync(runner, `#!/usr/bin/env bash
prompt=$(cat)
if [ -n "\${EPAM_ALLOWED_WRITE_PATHS:-}" ]; then   # the test-writer: strengthens its target
  n=$(ls "${calls}" | grep -c '^testwriter-' || true); printf '%s' "$prompt" > "${calls}/testwriter-$((n+1)).prompt"
  printf "\\nit('strengthened', () => expect(2).toBe(2));\\n" >> "$PROJECT_ROOT/$EPAM_ALLOWED_WRITE_PATHS"; exit 0
fi
if ! printf '%s' "$prompt" | grep -q 'S-A story'; then echo '{}'; exit 0; fi   # remediator / analysts: nothing
n=$(ls "${calls}" | grep -c '^review-' || true); n=$((n+1))
printf '%s' "$prompt" > "${calls}/review-$n.prompt"
answer=$(node -e 'const a=require(process.argv[1]); process.stdout.write(JSON.stringify(a[Math.min(+process.argv[2],a.length)-1]))' "${answersFile}" "$n")
esc=$(printf '%s' "$answer" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
[ -n "\${ORCH_JSON_RESULT:-}" ] && printf '{"result":"%s","cost_usd":0}' "$esc" > "$ORCH_JSON_RESULT"
printf '%s' "$answer"
`);
  chmodSync(runner, 0o755);

  const script = `
    set -uo pipefail
    SCRIPT_DIR="${SCRIPTS}"; AUTOMATION_DIR="${SCRIPTS}/.."; LOG_DIR="${logDir}"; PRD_FILE="${prd}"; MAIN_PRD_FILE="${prd}"
    PROJECT_ROOT="${proj}"; PHASE=core; export LOG_DIR PRD_FILE MAIN_PRD_FILE PROJECT_ROOT PHASE SCRIPT_DIR AUTOMATION_DIR
    export AI_RUNNER_CMD="${runner}" AUTO_APPROVE=true EPAM_PROJECT_CONFIG_DIR="${mintProjectPrompts()}"
    export EPAM_PROVIDER_SET=openrouter OPENROUTER_API_KEY=none MINIMAX_API_KEY=none REVIEW_LOG="${logDir}/code-reviews.jsonl"
    export EPAM_BROWNFIELD=1 JIRA_BASELINE_BRANCH=develop EPAM_TEST_TARGET_ASK=0 REPRO_TEST_WRITER_MAX_ATTEMPTS=1
    log(){ echo "LOG: $*"; }; warning(){ echo "WARN: $*"; }; error(){ echo "ERR: $*"; }; success(){ echo "OK: $*"; }; info(){ echo "INFO: $*"; }
    _emit_agent(){ :; }
    . "$SCRIPT_DIR/lib/story-retry-state.sh"; . "$SCRIPT_DIR/lib/phase-assessment.sh"; . "$SCRIPT_DIR/lib/review-cycle.sh"
    # THE SCRIPTED WRITER: keeps the feedback it was handed; commits a change to the code only when told to.
    run_story_with_watchdog(){
      n=$(ls "${d}" | grep -c '^writer-' || true); cp "$LOG_DIR/review-feedback-$1.json" "${d}/writer-$((n+1)).json" 2>/dev/null || echo '{}' > "${d}/writer-$((n+1)).json"
      ${writerCommits ? `sed -i "s/MARKER_A = [0-9]*/MARKER_A = $((n+2))/" "${proj}/pkg/a.ts"; git -C "${proj}" -c user.email=t@t -c user.name=t commit -qam "$1: story complete (1 file(s))"; echo "{\\"storyId\\":\\"$1\\",\\"sha\\":\\"$(git -C "${proj}" rev-parse HEAD)\\"}" >> "$LOG_DIR/story-changes.jsonl"` : ':'}
    }
    cd "${d}"
    run_review_cycle; echo "RC=$?"
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 240_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const read = (prefix: string) => readdirSync(calls).filter((f) => f.startsWith(prefix)).sort().map((f) => readFileSync(join(calls, f), 'utf8'));
  const writer = readdirSync(d).filter((f) => /^writer-\d+\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')));
  const acs = () => JSON.parse(readFileSync(prd, 'utf8')).stories[0].acceptanceCriteria;
  return { out, rc: /RC=(\d+)/.exec(out)?.[1], reviews: read('review-'), testWriter: read('testwriter-'), writer,
    log: git('log', '--format=%s', `${base}..HEAD`), acs };
}

const CODE = { severity: 'blocker', file: 'pkg/a.ts', line: 1, description: 'CODE_FINDING MARKER_A must change', work: 'code', evidence: 'pkg/a.ts:1' };
const TEST = { severity: 'minor', file: 'pkg/a.spec.ts', line: 2, description: 'TEST_FINDING the spec asserts nothing about MARKER_A', work: 'tests', evidence: 'pkg/a.spec.ts:2' };

describe('every review finding reaches its owner', () => {
  it('a code finding and a test finding: the writer gets ONLY the code one; the test-writer commits for the other; then approved', () => {
    const r = runCycle([[CODE, TEST], []], true);
    expect(r.rc, r.out.slice(-3000)).toBe('0');
    expect(r.writer.length, r.out.slice(-2000)).toBe(1);
    const handed = JSON.stringify(r.writer[0]);
    expect(handed).toContain('CODE_FINDING');
    expect(handed).not.toContain('TEST_FINDING');
    expect(r.testWriter.length, r.out.slice(-2000)).toBe(1);
    expect(r.testWriter[0]).toContain('TEST_FINDING');
    expect(r.log).toContain('S-A: add strengthened test for the team-lead-review finding');
  });

  it('only a test finding: the code writer is never invoked; the test-writer commits; then approved', () => {
    const r = runCycle([[TEST], []], true);
    expect(r.rc, r.out.slice(-3000)).toBe('0');
    expect(r.writer).toHaveLength(0);
    expect(r.log).toContain('S-A: add strengthened test for the team-lead-review finding');
    expect(r.reviews).toHaveLength(2);
  });
});

describe('the review loop never reviews unchanged code again', () => {
  it('the writer changed nothing: one review, one writer turn, then it stops — not reviewed again', () => {
    const r = runCycle([[CODE]], false);
    expect(r.rc, r.out.slice(-3000)).toBe('3');
    expect(r.reviews).toHaveLength(1);
    expect(r.writer).toHaveLength(1);
    expect(r.out).toContain('changed nothing');
  });

  it('NEGATIVE: a writer that commits keeps the loop going until the review is clean', () => {
    const r = runCycle([[CODE], [CODE], []], true);
    expect(r.rc, r.out.slice(-3000)).toBe('0');
    expect(r.reviews).toHaveLength(3);
  });
});

describe('a reviewer may retire a criterion the remediator added — never one of the plan\'s', () => {
  it('a remediation criterion named unsatisfiable is removed, nothing is handed to the writer, and the next review is clean', () => {
    const retire = { severity: 'minor', file: 'pkg/a.spec.ts', line: 1, description: 'jest-axe is not declared here', work: 'tests',
      evidence: 'package.json', retireCriterion: REMEDIATION_AC };
    const r = runCycle([[retire], []], true);
    expect(r.rc, r.out.slice(-3000)).toBe('0');
    const texts = r.acs().map((a: unknown) => (typeof a === 'string' ? a : (a as { text: string }).text));
    expect(texts).not.toContain(REMEDIATION_AC);
    expect(texts).toContain(PLAN_AC);
    expect(r.writer).toHaveLength(0);
    expect(r.testWriter).toHaveLength(0);
  });

  it('a criterion named exactly as the reviewer was shown it — with its remediation marker — is retired too', () => {
    // rv3 (live, 2026-10-14): the reviewer copied the criterion as listed, marker included; nothing matched.
    const retire = { severity: 'minor', file: 'pkg/a.spec.ts', line: 1, description: 'jest-axe is not declared here', work: 'tests',
      evidence: 'package.json', retireCriterion: `${REMEDIATION_AC}  [added by remediation — not the plan]` };
    const r = runCycle([[retire], []], true);
    const texts = r.acs().map((a: unknown) => (typeof a === 'string' ? a : (a as { text: string }).text));
    expect(texts, r.out.slice(-2000)).not.toContain(REMEDIATION_AC);
    expect(r.testWriter).toHaveLength(0);
  });

  it('a criterion named by the label the reviewer was shown — "AC2" or "AC2: <text>" — is retired too', () => {
    // rv4 (live, 2026-10-14): the reviewer named AC8/AC9 as "AC8: <text>"; nothing matched and they went to the test-writer.
    for (const name of ['AC2', `AC2: ${REMEDIATION_AC}`]) {
      const retire = { severity: 'minor', file: 'pkg/a.spec.ts', line: 1, description: 'cannot be met here', work: 'tests', evidence: 'package.json', retireCriterion: name };
      const r = runCycle([[retire], []], true);
      const texts = r.acs().map((a: unknown) => (typeof a === 'string' ? a : (a as { text: string }).text));
      expect(texts, `${name}: ${r.out.slice(-1500)}`).not.toContain(REMEDIATION_AC);
      expect(texts).toContain(PLAN_AC);
    }
  });

  it('NEGATIVE: a plan criterion named by its label ("AC1") stays', () => {
    const retire = { ...CODE, retireCriterion: 'AC1' };
    const r = runCycle([[retire], []], true);
    const texts = r.acs().map((a: unknown) => (typeof a === 'string' ? a : (a as { text: string }).text));
    expect(texts).toContain(PLAN_AC);
  });

  it('NEGATIVE: a PLAN criterion named for retirement stays — the finding goes to its owner instead', () => {
    const retire = { ...CODE, retireCriterion: PLAN_AC };
    const r = runCycle([[retire], []], true);
    const texts = r.acs().map((a: unknown) => (typeof a === 'string' ? a : (a as { text: string }).text));
    expect(texts).toContain(PLAN_AC);
    expect(r.writer).toHaveLength(1);
  });

  it('the reviewer is told which criteria the remediator added, and asked who owns each finding', () => {
    const r = runCycle([[]], true);
    expect(r.reviews.length, r.out.slice(-2000)).toBeGreaterThan(0);
    expect(r.reviews[0]).toMatch(new RegExp(`${REMEDIATION_AC}.*added by remediation`));
    expect(r.reviews[0]).not.toMatch(new RegExp(`${PLAN_AC}.*added by remediation`));
    expect(r.reviews[0]).toContain('"work"');
    expect(r.reviews[0]).toContain('"retireCriterion"');
  });
});
