/**
 * THE REVIEW CYCLE — REVIEW, FIX, RE-REVIEW — EXECUTED END TO END AT £0.
 *
 * Every paid regintel failure on 2026-09-21 lived in Step 3.6 and nowhere else, and Step 3.6 had
 * no test because it was 233 lines inside a 4,000-line script. It is now run_review_cycle
 * (lib/review-cycle.sh), and this drives it for real: the real loop, the real team-lead-review.sh,
 * the real feedback partition and ladder state, a real git codeline with one commit per story.
 * Only two things are scripted — the reviewer's MODEL (a runner that answers from a script and
 * records every prompt and cwd it saw) and the WRITER (run_story_with_watchdog, which edits the
 * story's file and commits, as the pipeline's writer would). Nothing is a hand-typed copy of the
 * engine.
 *
 * Cycle 1 answers: A rejected (a real finding), B unparseable (the `dict":"approved"` shape),
 * C approved. Cycle 2 answers: everything approved. What must be true, from the record:
 *   - each story's review prompt carried ITS OWN commit and no other story's (scoped review)
 *   - the reviewer ran inside the codeline (cwd), never the orchestrator's directory
 *   - only A was re-implemented; B's unparsed verdict was re-reviewed, never handed to the writer
 *   - only A's ladder advanced; B's and C's are untouched
 *   - the cycle ended APPROVED (return 0), in two cycles
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { if (!process.env.KEEP_FIXTURE) for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function runCycle() {
  const d = mkdtempSync(join(tmpdir(), 'review-cycle-')); dirs.push(d);
  const logDir = join(d, 'logs'); mkdirSync(logDir);
  const proj = join(d, 'codeline'); mkdirSync(join(proj, 'pkg'), { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: proj, encoding: 'utf8' }).trim();
  writeFileSync(join(proj, 'README.md'), 'base\n'); git('init', '-q', '-b', 'develop'); git('add', '.'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const shas: Record<string, string> = {};
  for (const [id, file, marker] of [['S-A', 'pkg/a.py', 'MARKER_A'], ['S-B', 'pkg/b.py', 'MARKER_B'], ['S-C', 'pkg/c.py', 'MARKER_C']]) {
    writeFileSync(join(proj, file), `${marker} = 1\n`); git('add', '.'); git('commit', '-q', '-m', `${id}: story complete (1 file(s))`);
    shas[id] = git('rev-parse', 'HEAD');
  }
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), base + '\n');
  writeFileSync(join(logDir, 'story-changes.jsonl'), Object.entries(shas).map(([id, sha]) => JSON.stringify({ storyId: id, sha })).join('\n') + '\n');
  // The run's own ledgers: completed attempts (rung derivation) and ladder state at rung 0.
  writeFileSync(join(logDir, 'phase-cost.jsonl'), ['S-A', 'S-B', 'S-C'].map(id => JSON.stringify({ story_id: id, status: 'completed', resolvedModel: 'MiniMax-M3', effort: 'medium' })).join('\n') + '\n');
  writeFileSync(join(logDir, 'agent-activity.jsonl'), ['S-A', 'S-B', 'S-C'].map(id => JSON.stringify({ event: 'story_start', storyId: id, provider: 'minimax', model: 'MiniMax-M3' })).join('\n') + '\n');
  mkdirSync(join(logDir, 'story-retry-state')); for (const id of ['S-A', 'S-B', 'S-C']) writeFileSync(join(logDir, `story-retry-state/${id}.count`), '0');
  const prd = join(d, 'prd.json');
  const story = (id: string, file: string) => ({ id, jiraKey: id, title: `${id} story`, description: 'd', agentRole: 'engineer', status: 'completed', completed: true,
    codelines: ['codeline'], technicalNotes: { files: [file] }, verificationCriteria: [`${file} present`] });
  writeFileSync(prd, JSON.stringify({ project: { name: 'fixture', outputDir: proj }, implementationOrder: { core: ['S-A', 'S-B', 'S-C'] },
    stories: [story('S-A', 'pkg/a.py'), story('S-B', 'pkg/b.py'), story('S-C', 'pkg/c.py')] }));

  // THE SCRIPTED MODEL. Answers by (story, cycle); records prompt and cwd per call.
  const calls = join(d, 'calls'); mkdirSync(calls);
  const runner = join(d, 'runner.sh');
  writeFileSync(runner, `#!/usr/bin/env bash
prompt=$(cat)
story=$(printf '%s' "$prompt" | grep -oE 'S-[ABC] story' | head -1 | cut -d' ' -f1)
[ -n "$story" ] || story=$(printf '%s' "$prompt" | grep -oE 'S-[ABC]' | head -1)
n=$(ls "${calls}" | grep -c "^$story-.*\.prompt$" || true); n=$((n+1))
printf '%s' "$prompt" > "${calls}/$story-$n.prompt"; pwd -P > "${calls}/$story-$n.cwd"
answer='{"verdict":"approved","issues":[],"summary":"fine"}'
if [ "$n" -eq 1 ]; then
  case "$story" in
    S-A) answer='{"verdict":"changes_requested","issues":[{"severity":"blocker","file":"pkg/a.py","line":1,"description":"MARKER_A must be 2"}],"summary":"fix a"}' ;;
    S-B) answer='dict":"approved","issues":[],"summary":"first five bytes lost on the wire"' ;;
  esac
fi
esc=$(printf '%s' "$answer" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
[ -n "\${ORCH_JSON_RESULT:-}" ] && printf '{"result":"%s","cost_usd":0}' "$esc" > "$ORCH_JSON_RESULT"
printf '%s' "$answer"
`);
  chmodSync(runner, 0o755);

  const script = `
    set -uo pipefail
    SCRIPT_DIR="${SCRIPTS}"; AUTOMATION_DIR="${SCRIPTS}/.."; LOG_DIR="${logDir}"; PRD_FILE="${prd}"; MAIN_PRD_FILE="${prd}"
    PROJECT_ROOT="${proj}"; PHASE=core; export LOG_DIR PRD_FILE MAIN_PRD_FILE PROJECT_ROOT PHASE SCRIPT_DIR AUTOMATION_DIR
    export AI_RUNNER_CMD="${runner}" AUTO_APPROVE=true EPAM_PROJECT_CONFIG_DIR="${join(ROOT, 'orchestrations/projects/metrolinx')}"
    export EPAM_PROVIDER_SET=openrouter OPENROUTER_API_KEY=none MINIMAX_API_KEY=none REVIEW_LOG="${logDir}/code-reviews.jsonl"
    log(){ echo "LOG: $*"; }; warning(){ echo "WARN: $*"; }; error(){ echo "ERR: $*"; }; success(){ echo "OK: $*"; }; info(){ :; }
    _emit_agent(){ :; }
    . "$SCRIPT_DIR/lib/story-retry-state.sh"; . "$SCRIPT_DIR/lib/phase-assessment.sh"; . "$SCRIPT_DIR/lib/review-cycle.sh"
    # THE SCRIPTED WRITER: applies the reviewer's finding to the story's file and commits, as the writer would.
    run_story_with_watchdog(){ echo "WRITER: $1" >> "${d}/writer.log"; sed -i 's/MARKER_A = 1/MARKER_A = 2/' "${proj}/pkg/a.py"; git -C "${proj}" -c user.email=t@t -c user.name=t commit -qam "$1: story complete (1 file(s))"; echo "{\\"storyId\\":\\"$1\\",\\"sha\\":\\"$(git -C "${proj}" rev-parse HEAD)\\"}" >> "$LOG_DIR/story-changes.jsonl"; }
    cd "${d}"   # the orchestrator's cwd is NOT the codeline — as live
    run_review_cycle; echo "RC=$?"
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 240_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const prompts: Record<string, string> = {}; const cwds: Record<string, string> = {};
  for (const f of readdirSync(calls)) {
    if (f.endsWith('.prompt')) prompts[f.replace('.prompt', '')] = readFileSync(join(calls, f), 'utf8');
    if (f.endsWith('.cwd')) cwds[f.replace('.cwd', '')] = readFileSync(join(calls, f), 'utf8').trim();
  }
  const writer = existsSync(join(d, 'writer.log')) ? readFileSync(join(d, 'writer.log'), 'utf8').trim().split('\n') : [];
  const count = (id: string) => readFileSync(join(logDir, `story-retry-state/${id}.count`), 'utf8').trim();
  return { out, rc: /RC=(\d+)/.exec(out)?.[1], prompts, cwds, writer, count, proj, d };
}

describe('the review cycle — review, fix, re-review — at £0', () => {
  const r = runCycle();

  it('the cycle ran and ended APPROVED in two cycles', () => {
    expect(r.rc, r.out.slice(-2500)).toBe('0');
    expect(Object.keys(r.prompts).filter(k => k.startsWith('S-A')).length).toBe(2);
    expect(Object.keys(r.prompts).filter(k => k.startsWith('S-C')).length).toBe(2);
  });

  it("each story's review carried its own commit and no other story's", () => {
    expect(r.prompts['S-A-1']).toContain('MARKER_A');
    expect(r.prompts['S-A-1']).not.toContain('MARKER_B');
    expect(r.prompts['S-A-1']).not.toContain('MARKER_C');
    expect(r.prompts['S-B-1']).toContain('MARKER_B');
    expect(r.prompts['S-B-1']).not.toContain('MARKER_A');
  });

  it("the re-review of A saw A's fix — the new commit, not the old one", () => {
    expect(r.prompts['S-A-2']).toContain('MARKER_A = 2');
  });

  it('the reviewer ran inside the codeline, never where the orchestrator stood', () => {
    for (const [k, cwd] of Object.entries(r.cwds)) expect(cwd, `${k} ran in ${cwd}`).toBe(r.proj);
  });

  it("only A was re-implemented — B's unparsed verdict was re-reviewed, not handed to the writer", () => {
    expect(r.writer).toEqual(['WRITER: S-A']);
  });

  it("only A's ladder advanced; B and C keep theirs", () => {
    expect(Number(r.count('S-A'))).toBeGreaterThan(0);
    expect(r.count('S-B')).toBe('0');
    expect(r.count('S-C')).toBe('0');
  });
});
