/**
 * THE SELF-HEAL ANALYST IS TOLD WHY THE ATTEMPT WAS REFUSED — EVERY CALLER, EVERY CLASS.
 *
 * Operator, 2026-10-06: "this has been an ongoing issue — write a test to correct this once and for all;
 * it is critical and has been asked for many times". Every caller knows why it refused an attempt: the
 * reviewer's finding, the validator's verdict, the contract's refusal, the missing criteria. None of it
 * reached the analyst: lib/self-heal.js dropped `reason` (it chose a failure CLASS from it and passed
 * nothing else), and the three bash callers of agent-attempt-analyst.sh passed no reason at all. Seen live
 * on the real model the same day: the prompt reviewer rejected metrolinx's repro-test-writer as narrowed to
 * one ticket, and the analyst was told the agent "produced no parseable structured output".
 *
 * EXECUTED: the real agent-attempt-analyst.sh rendering its real project prompt, with a runner that records
 * the prompt it is sent; the real lib/self-heal.js; the real prompt builder's review rejection; the real
 * bash helper every shell caller goes through. Only the model is a stand-in.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintProjectPrompts } from '../../helpers/project-prompts';

const REPO = join(__dirname, '../../../');
const SCRIPTS = join(REPO, 'orchestrations/scripts');
const ANALYST = join(SCRIPTS, 'agent-attempt-analyst.sh');
const HELPER = join(SCRIPTS, 'lib/attempt-analyst.sh');
const NO_JSON_HINT = 'produced no parseable structured output';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A runner that records every prompt it is sent and answers with a directive. */
function recorder() {
  const dir = mkdtempSync(join(tmpdir(), 'analyst-why-')); dirs.push(dir);
  const seen = join(dir, 'prompts');
  mkdirSync(seen);
  const runner = join(dir, 'runner.sh');
  writeFileSync(runner, `#!/usr/bin/env bash\ncat > ${JSON.stringify(seen)}/$(date +%s%N).txt\necho "Do the thing the reason names."\n`);
  chmodSync(runner, 0o755);
  const prompts = () => readdirSync(seen).sort().map((f) => readFileSync(join(seen, f), 'utf8'));
  const file = (name: string, text: string) => { const f = join(dir, name); writeFileSync(f, text); return f; };
  return { dir, runner, prompts, file };
}
const env = (r: ReturnType<typeof recorder>, extra: Record<string, string> = {}) => ({
  ...process.env, AI_RUNNER_CMD: r.runner, EPAM_PROJECT_CONFIG_DIR: mintProjectPrompts(), LOG_DIR: r.dir,
  NODE_BIN: process.execPath, ...extra,
});
/** The analyst prompt, proven to be one: the class section is there and the output reached it. */
function analystPrompt(r: ReturnType<typeof recorder>, out: string) {
  const ps = r.prompts().filter((p) => /=== FAILURE CLASS ===/.test(p));
  expect(ps.length, `the analyst never called its model:\n${out}`).toBe(1);
  return ps[0];
}

describe('the analyst script puts the reason in its prompt — every failure class', () => {
  for (const cls of ['no_json', 'malformed', 'no_file', 'max_iterations', 'invalid_test', 'commit_rejected', 'rejected']) {
    it(cls, () => {
      const r = recorder();
      const reason = `REASON-${cls}: the reviewer found the role and the test path are one story's`;
      const res = spawnSync('bash', [ANALYST, cls, r.file('out.txt', `OUTPUT-${cls}\n`)], { encoding: 'utf8', env: env(r, { AGENT_ANALYST_REASON: reason }) });
      const p = analystPrompt(r, res.stdout + res.stderr);
      expect(p).toContain(`OUTPUT-${cls}`);
      expect(p).toMatch(/=== WHY THIS ATTEMPT WAS REFUSED ===\n[^\n]*REASON-/);
      expect(p).toContain(reason);
    });
  }

  it('a content rejection is not diagnosed as unparseable output', () => {
    const r = recorder();
    const res = spawnSync('bash', [ANALYST, 'rejected', r.file('out.txt', 'a complete prompt\n')], { encoding: 'utf8', env: env(r, { AGENT_ANALYST_REASON: 'narrowed to one ticket' }) });
    const p = analystPrompt(r, res.stdout + res.stderr);
    expect(p).not.toContain(NO_JSON_HINT);
    expect(p).toMatch(/refused for its CONTENT/i);
  });

  it('an unparseable answer is still diagnosed as one', () => {
    const r = recorder();
    const res = spawnSync('bash', [ANALYST, 'no_json', r.file('out.txt', 'prose\n')], { encoding: 'utf8', env: env(r, { AGENT_ANALYST_REASON: 'no JSON in the reply' }) });
    expect(analystPrompt(r, res.stdout + res.stderr)).toContain(NO_JSON_HINT);
  });

  it('a caller that gives no reason is said to have given none — loudly, never an empty section', () => {
    const r = recorder();
    const e = env(r); delete (e as Record<string, string | undefined>).AGENT_ANALYST_REASON;
    const res = spawnSync('bash', [ANALYST, 'no_file', r.file('out.txt', 'x\n')], { encoding: 'utf8', env: e });
    const p = analystPrompt(r, res.stdout + res.stderr);
    expect(p).toMatch(/=== WHY THIS ATTEMPT WAS REFUSED ===\n\(the caller gave no reason/);
    expect(res.stderr).toMatch(/no reason/i);
  });
});

describe('lib/self-heal.js hands the analyst the reason, and the class the caller states', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { selfHeal } = require(join(SCRIPTS, 'lib/self-heal.js'));
  it('the reason reaches the prompt', () => {
    const r = recorder();
    const proj = mintProjectPrompts();
    const res = selfHeal({ agent: 'x', reason: 'REASON-JS: the third criterion is not observable', output: 'OUTPUT-JS', model: 'stub-model', runner: r.runner, logDir: r.dir, projectConfigDir: proj });
    const p = analystPrompt(r, res.stderr || '');
    expect(p).toContain('REASON-JS: the third criterion is not observable');
    expect(p).toContain('OUTPUT-JS');
  });
  it('a caller that states the class gets that class', () => {
    const r = recorder();
    const res = selfHeal({ agent: 'x', reason: 'narrowed', output: 'a whole prompt', failureClass: 'rejected', model: 'stub-model', runner: r.runner, logDir: r.dir, projectConfigDir: mintProjectPrompts() });
    const p = analystPrompt(r, res.stderr || '');
    expect(p).toMatch(/=== FAILURE CLASS ===\nrejected/);
    expect(p).not.toContain(NO_JSON_HINT);
  });
});

describe('the prompt builder: a reviewer\'s rejection reaches the analyst as a content rejection, with its reason', () => {
  it('end to end through the real builder', async () => {
    const r = recorder();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const builder = require(join(SCRIPTS, 'lib/project-prompt-builder.js'));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const contract = require(join(SCRIPTS, 'lib/project-prompt-contract.js'));
    const proj = mintProjectPrompts();
    const cfg = join(r.dir, 'project'); mkdirSync(join(cfg, 'prompts'), { recursive: true });
    const boot = r.file('bootstrap.json', JSON.stringify({ copyVerbatim: [builder.PROJECT_PROMPT_GENERATOR_ID], generated: ['repro-test-writer'] }));
    const echo = async (prompt: string) => {
      const shown: string[] = []; const re = /^--- SEGMENT (\d+) ---\n([\s\S]*?)(?=^--- (?:SEGMENT \d+|END SEGMENTS) ---$)/gm;
      let m; while ((m = re.exec(prompt))) shown.push(m[2].replace(/\n$/, ''));
      return contract.formatSegments(shown);
    };
    const saved = { ...process.env };
    Object.assign(process.env, { AI_RUNNER_CMD: r.runner, EPAM_MODEL: 'stub-model', EPAM_PROJECT_CONFIG_DIR: proj, LOG_DIR: r.dir, NODE_BIN: process.execPath });
    try {
      let n = 0;
      await builder.buildProjectPrompts({
        templatesDir: join(REPO, 'orchestrations/prompts/templates'), projectConfigDir: cfg, bootstrapFile: boot, mode: 'generate',
        projectContext: 'p', codelineContext: 'c', mintedRoles: 'r', attempts: 2, runText: echo,
        reviewPrompt: async () => (n++ === 0 ? { ok: false, reviewed: true, reason: 'REASON-REVIEW: the role is one ticket\'s' } : { ok: true, reviewed: true }),
      });
    } finally { process.env = saved; }
    const p = analystPrompt(r, '');
    expect(p).toContain('REASON-REVIEW: the role is one ticket\'s');
    expect(p).toMatch(/=== FAILURE CLASS ===\nrejected/);
    expect(p).not.toContain(NO_JSON_HINT);
  });
});

describe('the shell callers: one helper, the reason required by its signature', () => {
  it('the helper hands the reason to the analyst', () => {
    const r = recorder();
    const out = r.file('out.txt', 'OUTPUT-SH\n');
    const res = spawnSync('bash', ['-c', `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; . ${JSON.stringify(HELPER)}; run_attempt_analyst invalid_test "REASON-SH: the test does not parse" ${JSON.stringify(out)}`],
      { encoding: 'utf8', env: env(r) });
    const p = analystPrompt(r, res.stdout + res.stderr);
    expect(p).toContain('REASON-SH: the test does not parse');
    expect(p).toContain('OUTPUT-SH');
  });

  it('no engine code calls the analyst script except through the helper or lib/self-heal.js', () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) { if (!['node_modules', 'tools'].includes(e.name)) walk(f); continue; }
        if (!/\.(sh|js)$/.test(e.name) || f === ANALYST || f === HELPER || f.endsWith('lib/self-heal.js')) continue;
        readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
          if (/^\s*(#|\/\/|\*)/.test(l)) return;
          if (/agent-attempt-analyst\.sh/.test(l) && /\bbash\b|spawn|exec/.test(l)) offenders.push(`${f.slice(SCRIPTS.length + 1)}:${i + 1}`);
        });
      }
    };
    walk(SCRIPTS);
    expect(offenders, 'a caller bypasses the helper and can drop the reason').toEqual([]);
  });

  it('every helper call passes a reason', () => {
    const missing: string[] = [];
    let calls = 0;
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) { if (!['node_modules', 'tools'].includes(e.name)) walk(f); continue; }
        if (!/\.sh$/.test(e.name) || f === HELPER) continue;
        readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
          if (/^\s*#/.test(l) || !/\brun_attempt_analyst\b/.test(l)) return;
          calls += 1;
          const m = l.match(/run_attempt_analyst\s+("[^"]*"|\S+)\s+("[^"]*"|\S+)/);
          if (!m || m[2] === '""' || m[2] === "''") missing.push(`${f.slice(SCRIPTS.length + 1)}:${i + 1}`);
        });
      }
    };
    walk(SCRIPTS);
    expect(calls, 'no shell caller uses the helper — nothing below means anything').toBeGreaterThanOrEqual(3);
    expect(missing).toEqual([]);
  });
});
