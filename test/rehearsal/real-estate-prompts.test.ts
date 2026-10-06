/**
 * THE PROJECT PROMPTS, BUILT AND JUDGED BY THE REAL MODEL, INSIDE THE OPERATOR'S RESUME, ON A COPY.
 *
 * Operator, 2026-10-06: "You need to actually run the prompts and prove it — 100% proof — no using live
 * runs", "use a REAL REAL REAL harness". The defect: metrolinx's generated repro-test-writer prompt was
 * narrowed to one ticket ("write a spec file for a Toast component at cx-shared") with its run-time slots
 * displaced; the real reviewer passed it; and a resume keeps whatever prompts the run built.
 *
 * WHAT RUNS. The operator's exact resume (test/rehearsal/real-estate-setup.sh copies of the real install and
 * codelines), through the real launcher, to the end of the run. Every seam is answered by the mock agent
 * through the copilot set's own redirect — EXCEPT prompt-builder and prompt-review, the two agents this
 * change is about: a wrapper around the pipeline's own runner (AI_RUNNER_CMD, the variable the engine reads)
 * removes the redirect for those two and supplies the operator's Copilot credential at call time, so they
 * run their real prompts on the real model. Every call is ledgered (seam, route, exit) — never its content.
 *
 * Holds when: the run exits 0 with every non-passed lane done; both real seams were called for real and the
 * mock received none of them; every generated prompt installed for the project was judged by the real
 * reviewer in THIS run; no installed prompt carries a ticket-specific word its template does not; the
 * corrupt repro-test-writer the copy started with is not what is installed at the end.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { type ChildProcess } from 'node:child_process';
import { edgeFor, zeroCostEnv, run } from '../integration/lib/fixture-install';
import { MockAgent } from '../mock-agent/agent';
import { World } from '../mock-agent/world';
import { correct } from '../mock-agent/seams';
import { configFor, standInsFor, vendorEdge, type ProjectRun } from '../mock-agent/harness';

const R = process.env.REHEARSAL_ROOT || '';
const RUN = process.env.REHEARSAL_RESUME_RUN || '';
const TICKET = process.env.REHEARSAL_TICKET || '';
const PROJECT = process.env.REHEARSAL_PROJECT || '';
const REAL_SEAMS = ['prompt-builder', 'prompt-review'];
const children: ChildProcess[] = [];
afterAll(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
const strip = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');
const words = (t: string) => new Set((String(t).toLowerCase().match(/[a-z]{5,}/g) || []));

/** The pipeline's own runner, wrapped: the two seams under test reach the real model, every other is untouched. */
function realSeamRunner(dir: string, realRunner: string, ledger: string): string {
  const f = join(dir, 'ai-run-real-seams.sh');
  writeFileSync(f, `#!/bin/bash
case "\${EPAM_AGENT_NAME:-}" in
  ${REAL_SEAMS.join('|')})
    unset COPILOT_PROVIDER_BASE_URL COPILOT_OFFLINE
    COPILOT_GITHUB_TOKEN="$("\${NODE_BIN:-node}" -e '
      const t = require("fs").readFileSync(require("os").homedir() + "/.copilot/config.json", "utf8")
        .split("\\n").filter((l) => !/^\\s*\\/\\//.test(l)).join("\\n");
      process.stdout.write(JSON.parse(t).copilotTokens["https://github.com:dune94"] || "");')"
    export COPILOT_GITHUB_TOKEN
    route=REAL ;;
  *) route=MOCK ;;
esac
"${realRunner}" "$@"; rc=$?
printf '%s\\t%s\\t%s\\t%s\\n' "$(date -Is)" "$route" "\${EPAM_AGENT_NAME:-?}" "$rc" >> "${ledger}"
exit $rc
`);
  chmodSync(f, 0o755);
  return f;
}

describe.runIf(R && RUN && TICKET && PROJECT)('the project prompts on the real model, inside the operator resume on a copy', () => {
  it('builds and judges every project prompt for real, and the run still finishes', async () => {
    const install = join(R, 'install');
    const orch = join(install, 'orchestrations');
    const codelineRoot = join(R, 'codelines');
    const journal = join(R, 'journal', `prompts-${new Date().toISOString().replace(/[:.]/g, '')}`); mkdirSync(journal, { recursive: true });
    const projDir = join(orch, 'projects', PROJECT);
    const promptsDir = join(projDir, 'prompts');
    const prd = join(projDir, 'prd.json');
    const ledger = join(journal, 'calls.tsv');
    const codelines = () => readdirSync(codelineRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.includes('-wt-')).map((d) => join(codelineRoot, d.name));
    const stories = () => { try { return (JSON.parse(readFileSync(prd, 'utf8')).stories || []).map((s: { id: string }) => s.id); } catch { return []; } };
    const config: Record<string, string> = { EPAM_PROVIDER_SET: 'copilot' };
    const generatedIds = () => readdirSync(promptsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
      .filter((id) => { try { return /^Generated from the /.test(JSON.parse(readFileSync(join(promptsDir, `${id}.json`), 'utf8')).$why?.[0] || ''); } catch { return false; } });

    // What the copy starts with, so "changed" is measured against the real defect, not assumed.
    const before = JSON.parse(readFileSync(join(promptsDir, 'repro-test-writer.json'), 'utf8')).body as string;
    writeFileSync(join(journal, 'repro-test-writer.before.txt'), before);

    const agent = new MockAgent(orch, journal, stories, ['brownfield', 'multi-codeline']);
    await agent.start();
    const { bin } = edgeFor(install, agent.url, children);
    const world = new World(codelines, () => prd, projDir);
    agent.on('*', correct(world, install));
    const codemie = await standInsFor(install, agent, journal, config);
    const r = { install, out: '', agent, project: PROJECT, prd, config, realOut: '', world, codemie } as ProjectRun;

    const passthrough = Object.fromEntries(['EPAM_PASSED_LANES', 'EPAM_ESTIMATION_MANIFEST', 'EPAM_AGENT_MEMORY_SHARE', 'NODE_OPTIONS', 'EPAM_WHOLE_SUITE_CHECK']
      .filter((k) => process.env[k]).map((k) => [k, process.env[k] as string]));
    const env = zeroCostEnv(bin, agent.url, {
      ...configFor(install, PROJECT, config), ...vendorEdge(r), ...passthrough,
      EPAM_FREE_RUN: '1',
      JIRA_URL: 'http://127.0.0.1:9', JIRA_EMAIL: 'rehearsal@local', JIRA_TOKEN: 'rehearsal-no-access',
      JIRA_CODELINE_ROOT: codelineRoot,
      EPAM_RESUME_RUN: RUN,
      EPAM_PARALLEL_CODELINES: '0', EPAM_PAUSE_AFTER_AGENT_MINT: '1', EPAM_PAUSE_BEFORE_WRITER: '1',
      SKIP_REGRESSION_GUARD: 'true',
      AI_RUNNER_CMD: realSeamRunner(journal, join(orch, 'scripts/ai-run.sh'), ledger),
    });
    delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
    expect(env.COPILOT_GITHUB_TOKEN || '', 'a real-looking Copilot token reached the launch environment').not.toMatch(/^(gho_|ghp_|ghu_|github_pat_)/);

    const started = Date.now();
    const res = await run('bash', [join(orch, 'scripts/pipeline'), '--jira', TICKET], { cwd: install, env, timeout: 5 * 60 * 60_000 });
    const text = strip(res.stdout + res.stderr);
    writeFileSync(join(journal, 'launch.log'), text);
    writeFileSync(join(journal, 'mock-calls.json'), JSON.stringify(agent.calls.map((c) => ({ n: c.n, seam: c.seam, story: c.story })), null, 1));
    const tail = text.split('\n').slice(-80).join('\n');
    const calls = existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t')) : [];
    const real = calls.filter((c) => c[1] === 'REAL');
    console.log(`[prompts] exit ${res.status}; ${real.length} real call(s), ${calls.length - real.length} mock-routed; mock answered ${agent.calls.length}; journal ${journal}`);

    // 1. THE REDIRECT IS PROVEN, both ways: the two seams were called for real, and the mock never answered them.
    for (const s of REAL_SEAMS) expect(real.some((c) => c[2] === s), `${s} never reached the real model`).toBe(true);
    expect(real.filter((c) => c[3] !== '0'), 'a real call failed').toEqual([]);
    expect(calls.filter((c) => c[1] === 'MOCK' && REAL_SEAMS.includes(c[2])), 'a seam under test was answered by the mock').toEqual([]);

    // 2. EVERY GENERATED PROMPT WAS JUDGED BY THE REAL REVIEWER IN THIS RUN — kept or rebuilt.
    const ids = generatedIds();
    expect(ids.length, 'no generated prompt is installed — nothing below means anything').toBeGreaterThan(10);
    const logs = join(orch, 'logs');
    const unjudged = ids.filter((id) => {
      const f = join(logs, `prompt-review-${id}.log`);
      return !existsSync(f) || statSync(f).mtimeMs < started || !/<PROMPT_REVIEW>[\s\S]*<\/PROMPT_REVIEW>/.test(readFileSync(f, 'utf8'));
    });
    expect(unjudged, 'prompts installed without a verdict from the real reviewer in this run').toEqual([]);

    // 3. NO PROMPT IS NARROWED TO THE TICKET: a ticket-title word in a prompt whose template lacks it.
    const titles = (JSON.parse(readFileSync(prd, 'utf8')).stories || []).map((s: { title?: string }) => s.title || '').join(' ');
    const ticketWords = words(titles);
    expect(ticketWords.size, 'the PRD carries no ticket title — the check below would be vacuous').toBeGreaterThan(0);
    const narrowed: string[] = [];
    for (const id of ids) {
      const body = JSON.parse(readFileSync(join(promptsDir, `${id}.json`), 'utf8')).body || '';
      const tpl = JSON.parse(readFileSync(join(orch, 'prompts/templates', `${id}.json`), 'utf8'));
      const tplWords = words(tpl.body || Object.values(tpl.bodies || {}).join('\n'));
      const leaked = [...words(body)].filter((w) => ticketWords.has(w) && !tplWords.has(w));
      if (leaked.length) narrowed.push(`${id}: ${leaked.join(', ')}`);
    }
    expect(narrowed, 'prompts narrowed to this ticket').toEqual([]);

    // 4. THE DEFECT THE COPY STARTED WITH IS GONE.
    const after = JSON.parse(readFileSync(join(promptsDir, 'repro-test-writer.json'), 'utf8')).body as string;
    writeFileSync(join(journal, 'repro-test-writer.after.txt'), after);
    expect(after, 'the corrupt repro-test-writer is still installed').not.toBe(before);

    // 5. AND THE RUN STILL DOES ITS WORK.
    expect(text, 'a worktree merge failed').not.toMatch(/Failed to merge wt-/);
    expect(text, `a lane failed — log tail:\n${tail}`).not.toMatch(/Phase '[a-z]+' for '[a-z]+' failed/);
    expect(res.status, `the run did not finish — log tail:\n${tail}`).toBe(0);
  }, 5 * 60 * 60_000);
});
