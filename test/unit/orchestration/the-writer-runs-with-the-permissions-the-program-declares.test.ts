/**
 * THE WRITER RUNS WITH THE PERMISSIONS THE PROGRAM DECLARES — AND ITS STANDING INSTRUCTIONS
 * TRAVEL ON ONE CHANNEL.
 *
 * 771993fc (2026-09-16) removed CLAUDE_PERMISSIONS from claude.sh as "assigned here and never
 * read" — per-file shellcheck reported SC2034. It is read by lib/story-attempt.sh, a module of
 * the same program: implement_story builds `effective_permissions` from it. From that release
 * every writer on the claude set ran without --dangerously-skip-permissions and without the
 * agent constitution; every write was refused ("you haven't granted it yet"), the writer
 * reported the wall, and the story failed after 8 attempts. regintel 20260916T200108Z spent
 * three resumes on it (2026-09-17) before the cause was read off the runner's own refusal.
 *
 * 2026-09-30 (operator: "Ensure each provider has a proper agent si transit"): the writer's
 * standing instructions — its role SI, the pipeline-wide constitution, this story's dynamic rules
 * and output schema — are composed into ONE file and travel on the channel its runner declares
 * (runners.<name>.siChannel). The constitution no longer rides a second flag: Claude Code refuses
 * `--append-system-prompt` together with `--append-system-prompt-file` ("Cannot use both").
 *
 * Asserted at the receiver: the reassembled program's own block is EXECUTED with the real
 * resolver (lib/agent-si.js) and the real runner-settings, and the argv the runner would be given
 * — and the file it names — is what is judged. Expected text is read from the declarations.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const CLAUDE_SH = join(SCRIPTS, 'claude.sh');
// The node this suite runs on — the pipeline's own runtime, never a path written here.
const NODE_BIN = process.execPath;
const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles;
const CONTRACT = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/agent-contract.json'), 'utf8'));
const SETS = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8'));
const SET: string = SETS.defaultSet;
const SET_RUNNERS = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config', SETS.sets[SET].settingsFile), 'utf8')).runners || {};
const RUNNER = Object.keys(SET_RUNNERS).find((r) => SET_RUNNERS[r].siChannel && SET_RUNNERS[r].siChannel.flag) as string;
const SI_FLAG: string = SET_RUNNERS[RUNNER].siChannel.flag;
const firstLine = (s: string) => s.split('\n').find((l) => l.trim().length > 20) as string;

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const src = engineSource(CLAUDE_SH);
const WRITER_SEAM = (/\nSTORY_WRITER_SEAM="([^"]+)"/.exec(src) || [])[1] as string;

/** The program's own declaration of the permission flags, and the interactive-mode clearing. */
function declaration(): { decl: string; clears: boolean } {
  const start = src.indexOf('\nCLAUDE_PERMISSIONS=(');
  expect(start, 'CLAUDE_PERMISSIONS is not declared in the program — the writer runs with no permissions').toBeGreaterThan(-1);
  const end = src.indexOf('\n)\n', start);
  return { decl: src.slice(start + 1, end + 2), clears: /if \[ "\$interactive_mode" = true \]; then\n\s+CLAUDE_PERMISSIONS=\(\)/.test(src) };
}

/** implement_story's block that composes the writer's SI and turns the declaration into the runner's flags. */
function block(): string {
  const start = src.indexOf("    # THE WRITER'S STANDING INSTRUCTIONS");
  expect(start, 'the writer SI block is not in implement_story').toBeGreaterThan(-1);
  // The CALL, not a comment that names it.
  const m = /\n[ \t]*[^#\n]*\bapply_runner_settings\b[^\n]*/.exec(src.slice(start));
  expect(m, 'implement_story no longer applies the runner settings').toBeTruthy();
  return src.slice(start, start + (m as RegExpExecArray).index + (m as RegExpExecArray)[0].length);
}

/** The constitution rules as the run fills them: the catalog's own values, and this run's root. */
const filled = (root: string) => (CONTRACT.constitution.rules as string[]).map((r) =>
  r.replace(/\{(\w+)\}/g, (w, k) => (k in CONTRACT && typeof CONTRACT[k] === 'string' ? CONTRACT[k] : k === 'projectRoot' ? root : w)));

function runWriter(opts: { permissions: 'declared' | 'cleared'; roster?: unknown }) {
  const work = mkdtempSync(join(tmpdir(), 'writer-si-')); dirs.push(work);
  const logs = join(work, 'logs'); const proj = join(work, 'proj'); const root = join(work, 'codeline');
  for (const d of [logs, proj, root]) mkdirSync(d, { recursive: true });
  if (opts.roster !== undefined) writeFileSync(join(proj, 'roster.json'), JSON.stringify(opts.roster));
  const prd = join(work, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1' }] }));
  const script = [
    'set -uo pipefail', 'log(){ :; }', 'error(){ printf "%s\\n" "$*" >&2; }', 'log_error(){ error "$@"; }',
    `. ${JSON.stringify(join(SCRIPTS, 'lib/runner-settings.sh'))}`,
    `runner_name_for(){ printf %s ${JSON.stringify(RUNNER)}; }`,
    `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}`, `NODE_BIN=${JSON.stringify(NODE_BIN)}`, `LOG_DIR=${JSON.stringify(logs)}`,
    `MAIN_PRD_FILE=${JSON.stringify(prd)}`, `PRD_FILE=${JSON.stringify(prd)}`, `PROJECT_ROOT=${JSON.stringify(root)}`,
    `STORY_WRITER_SEAM=${JSON.stringify(WRITER_SEAM)}`, 'STORY_PROVIDER=""', 'CLAUDE_CMD=""',
    'DYNAMIC_CONSTITUTION=$\'\\nDYNAMIC RULE MARKER\'', 'schema_block=$\'\\nSCHEMA BLOCK MARKER\'',
    opts.permissions === 'declared' ? declaration().decl : 'CLAUDE_PERMISSIONS=()',
    'implement(){', '    local story_id=S-1', block(),
    '    printf "%s\\n" "${effective_permissions[@]}" "${RUNNER_FLAGS[@]}"', '}', 'implement',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8',
    env: { ...process.env, EPAM_PROVIDER_SET: SET, EPAM_PROJECT_CONFIG_DIR: proj, NODE_BIN } });
  const argv = (r.stdout || '').split('\n').filter(Boolean);
  const i = argv.indexOf(SI_FLAG);
  const file = i >= 0 ? argv[i + 1] : '';
  return { r, argv, file, content: file && existsSync(file) ? readFileSync(file, 'utf8') : '', logs, root };
}

describe('the writer runs with the permissions the program declares', () => {
  it('the declaration names the skip-permissions flag, carries no second system-prompt channel, and interactive mode clears it', () => {
    const { decl, clears } = declaration();
    expect(decl).toMatch(/--dangerously-skip-permissions/);
    expect(decl, 'the declaration still appends the constitution on a flag Claude Code refuses beside the SI file').not.toMatch(/--append-system-prompt/);
    expect(clears, 'interactive mode no longer clears the flags').toBe(true);
  });

  it('EXECUTED: the writer is handed skip-permissions and ONE SI file — role SI, constitution, dynamic rules, schema', () => {
    const w = runWriter({ permissions: 'declared' });
    expect(w.r.status, w.r.stderr).toBe(0);
    expect(w.argv).toContain('--dangerously-skip-permissions');
    expect(w.argv, 'claude refuses both system-prompt flags together').not.toContain('--append-system-prompt');
    expect(w.file, `the writer's SI did not reach the runner on ${SI_FLAG}: ${w.argv.join(' ')}`).toBeTruthy();
    expect(w.content.startsWith(reg[WRITER_SEAM].si), 'the file does not open with the writer seam\'s SI').toBe(true);
    for (const rule of filled(w.root)) expect(w.content).toContain(rule);
    expect(w.content).toContain('DYNAMIC RULE MARKER');
    expect(w.content).toContain('SCHEMA BLOCK MARKER');
    expect(w.content, 'a placeholder was left unfilled').not.toMatch(/\{\w+\}/);
  });

  it('EXECUTED: ONLY the writer\'s SI — no other seam\'s standing instructions travel with it', () => {
    const w = runWriter({ permissions: 'declared' });
    expect(w.content.length).toBeGreaterThan(0);
    for (const [seam, p] of Object.entries<any>(reg)) {
      if (seam === WRITER_SEAM || !p.si) continue;
      expect(w.content.includes(firstLine(p.si)), `${seam}'s SI travelled with the writer`).toBe(false);
    }
  });

  it('EXECUTED: the composed SI is persisted in the run\'s logs, where teardown of the attempt cannot take it', () => {
    const w = runWriter({ permissions: 'declared' });
    expect(w.file.startsWith(w.logs), `${w.file} is not under LOG_DIR`).toBe(true);
    expect(existsSync(w.file)).toBe(true);
  });

  it('EXECUTED: a roster that cannot answer the writer refuses the attempt — no runner flags, no silent base', () => {
    const w = runWriter({ permissions: 'declared', roster: { agents: {} } });
    expect(w.r.status).not.toBe(0);
    expect(w.argv).not.toContain(SI_FLAG);
    expect(w.r.stderr).toMatch(/standing instructions/);
  });

  it('EXECUTED: with the declaration cleared (interactive mode) no permission flags — the SI still travels', () => {
    const w = runWriter({ permissions: 'cleared' });
    expect(w.r.status, w.r.stderr).toBe(0);
    expect(w.argv).not.toContain('--dangerously-skip-permissions');
    expect(w.argv).toContain(SI_FLAG);
  });
});
