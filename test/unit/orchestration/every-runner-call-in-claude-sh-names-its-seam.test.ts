/**
 * EVERY RUNNER CALL IN claude.sh NAMES ITS SEAM.
 *
 * The writer got its name on 2026-09-11 (the-writer-names-its-seam). Nine other places in claude.sh
 * invoke ai-run.sh directly and named nothing, so llm-handler.sh's best-effort fallback labelled
 * them after the calling script: Langfuse and the cassette of run 20260910T222155Z hold 29 turns
 * of the failure analyst, the PRD change reviewer and the PRD change summarizer filed as one seam
 * called `claude`. The per-seam replay test — whose universe is invocation-profiles.json — reported
 * a seam the registry cannot resolve, and three declared seams with no turns. Same for the speckit
 * review pass in spec-mode-runner.js, labelled by its JSON tag `SPEC_AGENT`.
 *
 * Two assertions. Every `bash "$SCRIPT_DIR/ai-run.sh"` site in claude.sh, enumerated from the
 * script so a new one is covered the day it is written, carries EPAM_AGENT_NAME and EPAM_STORY_ID
 * in its env prefix. And two of those functions are EXECUTED through the real file against a stub
 * runner that dumps its environment: the name the recorder will see is the name asserted.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { provisionProject, cleanupProvisioned } from '../../support/provisioned-project';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const CLAUDE_SH = join(SCRIPTS, 'claude.sh');
const SPEC_RUNNER = join(SCRIPTS, 'spec-mode-runner.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); cleanupProvisioned(); });

const lines = readFileSync(CLAUDE_SH, 'utf8').split('\n');

/** Each ai-run.sh invocation with the env prefix that precedes it (the `\`-continued lines back to the pipe). */
const sites = lines
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => /bash "\$SCRIPT_DIR\/ai-run\.sh"/.test(line) && !/^\s*#/.test(line))
  .map(({ n }) => {
    let start = n - 1;                      // 0-based index of the invocation line
    while (start > 0 && /\\\s*$/.test(lines[start - 1])) start -= 1;
    const fn = lines.slice(0, n).reverse().find((l) => /^[a-z_]+\(\)\s*\{/.test(l))?.replace(/\(\).*/, '') || '?';
    return { n, fn, prefix: lines.slice(start, n).join('\n') };
  });

describe('every runner call in claude.sh names its seam', () => {
  it('the scan found the runner sites — otherwise the cases below are vacuous', () => {
    expect(sites.length, 'no `bash "$SCRIPT_DIR/ai-run.sh"` sites found; the invocation shape has changed').toBeGreaterThanOrEqual(9);
  });

  it.each(sites.map((s) => ({ n: s.n, fn: s.fn })))('$fn (ai-run.sh at line $n) declares EPAM_AGENT_NAME and EPAM_STORY_ID', ({ n }) => {
    const site = sites.find((s) => s.n === n)!;
    expect(site.prefix, `line ${n} invokes the runner with no EPAM_AGENT_NAME — the recorder files its turns under the calling script's name`).toMatch(/EPAM_AGENT_NAME="[^"]+"/);
    expect(site.prefix, `line ${n} invokes the runner with no EPAM_STORY_ID`).toMatch(/EPAM_STORY_ID="[^"]+"/);
  });

  it('the speckit review pass in spec-mode-runner.js names the spec-agent seam, not its JSON tag', () => {
    const src = readFileSync(SPEC_RUNNER, 'utf8');
    const anchor = 'path.join(logDir, `${story.id}-speckit-review.log`)';
    const at = src.indexOf(anchor);
    expect(at, 'the speckit review call was not found').toBeGreaterThan(-1);
    const reviewCall = src.slice(at, at + 600);
    expect(reviewCall, 'the review call passes no env, so it is labelled SPEC_AGENT').toMatch(/EPAM_AGENT_NAME: 'spec-agent'/);
  });

  /** A scripts dir identical to the real one, with ai-run.sh replaced by a runner that records its environment. */
  function stubbedScripts() {
    const d = mkdtempSync(join(tmpdir(), 'named-seam-')); dirs.push(d);
    const scripts = join(d, 'scripts'); mkdirSync(scripts);
    for (const f of readdirSync(SCRIPTS)) if (f !== 'ai-run.sh') symlinkSync(join(SCRIPTS, f), join(scripts, f));
    const dump = join(d, 'env.txt');
    writeFileSync(join(scripts, 'ai-run.sh'), `#!/bin/bash\ncat >/dev/null\nprintf 'EPAM_AGENT_NAME=%s EPAM_STORY_ID=%s\\n' "\${EPAM_AGENT_NAME:-}" "\${EPAM_STORY_ID:-}" >> ${JSON.stringify(dump)}\necho '{"verdict":"pass","issues":[],"reason":"stub","summary":"s"}'\n`);
    chmodSync(join(scripts, 'ai-run.sh'), 0o755);
    return { d, scripts, dump };
  }

  // The functions need SOME gate provider and SOME project to render their prompts against; which
  // ones is not what is being tested, so both are the first the repository declares — never named.
  const anyDeclaredSet = () => Object.keys(JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8')).sets)[0];
  // A project whose prompts are PROVISIONED (every template) (copied from the templates — the
  // established fixture, test/support/provisioned-project.ts): a fresh checkout mints none, and
  // a real project named here would tie the test to whatever that project has minted.
  let provisioned = '';
  const anyDeclaredProject = () => {
    if (!provisioned) provisioned = provisionProject();
    return provisioned;
  };

  function callThroughRealFile(scripts: string, d: string, body: string) {
    const r = spawnSync('bash', ['-c', `. ${JSON.stringify(CLAUDE_SH)} >/dev/null 2>&1\nSCRIPT_DIR=${JSON.stringify(scripts)}\nLOG_DIR=${JSON.stringify(d)}\nprofiles_file=${JSON.stringify(join(ROOT, 'orchestrations/agents/profiles.json'))}\n${body}`], {
      encoding: 'utf8', timeout: 120_000, cwd: ROOT,
      env: { ...process.env, NODE_BIN: process.execPath, ORCH_GATE_PROVIDER: anyDeclaredSet(), EPAM_PROJECT_CONFIG_DIR: anyDeclaredProject(), EPAM_COVERAGE_GATED: '0' },
    });
    return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  }

  it('run_prd_change_reviewer, executed, hands the runner prd-change-reviewer and the story id', () => {
    const { d, scripts, dump } = stubbedScripts();
    const out = callThroughRealFile(scripts, d, `run_prd_change_reviewer FX-7 skill_note '{}' '{"a":1}'`);
    expect(existsSync(dump), `the runner was never invoked:\n${out.slice(-800)}`).toBe(true);
    expect(readFileSync(dump, 'utf8')).toContain('EPAM_AGENT_NAME=prd-change-reviewer EPAM_STORY_ID=FX-7');
  }, 180_000);

  it('run_prd_change_summarizer, executed, hands the runner prd-change-summarizer and the story id', () => {
    const { d, scripts, dump } = stubbedScripts();
    const out = callThroughRealFile(scripts, d, `run_prd_change_summarizer FX-7 skill_note 'a note' 'too long'`);
    expect(existsSync(dump), `the runner was never invoked:\n${out.slice(-800)}`).toBe(true);
    expect(readFileSync(dump, 'utf8')).toContain('EPAM_AGENT_NAME=prd-change-summarizer EPAM_STORY_ID=FX-7');
  }, 180_000);
});
