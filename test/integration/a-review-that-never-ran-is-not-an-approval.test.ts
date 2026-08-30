/**
 * A REVIEW THAT NEVER RAN IS NOT AN APPROVED REVIEW.
 *
 * code-review-cycle.sh had three defects that compound into silence:
 *
 *   1. PRD_FILE="$AUTOMATION_DIR/prd.json" — assigned unconditionally, so the caller's PRD is
 *      ignored. That file holds {"stories":[],"implementationOrder":{}}: no stories at all.
 *      orchestrate.sh writes `PRD_FILE="${PRD_FILE:-...}"` and its comment records that a
 *      hardcoded default once synthesised one project's PRD into another's.
 *
 *   2. The "story not found" guard compares agentRole against the string "unknown". jq's `//`
 *      default applies when a key is null — NOT when the selector matches nothing. A story absent
 *      from the PRD yields an EMPTY string, so the guard never fires.
 *
 *   3. Falling past it prints "Story not completed yet, skipping review" and EXITS 0.
 *
 * Together: run it for any story and it reports success having reviewed nothing. A gate that
 * cannot find its subject must not report the outcome of examining it.
 *
 * Asserted by running the script and reading its exit code and whether a runner was reached.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LADDERS } from '../helpers/seam-receiver';

const REPO = join(__dirname, '../..');
const SCRIPT = join(REPO, 'orchestrations/scripts/code-review-cycle.sh');

interface Story { id: string; completed?: boolean }

/** Run the review cycle against a PRD we control, with the runner stubbed. */
function runReview(storyId: string, stories: Story[]) {
  const work = mkdtempSync(join(tmpdir(), 'review-cycle-'));
  const repo = join(work, 'repo');
  mkdirSync(repo, { recursive: true });
  spawnSync('bash', ['-c',
    `cd ${JSON.stringify(repo)} && git init -q . && echo x > a.js && git add -A `
    + `&& git -c user.email=t@t -c user.name=t commit -qm init`], { encoding: 'utf8' });

  const prd = join(work, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    project: { name: 'fixture' },
    stories: stories.map((s) => ({
      id: s.id, title: `story ${s.id}`, agentRole: 'typescript-engineer',
      completed: s.completed === true, codeline: 'alphashop',
      // The prompt refuses any declared placeholder that renders empty — correctly, because an
      // agent cannot tell a failed lookup from a genuinely absent one. These are values a real
      // story carries; __PRIOR_CONTEXT__ is the one that is legitimately absent on iteration 1,
      // and the template now declares it as such.
      description: 'the confirm email field is case sensitive',
      acceptanceCriteria: ['the confirm email field accepts any case'],
      technicalNotes: { files: ['a.js'] },
    })),
    implementationOrder: { core: stories.map((s) => s.id) },
  }));

  const argvLog = join(work, 'argv.log');
  const stub = join(work, 'stub');
  writeFileSync(stub, [
    '#!/usr/bin/env bash',
    `printf -- '--CALL--\\n' >> ${JSON.stringify(argvLog)}`,
    'cat > /dev/null',
    `printf '%s' '{"verdict":"APPROVE","issues":[]}'`,
    '',
  ].join('\n'));
  chmodSync(stub, 0o755);

  const proj = join(work, 'proj');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'llm-settings.json'), '{}');
  // The reviewer refuses to run "with an identity nobody chose" — correctly — so the fixture has
  // to supply the roster a run would have minted. Personas are deliberately generic: no project
  // fact belongs in a test of the generic pipeline.
  writeFileSync(join(proj, 'roster.json'), JSON.stringify({
    agents: {
      'review-agent': {
        persona: 'You review a change against its acceptance criteria and emit a verdict.',
        kind: 'reviewer',
      },
      'typescript-engineer': {
        persona: 'You implement the story in the codeline you are given.',
        kind: 'implementer',
      },
    },
  }));
  // The seam renders from THIS PROJECT's copy of its prompt, and refuses without one — correctly.
  // A run generates that copy by specialising the immutable template; for a receiver test the
  // TEMPLATE ITSELF is a valid copy, because what is being exercised is the code path, not the
  // specialisation. No model call, no project fact.
  mkdirSync(join(proj, 'prompts'), { recursive: true });
  const tpl = join(REPO, 'orchestrations/prompts/templates/code-review-cycle.json');
  if (existsSync(tpl)) writeFileSync(join(proj, 'prompts/code-review-cycle.json'), readFileSync(tpl, 'utf8'));

  const r = spawnSync('bash', [SCRIPT, storyId], {
    encoding: 'utf8', timeout: 120000, cwd: REPO,
    env: {
      ...process.env, ...LADDERS,
      EPAM_PROVIDER_SET: 'claude',
      PRD_FILE: prd, PROJECT_ROOT: repo, LOG_DIR: work,
      EPAM_PROJECT_CONFIG_DIR: proj,
      CLAUDE_CMD: stub, AI_RUNNER_CMD: stub,
    },
  });
  return {
    code: r.status ?? -1,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    runnerCalls: existsSync(argvLog)
      ? readFileSync(argvLog, 'utf8').split('--CALL--').length - 1 : 0,
  };
}

describe('a review that never ran is not an approved review', () => {
  it('the caller\'s PRD is the one it reads', () => {
    // Defect 1. With PRD_FILE ignored it reads a global file holding no stories, so every story
    // looks absent however the caller was invoked.
    const r = runReview('S-1', [{ id: 'S-1', completed: true }]);
    expect(r.out, 'the script did not find the story in the PRD it was handed')
      .not.toMatch(/not found|no agent assigned/i);
  }, 120_000);

  it('a completed story actually reaches a reviewer', () => {
    const r = runReview('S-1', [{ id: 'S-1', completed: true }]);
    expect(r.runnerCalls, `no reviewer was invoked at all:\n${r.out.slice(-500)}`)
      .toBeGreaterThan(0);
  }, 120_000);

  it('a story that is not in the PRD is an ERROR, not a skip', () => {
    // Defect 2. `.agentRole // "unknown"` yields "" when the selector matches nothing, so the
    // not-found guard never fires and the run continues into the completed check.
    const r = runReview('S-MISSING', [{ id: 'S-1', completed: true }]);
    expect(r.code, 'a story absent from the PRD exited 0 — indistinguishable from a clean review')
      .not.toBe(0);
    expect(r.out, 'the message does not say the story was not found')
      .toMatch(/not found|no agent assigned/i);
  }, 120_000);

  it('an incomplete story does not report success', () => {
    // Defect 3. Skipping is legitimate; reporting it as exit 0 is what makes it invisible to the
    // caller that has to decide whether the gate ran.
    const r = runReview('S-1', [{ id: 'S-1', completed: false }]);
    expect(r.out, 'it did not say why it skipped').toMatch(/not completed|skipping/i);
    expect(r.code, 'a review that was skipped exited 0, so a caller cannot tell it from a pass')
      .not.toBe(0);
  }, 120_000);
});
