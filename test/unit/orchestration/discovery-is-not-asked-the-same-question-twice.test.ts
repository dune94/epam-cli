/**
 * DISCOVERY IS NOT ASKED THE SAME QUESTION TWICE.
 *
 * A relaunch of a run that died before its first pause asked the discovery agent again about the
 * same tickets and the same repositories at the same commits (AMSD-2974, runs 3-7, 2026-10-09).
 * The answer is reused only when the whole question is identical — the rendered prompt and the
 * commit checked out in every candidate repository. Any change asks the agent again.
 *
 * Executes the real codeline-discovery.js; only the model is stood in (a runner that counts its
 * calls and answers). Asserts the effect: calls made, the codelines written, the facts written.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DISCOVERY_JS = join(__dirname, '../../../orchestrations/scripts/lib/codeline-discovery.js');

function gitRepo(root: string, name: string, file: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(dir, file), `${name}\n`);
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

function estate() {
  const d = mkdtempSync(join(tmpdir(), 'discovery-reuse-'));
  const root = join(d, 'estate');
  const a = gitRepo(root, 'alpha-site', 'checkout.ts');
  gitRepo(root, 'beta-site', 'index.ts');
  const cfg = join(d, 'project'); mkdirSync(cfg);
  const issues = join(d, 'issues.json');
  writeFileSync(issues, JSON.stringify([{ jiraKey: 'T-1', title: 'Checkout shows the wrong total', description: 'alpha checkout' }]));
  const calls = join(d, 'calls.log');
  const runner = join(d, 'ai-run.sh');
  const answer = { codelines: [{ name: 'alpha-site', path: a, evidence: 'checkout.ts holds the checkout total', confidence: 'high' }] };
  writeFileSync(runner, `#!/bin/bash\ncat >/dev/null\necho call >> ${JSON.stringify(calls)}\ncat <<'J'\n${JSON.stringify(answer)}\nJ\n`);
  return { d, root, a, cfg, issues, calls, runner };
}

function discover(e: ReturnType<typeof estate>) {
  const out = join(e.d, `out-${Date.now()}-${Math.random()}.json`);
  const r = spawnSync(process.execPath, [DISCOVERY_JS, '--issues', e.issues, '--root', e.root, '--out', out, '--model', 'stand-in'], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, SEMBLE_ENABLED: '0', EPAM_PROJECT_CONFIG_DIR: e.cfg,
      CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE: e.runner, EPAM_CONTENT_RETRY_ATTEMPTS: '1' },
  });
  const calls = existsSync(e.calls) ? readFileSync(e.calls, 'utf8').split('\n').filter(Boolean).length : 0;
  return { status: r.status, stderr: r.stderr, calls,
    out: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
}

const names = (o: any) => (o?.codelines || []).map((c: any) => c.name);
const facts = (cfg: string) => readdirSync(cfg).filter((f) => f.includes('codeline-facts'))
  .map((f) => readFileSync(join(cfg, f), 'utf8')).join();

describe('discovery reuses its answer only to an identical question', () => {
  it('the same question twice: one agent call, the same codelines and facts both times', () => {
    const e = estate();
    const first = discover(e);
    expect(first.status, first.stderr).toBe(0);
    expect(first.calls).toBe(1);
    expect(first.out.codelines.map((c: any) => c.path)).toEqual([e.a]);
    const [name] = names(first.out);
    expect(facts(e.cfg), 'no codeline facts were written — the comparison would be vacuous').toContain(`"${name}"`);
    rmSync(join(e.cfg, readdirSync(e.cfg).find((f) => f.includes('codeline-facts'))!));

    const second = discover(e);
    expect(second.status, second.stderr).toBe(0);
    expect(second.calls, 'the agent was asked again about an unchanged question').toBe(1);
    expect(second.out).toEqual(first.out);
    expect(facts(e.cfg), 'a reused answer must still write the codeline facts').toContain(`"${name}"`);
  });

  it('a changed ticket asks the agent again', () => {
    const e = estate();
    discover(e);
    writeFileSync(e.issues, JSON.stringify([{ jiraKey: 'T-1', title: 'Checkout shows the wrong total', description: 'reworded' }]));
    expect(discover(e).calls).toBe(2);
  });

  it('a new commit in a candidate repository asks the agent again', () => {
    const e = estate();
    discover(e);
    writeFileSync(join(e.root, 'beta-site', 'index.ts'), 'changed\n');
    execFileSync('git', ['-C', join(e.root, 'beta-site'), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'c2']);
    expect(discover(e).calls).toBe(2);
  });

  it('a new candidate repository asks the agent again', () => {
    const e = estate();
    discover(e);
    gitRepo(e.root, 'gamma-site', 'x.ts');
    expect(discover(e).calls).toBe(2);
  });

  it('a stored answer whose repository is gone is not served', () => {
    const e = estate();
    discover(e);
    const key = readdirSync(join(e.cfg, '.discovery-cache'))[0];
    const f = join(e.cfg, '.discovery-cache', key);
    const doc = JSON.parse(readFileSync(f, 'utf8'));
    doc.codelines[0].path = join(e.d, 'vanished');
    writeFileSync(f, JSON.stringify(doc));
    const r = discover(e);
    expect(r.calls).toBe(2);
    expect(r.out.codelines[0].path).toBe(e.a);
  });
});
