import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A RESUME MUST NOT DESTROY THE WORK IT IS RESUMING.
 *
 * brownfield-preflight-reset.sh runs `git reset --hard <baseline>`, which MOVES THE
 * BRANCH POINTER — it discards commits, not merely working-tree edits. tier3-metrolinx-run.sh
 * calls it unconditionally at launcher start, with no guard on EPAM_RESUME_RUN.
 *
 * On a fresh run that is correct: a commit from an incomplete run is provisional.
 *
 * On a RESUME it is a contradiction. The checkpoint records the writer as completed, so the
 * resume SKIPS the writer — and then the launcher deletes the writer's commit, with nothing
 * left to recreate it. Observed live 2026-09-02: run 20260902T022134Z's fix (46986cb3) was
 * erased by a launch, and survived only because the commit object was still reachable
 * through the reflog.
 *
 * The reset must decline when this launch is resuming a run.
 */
describe('brownfield-preflight-reset, when the launch is a resume', () => {
  const script = path.resolve(__dirname, '../../../orchestrations/scripts/brownfield-preflight-reset.sh');
  let repo: string;
  let storySha: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-reset-'));
    git(repo, 'init', '-q', '-b', 'develop');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'baseline');

    // the story branch carries the writer's committed fix
    git(repo, 'checkout', '-q', '-b', 'bugfix/AI-STORY-1');
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const x = 2; // the fix\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'STORY-1: the writer fix');
    storySha = git(repo, 'rev-parse', 'HEAD');
  });

  it('does not discard the writer commit when EPAM_RESUME_RUN is set', () => {
    const r = spawnSync('bash', [script, repo], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        EPAM_RESUME_RUN: '20260902T022134Z',   // THIS launch is resuming a run
        JIRA_BASELINE_BRANCH: 'develop',
      },
    });

    // Guard against a vacuous pass: the script must actually have run.
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out.length, 'the reset script produced no output at all').toBeGreaterThan(0);

    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(
      head,
      `the resume reset the codeline and destroyed the writer commit.\n--- script output ---\n${out}`,
    ).toBe(storySha);

    // and the fix itself must still be on disk
    expect(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8')).toContain('the fix');
  });

  it("STILL resets on a fresh launch — a deliberate clean redo of the writer is unaffected", () => {
    // Rebuild the fixture: the previous test left it at the story commit.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-reset-"));
    execFileSync("git", ["-C", fresh, "init", "-q", "-b", "develop"]);
    execFileSync("git", ["-C", fresh, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", fresh, "config", "user.name", "T"]);
    fs.writeFileSync(path.join(fresh, "app.ts"), "export const x = 1;\n");
    execFileSync("git", ["-C", fresh, "add", "-A"]);
    execFileSync("git", ["-C", fresh, "commit", "-qm", "baseline"]);
    const baseSha = execFileSync("git", ["-C", fresh, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", fresh, "checkout", "-q", "-b", "bugfix/AI-STORY-1"]);
    fs.writeFileSync(path.join(fresh, "app.ts"), "export const x = 2; // provisional\n");
    execFileSync("git", ["-C", fresh, "add", "-A"]);
    execFileSync("git", ["-C", fresh, "commit", "-qm", "STORY-1: provisional"]);

    const env = { ...process.env, JIRA_BASELINE_BRANCH: "develop" };
    delete env.EPAM_RESUME_RUN;              // a FRESH launch

    const r = spawnSync("bash", [script, fresh], { encoding: "utf8", timeout: 120_000, env });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out.length, "the reset script produced no output at all").toBeGreaterThan(0);

    const head = execFileSync("git", ["-C", fresh, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(head, `a fresh launch must still reset to baseline.\n--- output ---\n${out}`).toBe(baseSha);
  });
});
