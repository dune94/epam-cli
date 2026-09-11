/**
 * THE REHEARSAL MUST RUN ON A TREE THAT HAS NEVER RUN.
 *
 * brownfield-mock-e2e provisions its own MockServer before launching, and it needs one real
 * story shape to build the per-story stand-ins from. It read
 * `orchestrations/projects/mock3/prd.json` — the RUNTIME prd, which `.gitignore` excludes
 * (the `orchestrations/projects` per-project prd.json rule) because it is a run artefact that pre-run-reset
 * rewrites every launch.
 *
 * So the free rehearsal could only be started on a machine where some earlier run had already
 * left that file behind. On a fresh clone, and on every fresh `install.sh --dest`, the harness
 * died at readFileSync before MockServer was ever touched — the one confirmation path that
 * costs nothing was the one that needed a prior run to exist.
 *
 * pre-run-reset.sh states which file is the base state, in its own words: "its authored input
 * IS the base state". That file is tracked, is always present, and carries the same story
 * shape. This asserts the harness reads a file a fresh checkout actually has.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const HARNESS = join(REPO_ROOT, 'test/unit/orchestration/brownfield-mock-e2e.test.ts');

/** Every mock3 PRD path the rehearsal harness reads, as the harness itself spells them. */
function prdPathsReadByHarness(): string[] {
  const src = readFileSync(HARNESS, 'utf8');
  const out: string[] = [];
  const re = /readFileSync\(\s*join\(REPO_ROOT,\s*'([^']*projects\/mock3\/[^']*\.json)'\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

describe('a rehearsal cannot need a previous run', () => {
  it('reads at least one mock3 PRD — otherwise this test proves nothing', () => {
    expect(prdPathsReadByHarness().length).toBeGreaterThan(0);
  });

  it('every PRD the harness reads exists in a fresh checkout and is not a run artefact', () => {
    for (const rel of prdPathsReadByHarness()) {
      const abs = join(REPO_ROOT, rel);

      const ignored = spawnSync('git', ['check-ignore', rel], { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(ignored.status,
        `${rel} is gitignored — it is a run artefact, so a fresh clone cannot rehearse`).not.toBe(0);

      const tracked = spawnSync('git', ['ls-files', '--error-unmatch', rel],
        { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(tracked.status, `${rel} is not tracked by git — a fresh clone would not have it`).toBe(0);

      expect(existsSync(abs), `${rel} is missing from this tree`).toBe(true);
    }
  });

  it('the PRD it reads carries the story shape the stand-ins are built from', () => {
    for (const rel of prdPathsReadByHarness()) {
      const prd = JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      expect(Array.isArray(prd.stories) && prd.stories.length > 0,
        `${rel} declares no stories, so there is no shape to derive a stand-in from`).toBe(true);
      // The harness overrides id/jiraKey/codelines; everything else must come from the producer.
      for (const k of ['title', 'description', 'acceptanceCriteria']) {
        expect(prd.stories[0][k], `${rel} stories[0] has no ${k}`).toBeDefined();
      }
    }
  });
});
