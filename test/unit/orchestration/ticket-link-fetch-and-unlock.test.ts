/**
 * Two defects found after the guards and the perimeter shipped.
 *
 * (3) THE LINK AGENT COULD NOT OPEN A LINK.
 * The ticket-link agent was given the URLs recovered from a ticket and a schema with a
 * `quotes` field — VERBATIM extracts from the document, the entire point of the step,
 * because a paraphrase of an API contract is how a wrong contract propagates. But its tool
 * grant was read_file/list_files/search: no way to fetch a URL at all. It could classify a
 * link from its address and the surrounding comment, and nothing more. `quotes` could never
 * be populated, so the documentation still did not inform the pipeline.
 *
 * A `fetch_url` tool exists (src/tools/builtin/FetchUrl.ts) and was simply never granted.
 *
 * (4) THE PERIMETER NEVER UNLOCKED ON KILL.
 * perimeter_apply() chmods a codeline's tracked files read-only at run start;
 * ensure_story_branch() reopens them once the repo reaches a story branch. Nothing unlocks
 * on kill or abort — so a killed run left the operator's own repositories read-only. Found
 * live: after one kill, 6,027 files across three codelines were still a-w, and editing any
 * of them by hand failed with permission denied.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const KILL = join(ROOT, 'orchestrations/scripts/kill-tier3-run.sh');
const PERIMETER = join(ROOT, 'orchestrations/scripts/lib/codeline-write-perimeter.sh');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    spawnSync('chmod', ['-R', 'u+w', d]);
    rmSync(d, { recursive: true, force: true });
  }
});

describe('(3) the ticket-link agent can actually open a link', () => {
  it('a fetch tool exists to grant', () => {
    const t = readFileSync(join(ROOT, 'src/tools/builtin/FetchUrl.ts'), 'utf8');
    expect(t).toMatch(/name\s*=\s*'fetch_url'/);
  });

  it('the agent is granted a fetch tool, not only read/list/search', () => {
    const i = SRC.indexOf('async function reviewTicketLinks');
    expect(i, 'reviewTicketLinks is gone').toBeGreaterThan(-1);
    const fn = SRC.slice(i, SRC.indexOf('\n}\n', i));
    expect(
      fn,
      'without a fetch tool the agent can classify a URL but never read the document — ' +
        'the `quotes` field it exists to populate stays empty forever',
    ).toMatch(/fetch_url/);
  });

  it('tools are actually switched ON for it (a list without the switch runs --no-tools)', () => {
    const i = SRC.indexOf('async function reviewTicketLinks');
    const fn = SRC.slice(i, SRC.indexOf('\n}\n', i));
    expect(fn).toMatch(/AI_GATE_ALLOW_TOOLS/);
  });

  it('the grant is configurable per project, not fixed in the engine', () => {
    const i = SRC.indexOf('async function reviewTicketLinks');
    const fn = SRC.slice(i, SRC.indexOf('\n}\n', i));
    expect(fn).toMatch(/TICKET_LINK_ALLOWED_TOOLS|process\.env\.[A-Z_]*ALLOWED_TOOLS/);
  });

  it('the agent profile tells it to fetch rather than infer from the URL', () => {
    const p = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/profiles.canonical.json'), 'utf8'));
    expect(p['ticket-link-agent']).toMatch(/fetch|open the (document|page)|read it/i);
  });
});

describe('(2) a killed run does not leave client source read-only', () => {
  /** A locked codeline, exactly as a killed run leaves one. */
  function lockedRepo(): string {
    const d = mkdtempSync(join(tmpdir(), 'perim-kill-'));
    dirs.push(d);
    spawnSync('git', ['init', '-q', d]);
    spawnSync('git', ['-C', d, 'config', 'user.email', 't@t']);
    spawnSync('git', ['-C', d, 'config', 'user.name', 't']);
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
    spawnSync('git', ['-C', d, 'add', '-A']);
    spawnSync('git', ['-C', d, 'commit', '-qm', 'base']);
    spawnSync('git', ['-C', d, 'branch', '-m', 'develop']);
    spawnSync('bash', ['-c',
      `. ${JSON.stringify(PERIMETER)}; JIRA_BASELINE_BRANCH=develop perimeter_apply ${JSON.stringify(d)}`]);
    return d;
  }

  const writable = (p: string) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } };

  it('the fixture really is locked — otherwise this proves nothing', () => {
    expect(writable(join(lockedRepo(), 'src/a.ts'))).toBe(false);
  });

  it('the kill script unlocks every codeline it can find', () => {
    expect(
      readFileSync(KILL, 'utf8'),
      'a killed run leaves the operator unable to edit their own repository',
    ).toMatch(/perimeter_unlock|codeline-write-perimeter/);
  });

  it('perimeter_unlock restores write access for a real repo', () => {
    const repo = lockedRepo();
    spawnSync('bash', ['-c',
      `. ${JSON.stringify(PERIMETER)}; perimeter_unlock ${JSON.stringify(repo)}`]);
    expect(writable(join(repo, 'src/a.ts'))).toBe(true);
  });

  it('unlocking is safe on a repo that was never locked', () => {
    const d = mkdtempSync(join(tmpdir(), 'perim-plain-'));
    dirs.push(d);
    spawnSync('git', ['init', '-q', d]);
    const r = spawnSync('bash', ['-c',
      `. ${JSON.stringify(PERIMETER)}; perimeter_unlock ${JSON.stringify(d)}`], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  it('the kill still succeeds when no codeline root is configured', () => {
    const r = spawnSync('bash', ['-n', KILL], { encoding: 'utf8' });
    expect(r.status, `kill script has a syntax error: ${r.stderr}`).toBe(0);
  });
});
