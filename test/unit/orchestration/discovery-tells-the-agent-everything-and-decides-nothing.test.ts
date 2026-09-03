/**
 * THE DISCOVERY PROMPT AND ITS MANIFEST — the engine's job is to tell, not to decide.
 *
 * The manifest is the WHOLE estate, not a shortlist. The file's own history records what was
 * removed and why: an eligibility rule that removed repositories before the agent ever saw them; the
 * engine parsing manifests on the agent's behalf; recency arriving first as a scoring multiplier and
 * then as "facts" — the same judgement in a different hat, with a 90-day window nobody chose.
 *
 * The agent has read_file, list_files, search, codegraph_query and git_state. Everything the engine
 * used to assert is something the agent can establish itself, about the repositories it actually
 * cares about, rather than in the form the engine guessed at for all thirty-three in advance.
 *
 * And every field label is emitted even when the value is empty, because "this ticket declares no
 * components" and "this pipeline did not tell you the components" are different statements that an
 * agent cannot tell apart from an absent line.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildRepoManifest, buildDiscoveryPrompt } = require(join(S, 'lib/codeline-discovery.js'));

let provisioned = '';
const saved = process.env.EPAM_PROJECT_CONFIG_DIR;
beforeAll(async () => {
  const { provisionProject } = await import('../../helpers/provisioned-project');
  provisioned = (await provisionProject()).dir;
  process.env.EPAM_PROJECT_CONFIG_DIR = provisioned;
}, 120_000);
afterAll(() => { process.env.EPAM_PROJECT_CONFIG_DIR = saved; });

function estate(repos: string[], extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'estate-'));
  // A codeline IS a git repository: the unit a worktree is cut from and a change is committed to.
  // A directory that is not one cannot receive the work at all, so the manifest skips it — the shape
  // of the thing, not a judgement about relevance.
  for (const r of repos) {
    mkdirSync(join(root, r, '.git'), { recursive: true });
  }
  for (const [p, body] of Object.entries(extra)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

describe('the repo manifest is the whole estate, described by name and path only', () => {
  it('lists every repository, in a stable order', () => {
    const root = estate(['zeta', 'alpha', 'mid']);
    const m = buildRepoManifest(root);
    expect(m.map((r: any) => r.name), 'the estate was filtered, ranked or reordered')
      .toEqual(['alpha', 'mid', 'zeta']);
  }, 120_000);

  it('describes each ONLY by name and path — no stack, no dependencies, no recency', () => {
    // Every removed field was the engine forming a view of thirty-three repositories in advance and
    // handing it over as fact. The agent establishes these itself, for the ones it cares about.
    const root = estate(['repo-a'], { 'repo-a/package.json': '{"name":"a"}' });
    const [entry] = buildRepoManifest(root);
    expect(Object.keys(entry).sort(), 'the manifest carries the engine\'s judgement again')
      .toEqual(['name', 'path']);
  }, 120_000);

  it('does not filter out a repository that could not run its own gates', () => {
    // canRunItsOwnGates was an ELIGIBILITY RULE that removed repositories before the agent saw them.
    // A repository with no manifest at all still appears; deciding it is irrelevant is the agent's
    // job, not the engine's.
    const root = estate(['has-manifest', 'bare-repo'], { 'has-manifest/package.json': '{}' });
    expect(buildRepoManifest(root).map((r: any) => r.name),
      'a repository was removed from consideration before the agent saw it')
      .toEqual(['bare-repo', 'has-manifest']);
  }, 120_000);

  it('and NOTHING is excluded by name — no documentation-repository rule', () => {
    // A regex over directory names, /^docs\./i, deleted repositories before anything reasoned about
    // them. Relocating the literal to config did not make it project data: it stayed an engine
    // default asserting one client's naming habit over every project, and it failed in the direction
    // of doing less, silently, on a project whose product IS a documentation platform.
    const root = estate(['docs.portal', 'api']);
    expect(buildRepoManifest(root).map((r: any) => r.name),
      'a repository was deleted from the estate because of its name').toEqual(['api', 'docs.portal']);
  }, 120_000);

  it('an unreadable estate root is REFUSED, naming the variable that points at it', () => {
    // Returning an empty manifest would run discovery against nothing and report that no codeline
    // matched — a finding, rather than a missing input.
    expect(() => buildRepoManifest('/no/such/estate'))
      .toThrow(/JIRA_CODELINE_ROOT|Cannot read/);
  }, 120_000);

  it('an EMPTY estate yields an empty manifest rather than throwing', () => {
    expect(buildRepoManifest(estate([]))).toEqual([]);
  }, 120_000);
});

describe('the discovery prompt states every field, present or not', () => {
  const manifest = [{ name: 'be', path: '/e/be' }, { name: 'fe', path: '/e/fe' }];

  it('names every repository in the estate — nothing is shortlisted', () => {
    const p = buildDiscoveryPrompt([{ jiraKey: 'AMSD-1', title: 's', description: 'd' }], manifest);
    expect(p, 'a repository was omitted from the estate the agent is shown').toContain('be');
    expect(p).toContain('fe');
    expect(p).toContain('/e/be');
  }, 120_000);

  it('carries every field of the ticket', () => {
    const p = buildDiscoveryPrompt([{
      jiraKey: 'AMSD-1', title: 'the summary', description: 'the description',
      components: ['api'], labels: ['x'] }], manifest);
    expect(p).toContain('AMSD-1');
    expect(p).toContain('the summary');
    expect(p, 'the description — the only substantive content a brownfield ticket carries — is absent')
      .toContain('the description');
  }, 120_000);

  it('EMITS THE LABEL EVEN WHEN THE VALUE IS EMPTY', () => {
    // "This ticket declares no components" and "this pipeline did not tell you the components" are
    // different statements, and an agent cannot tell them apart from an absent line.
    const withValue = buildDiscoveryPrompt([{ jiraKey: 'A-1', title: 's', components: ['api'] }], manifest);
    const without = buildDiscoveryPrompt([{ jiraKey: 'A-1', title: 's' }], manifest);
    const label = /components/i;
    expect(label.test(withValue), 'the components label is missing when there ARE components').toBe(true);
    expect(label.test(without),
      'the components label vanished when empty, so the agent cannot tell absent from unstated')
      .toBe(true);
  }, 120_000);

  it('accepts components as objects OR strings — Jira returns objects, callers normalise', () => {
    // Assuming one shape produces [object Object] in the prompt, or drops the field.
    const objs = buildDiscoveryPrompt(
      [{ jiraKey: 'A-1', title: 's', components: [{ name: 'api' }, { name: 'web' }] }], manifest);
    expect(objs, 'component objects were rendered as [object Object]').not.toContain('[object Object]');
    expect(objs).toContain('api');
    const strs = buildDiscoveryPrompt([{ jiraKey: 'A-1', title: 's', components: ['api'] }], manifest);
    expect(strs).toContain('api');
  }, 120_000);

  it('several tickets all appear', () => {
    const p = buildDiscoveryPrompt([
      { jiraKey: 'A-1', title: 'one' }, { jiraKey: 'A-2', title: 'two' }], manifest);
    expect(p).toContain('A-1');
    expect(p, 'the second ticket was dropped').toContain('A-2');
  }, 120_000);
});
