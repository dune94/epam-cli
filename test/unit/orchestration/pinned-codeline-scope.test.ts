/**
 * CODELINE SCOPE MUST NOT BE PINNED. It is discovered agentically, or not at all.
 *
 * This file previously asserted the OPPOSITE — it required
 * `JIRA_CODELINES="gotransit,upexpress,metrolinx"` to be declared in
 * projects/metrolinx/config.env, and validated that the hand-written list parsed
 * into three resolvable repositories. That test locked in the violation.
 *
 * Why the pin existed: the scorer produced a near-tie (gotransit=152, c365=143,
 * top1/top2=1.06) and the LLM wrongly included c365 on the fifth of five runs.
 * c365 is a .NET CRM integration with zero live-preview code and no node_modules.
 * The response was to pin the list rather than fix the scorer.
 *
 * Why that is not acceptable: ingest-jira-tickets.sh runs codeline-discovery.js
 * ONLY when JIRA_CODELINES is empty. Declaring it did not "make the scope
 * replayable" — it switched agentic discovery off entirely, so the discovery
 * path never executed on any run. A hand-maintained list of client repository
 * names became load-bearing, and the neighbouring config file
 * (orchestrations/jira/metrolinx.env) documents the exact opposite in its own
 * header: "Codelines are discovered at runtime ... no JIRA_CODELINES or
 * JIRA_WORKTREE_* needed here."
 *
 * Standing instruction (2026-08-06): codelines MUST be found agentically via
 * CodeGraph, never hardcoded. A config file is not an exemption from the
 * no-hardcoding rule. If discovery picks wrongly, the defect is in the
 * scorer/discovery agent — pinning hides it.
 *
 * These tests assert the ABSENCE of the pin, and that the mechanism which
 * consumes it stays gated on emptiness.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const PROJECTS_DIR = join(REPO_ROOT, 'orchestrations/projects');

/** Every project config + secrets env file in the repo — no project is exempt. */
function everyProjectEnvFile(): string[] {
  const files: string[] = [];
  for (const p of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!p.isDirectory()) continue;
    const cfg = join(PROJECTS_DIR, p.name, 'config.env');
    if (existsSync(cfg)) files.push(cfg);
  }
  const jiraDir = join(REPO_ROOT, 'orchestrations/jira');
  if (existsSync(jiraDir)) {
    for (const f of readdirSync(jiraDir)) {
      if (f.endsWith('.env')) files.push(join(jiraDir, f));
    }
  }
  // TRACKED files only. An untracked local .env is a developer's own machine
  // config for their own project — not something this repo ships, and not
  // something a test may quietly rewrite. What the engine SHIPS is what this
  // suite governs. (A local file can still pin codelines and is still a real
  // hazard, because run-agent-orchestration.sh auto-sources orchestrations/
  // jira/.env when JIRA_URL is unset — that is reported to the operator, not
  // silently edited.)
  const tracked = new Set(
    execFileSync('git', ['-C', REPO_ROOT, 'ls-files'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map((f) => join(REPO_ROOT, f)),
  );
  return files.filter((f) => tracked.has(f));
}

/** Real assignments only — a commented-out mention is documentation, not a pin. */
function assignsKey(file: string, key: string): boolean {
  return readFileSync(file, 'utf8')
    .split('\n')
    .some((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
}

describe('no project pins its codeline scope', () => {
  const files = everyProjectEnvFile();

  it('finds project env files to check — otherwise this suite proves nothing', () => {
    expect(files.length, 'no project config.env or jira/*.env found at all').toBeGreaterThan(0);
  });

  it('NO env file assigns JIRA_CODELINES — that assignment disables discovery', () => {
    const offenders = files.filter((f) => assignsKey(f, 'JIRA_CODELINES'));
    expect(
      offenders.map((f) => f.replace(REPO_ROOT, '')),
      'JIRA_CODELINES is assigned. ingest-jira-tickets.sh only runs codeline-discovery.js ' +
        'when it is EMPTY, so this silently switches agentic discovery off.',
    ).toEqual([]);
  });

  it('NO env file assigns JIRA_WORKTREE_<NAME> — those are hardcoded client repo paths', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (/^\s*(export\s+)?JIRA_WORKTREE_[A-Z0-9_]+\s*=/.test(line)) {
          offenders.push(`${f.replace(REPO_ROOT, '')}: ${line.trim().split('=')[0]}`);
        }
      }
    }
    expect(offenders, 'worktree paths are resolved from discovery, never declared').toEqual([]);
  });

  it('JIRA_CODELINE_ROOT (the directory discovery SCANS) is still declared — that is the input, not the answer', () => {
    // Distinguishes the legitimate config value from the banned one: pointing the
    // discovery agent at a search root is configuration; naming the repos it must
    // return is the answer, and the agent must produce that itself.
    const anyRoot = files.some((f) => assignsKey(f, 'JIRA_CODELINE_ROOT'));
    expect(anyRoot, 'discovery has nothing to scan — it cannot run at all').toBe(true);
  });
});

describe('the consumer stays gated on JIRA_CODELINES being empty', () => {
  const ingest = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/ingest-jira-tickets.sh'), 'utf8');

  it('discovery runs only when JIRA_CODELINES is empty — the gate that made the pin lethal', () => {
    expect(
      ingest,
      'if this gate is removed or inverted, a future pin would no longer disable discovery ' +
        'and this whole suite would stop meaning anything',
    ).toMatch(/-z\s+"\$\{JIRA_CODELINES:-\}"/);
  });

  it('discovery is invoked at all', () => {
    expect(ingest).toMatch(/codeline-discovery\.js/);
  });
});
