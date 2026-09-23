/**
 * A SPLIT MUST LEAVE THE DEPENDENCY GRAPH TRUE.
 *
 * Found in the regintel PRD, 2026-09-22: the run split oversized stories into children and
 * deprecated the parents, but every edge that pointed at a parent was left pointing at it —
 * ELEVEN of seventeen active stories:
 *
 *   REGI-002   -> REGI-001 (deprecated)      REGI-004-A -> REGI-003 (deprecated)
 *   REGI-009a  -> REGI-005 (deprecated)      REGI-010-B -> REGI-009 (deprecated)   ...
 *
 * Nothing blocked, because a deprecated dependency reads as satisfied ("+ Dependency REGI-003
 * satisfied (completed)" in the run log) — so the PRD stopped expressing what any story actually
 * depends on, silently. REGI-009a's real prerequisite is the dedup the CHILDREN implement; its
 * declared one is a shell.
 *
 * speckit-split-rules.json already tells the splitting agent how children depend on each other.
 * It says nothing about the stories that depended on the parent, and manifest.schema.json does
 * not mention `dependencies` at all — so the graph was never a contracted field, and no audit
 * looked at it.
 *
 * This executes the REAL integrity audit against a PRD in exactly that state.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const AUDIT = join(REPO_ROOT, 'orchestrations/scripts/lib/handlers/prd-integrity-audit.py');
const PROVIDERS = join(REPO_ROOT, 'orchestrations/config/providers.json');

/** A PRD after a split: the parent is deprecated, a child carries the work, and another
 *  story still names the parent. The shape the live PRD is in, minimised. */
function splitPrd() {
  const base = (id: string, extra: Record<string, unknown>) => ({
    id, title: id, phase: 'core', status: 'pending', effort: 'low', dependencies: [],
    acceptanceCriteria: ['x'], technicalNotes: { files: [`${id}.py`] }, aiProvider: 'openrouter', ...extra,
  });
  return {
    project: { outputDir: '/tmp/split-fixture' },
    implementationOrder: { scaffold: ['P-000'], core: ['P-001a', 'P-002'] },
    stories: [
      base('P-000', {}),
      // the parent the split retired
      base('P-001', { status: 'deprecated' }),
      // the child that carries its work
      base('P-001a', {}),
      // the consumer that still names the parent — the live shape
      base('P-002', { dependencies: ['P-001'] }),
    ],
  };
}

function audit(prd: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'prd-dep-'));
  try {
    const p = join(dir, 'prd.json');
    writeFileSync(p, JSON.stringify(prd));
    const r = spawnSync('python3', [AUDIT, 'core', p, PROVIDERS], { encoding: 'utf8', timeout: 20000 });
    return { out: (r.stdout || '') + (r.stderr || ''), status: r.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a split leaves no story depending on a shell', () => {
  it('reports a dependency on a deprecated story, naming both ends', () => {
    const { out } = audit(splitPrd());
    expect(out, 'the stale edge P-002 -> P-001 was not reported at all').toMatch(/P-002/);
    expect(out).toMatch(/P-001/);
    expect(out.toLowerCase()).toMatch(/deprecated/);
  });

  it('REPORTS but does not REFUSE — the remedy is the splitting agent\'s, and brownfield builds its PRD at run time', () => {
    // A refusal here would block a launch over a graph nothing outside the agent can repair, and
    // a deprecated dependency reads as satisfied either way: the PRD is misleading, not unsafe.
    const { status, out } = audit(splitPrd());
    expect(status, `the audit refused a launch over a reported edge: ${out.slice(-300)}`).toBe(0);
  });

  it('a dependency naming a story that does not exist is reported', () => {
    const prd = splitPrd() as any;
    prd.stories.find((x: any) => x.id === 'P-002').dependencies = ['P-999'];
    const { out } = audit(prd);
    expect(out).toMatch(/P-999/);
  });

  it('a graph that names only live stories passes', () => {
    const prd = splitPrd() as any;
    prd.stories.find((x: any) => x.id === 'P-002').dependencies = ['P-001a'];  // re-pointed onto the child, as a split must
    const { out, status } = audit(prd);
    expect(status, `a correct graph was rejected: ${out}`).toBe(0);
  });
});

/**
 * The other half: the split itself must re-point the edges, using what the SPLITTING AGENT
 * declared — the engine never guesses which child inherited which part.
 */
describe('a split re-points the edges the agent named', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { rewireDependenciesOnSplit } = require(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'));

  const prdAfterSplit = () => ({
    stories: [
      { id: 'P-001', status: 'deprecated', dependencies: [] },
      { id: 'P-001a', status: 'pending', dependencies: [] },
      { id: 'P-001b', status: 'pending', dependencies: [] },
      { id: 'P-002', status: 'pending', dependencies: ['P-001', 'X-9'] },
    ],
  });

  it('moves a dependent story onto the child the agent named, keeping its other edges', () => {
    const prd = prdAfterSplit();
    rewireDependenciesOnSplit(prd, 'P-001', ['P-001a', 'P-001b'], [{ story: 'P-002', dependsOn: ['P-001b'] }]);
    const p2 = prd.stories.find((s: any) => s.id === 'P-002')!;
    expect(p2.dependencies, 'the edge still points at the retired parent').not.toContain('P-001');
    expect(p2.dependencies).toContain('P-001b');
    expect(p2.dependencies, 'an unrelated edge was lost').toContain('X-9');
  });

  it('LEAVES an edge alone when the agent declared nothing for it — no guess', () => {
    const prd = prdAfterSplit();
    rewireDependenciesOnSplit(prd, 'P-001', ['P-001a', 'P-001b'], []);
    const p2 = prd.stories.find((s: any) => s.id === 'P-002')!;
    expect(p2.dependencies, 'the engine invented a child to point at').toEqual(['P-001', 'X-9']);
  });

  it('does not touch stories that never depended on the parent', () => {
    const prd = prdAfterSplit();
    rewireDependenciesOnSplit(prd, 'P-001', ['P-001a'], [{ story: 'P-001a', dependsOn: ['P-001b'] }]);
    expect(prd.stories.find((s: any) => s.id === 'P-001a')!.dependencies).toEqual([]);
  });
});
