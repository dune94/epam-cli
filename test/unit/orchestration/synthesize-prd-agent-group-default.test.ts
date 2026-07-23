/**
 * synthesize-prd-from-jira.js — single-ticket JQL scopes must default new
 * stories to agentGroup:"main", not "primary".
 *
 * Bug found 2026-07-23 while preparing a real Metrolinx launch: AMSD-1820
 * (JIRA_JQL="issue = AMSD-1820", permanently a single-ticket scope per
 * project_metrolinx_target_story) synthesized with agentGroup:"primary" —
 * a worktree lane — even though there was exactly one story and zero real
 * parallelism to gain. Whether a single story in a "primary"/"independent"
 * lane actually runs as a worktree (Steps 13-17) or gets collapsed back
 * into a plain main-branch story depends on a live, non-deterministic
 * topology-router LLM call (run-agent-orchestration.sh) — the same
 * mechanism behind a worktree-merge hang found the same day. Defaulting a
 * single-story classification set to "main" removes that dependency
 * entirely: a lone story never needs a worktree lane regardless of what
 * the router decides, since need_worktrees is false when
 * primary_stories/independent_stories are both empty from the start.
 *
 * Multi-story classification sets keep the previous "primary" default —
 * real parallel work still gets worktree lanes.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/synthesize-prd-from-jira.js');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';

function runSynthesize(classifications: unknown[], template: object): any {
  const dir = mkdtempSync(join(tmpdir(), 'synth-prd-test-'));
  try {
    const classificationsPath = join(dir, 'classifications.json');
    const templatePath = join(dir, 'template.json');
    const outPath = join(dir, 'out-prd.json');
    writeFileSync(classificationsPath, JSON.stringify(classifications));
    writeFileSync(templatePath, JSON.stringify(template));
    execFileSync(NODE20, [SCRIPT, '--classifications', classificationsPath, '--template', templatePath, '--out', outPath], {
      encoding: 'utf8',
    });
    return JSON.parse(readFileSync(outPath, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE_TEMPLATE = { project: { outputDir: '/tmp/does-not-matter' }, stories: [] };

describe('synthesize-prd-from-jira.js — agentGroup default depends on classification-set size', () => {
  it('a single-ticket classification set (e.g. AMSD-1820-style JQL) defaults its one story to agentGroup:"main"', () => {
    const prd = runSynthesize(
      [{ storyId: 'AMSD-1820', jiraKey: 'AMSD-1820', title: 'Fix promo code display', codeline: 'cdts', originalAcs: ['AC1'] }],
      BASE_TEMPLATE
    );
    expect(prd.stories).toHaveLength(1);
    expect(prd.stories[0].agentGroup).toBe('main');
  });

  it('a multi-ticket classification set still defaults new stories to agentGroup:"primary" (real parallelism preserved)', () => {
    const prd = runSynthesize(
      [
        { storyId: 'AMSD-100', jiraKey: 'AMSD-100', title: 'Story A', codeline: 'cdts', originalAcs: ['AC1'] },
        { storyId: 'AMSD-101', jiraKey: 'AMSD-101', title: 'Story B', codeline: 'cdts', originalAcs: ['AC1'] },
      ],
      BASE_TEMPLATE
    );
    expect(prd.stories).toHaveLength(2);
    for (const story of prd.stories) {
      expect(story.agentGroup).toBe('primary');
    }
  });

  it('an explicit template agentGroup always wins over the size-based default, single or multi-ticket', () => {
    const template = { ...BASE_TEMPLATE, stories: [{ id: 'AMSD-1820', agentGroup: 'independent' }] };
    const prd = runSynthesize(
      [{ storyId: 'AMSD-1820', jiraKey: 'AMSD-1820', title: 'Fix promo code display', codeline: 'cdts', originalAcs: ['AC1'] }],
      template
    );
    expect(prd.stories[0].agentGroup).toBe('independent');
  });

  it('a story split across codelines (agentGroup forced "primary" by design) stays "primary" regardless of the size-based default', () => {
    // allCodelines is derived from non-split classifications in the same
    // batch (synthesize-prd-from-jira.js:59-63) — a lone "both"-tagged
    // ticket with nothing else in the batch has no codeline to split
    // across, so a second, ordinary ticket seeds "be"/"fe".
    const prd = runSynthesize(
      [
        { storyId: 'AMSD-1820', jiraKey: 'AMSD-1820', title: 'Cross-codeline fix', codeline: 'both', originalAcs: ['AC1'], beAcs: ['BE1'], feAcs: ['FE1'] },
        { storyId: 'AMSD-200', jiraKey: 'AMSD-200', title: 'Unrelated BE story', codeline: 'be', originalAcs: ['AC1'] },
        { storyId: 'AMSD-201', jiraKey: 'AMSD-201', title: 'Unrelated FE story', codeline: 'fe', originalAcs: ['AC1'] },
      ],
      BASE_TEMPLATE
    );
    const splitStories = prd.stories.filter((s: any) => s.jiraKey === 'AMSD-1820');
    expect(splitStories.length).toBeGreaterThan(1);
    for (const story of splitStories) {
      expect(story.agentGroup).toBe('primary');
    }
  });
});
