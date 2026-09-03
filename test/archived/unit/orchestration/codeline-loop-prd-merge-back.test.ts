/**
 * _run_codeline_loop()'s canonical-PRD merge-back — REAL execution of the
 * actual, unmodified node -e block from run-agent-orchestration.sh, against
 * fixture PRD files, fast and deterministic (no LLM calls, no full pipeline
 * run).
 *
 * Built 2026-07-23 after mock1's full pipeline run twice showed the
 * pipeline's own console output printing "MOCK-HW-1 ... [completed]" while
 * the canonical PRD the test read back afterward still showed
 * status:"pending", completed:false. Root cause: _run_codeline_loop makes a
 * per-codeline filtered temp copy (/tmp/orch-<cl>-prd-$$.json), all real
 * execution (claude.sh, TC-writer, completion writes) happens against that
 * temp copy, and the temp copy was deleted (`rm -f "${_cl_prds[@]}"`) with
 * no step ever writing its updated story state back into the canonical PRD.
 * This affects every Jira-driven run (_run_jira_pipeline always calls
 * _run_codeline_loop, single-codeline or not) — including real Metrolinx
 * AMSD-1820 runs, not just this mock.
 *
 * This test extracts the merge-back node block by marker (not
 * re-implemented) so it can never silently diverge from the real fix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const RUN_AGENT_ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(RUN_AGENT_ORCH, 'utf8');
const NODE_BIN = process.execPath;

function extractMergeBackScript(): string {
  const startMarker = '# Merge this codeline';
  const endMarker = "log \"[orch] Merged codeline '${_cl}' story state back into canonical PRD\"";
  const start = orchSrc.indexOf(startMarker);
  if (start === -1) throw new Error('merge-back comment marker not found — has the fix been removed/renamed?');
  const scriptStart = orchSrc.indexOf('"$NODE_BIN" -e "', start);
  const scriptBodyStart = orchSrc.indexOf('"\n', scriptStart) + 1;
  // Find the closing `"` of the -e "..." string: it's the line right before
  // the `2>/dev/null && log ...` tail.
  const tailIdx = orchSrc.indexOf(endMarker, start);
  if (tailIdx === -1) throw new Error('merge-back end marker not found');
  const closingQuoteIdx = orchSrc.lastIndexOf('"', tailIdx);
  const jsBody = orchSrc.slice(scriptBodyStart, closingQuoteIdx);
  return jsBody;
}

const mergeBackJs = extractMergeBackScript();

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runMergeBack(canonicalPrd: unknown, clPrd: unknown, codeline = 'be'): { canonicalPath: string; result: any; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prd-merge-back-'));
  cleanupDirs.push(dir);
  const canonicalPath = join(dir, 'canonical.json');
  const clPath = join(dir, 'cl.json');
  writeFileSync(canonicalPath, JSON.stringify(canonicalPrd, null, 2));
  writeFileSync(clPath, JSON.stringify(clPrd, null, 2));

  // Substitute the real script's bash variable interpolations
  // (${_prd_path}, ${_cl_prd}) with our fixture paths, same as bash would.
  const js = mergeBackJs
    .split('${_prd_path}').join(canonicalPath)
    .split('${_cl_prd}').join(clPath)
    // The merge itself now lives in lib/story-merge.js, so the extracted body has to
    // resolve the same require bash does — the real module, not a copy of it.
    .split('${SCRIPT_DIR}').join(join(__dirname, '../../../orchestrations/scripts'))
    .split('${_cl}').join(codeline);

  const proc = spawnSync(NODE_BIN, ['-e', js], { encoding: 'utf8' });
  const result = JSON.parse(readFileSync(canonicalPath, 'utf8'));
  return { canonicalPath, result, stderr: proc.stderr };
}

describe('_run_codeline_loop PRD merge-back (real extracted code)', () => {
  it('merges a completed story from the codeline temp copy back into the canonical PRD', () => {
    const canonical = { stories: [{ id: 'S1', status: 'pending', completed: false }] };
    const cl = { stories: [{ id: 'S1', status: 'completed', completed: true, completedAt: '2026-07-23T10:00:00Z' }] };
    const { result, stderr } = runMergeBack(canonical, cl);
    expect(stderr).toBe('');
    const s1 = result.stories.find((s: any) => s.id === 'S1');
    expect(s1.status).toBe('completed');
    expect(s1.completed).toBe(true);
    expect(s1.completedAt).toBe('2026-07-23T10:00:00Z');
  });

  it('leaves stories belonging to OTHER codelines untouched (multi-codeline PRD)', () => {
    const canonical = {
      stories: [
        { id: 'S1', status: 'pending', completed: false, codeline: 'be' },
        { id: 'S2', status: 'pending', completed: false, codeline: 'fe' },
      ],
    };
    // The 'be' codeline's filtered temp copy only ever contained S1.
    const cl = { stories: [{ id: 'S1', status: 'completed', completed: true, codeline: 'be' }] };
    const { result } = runMergeBack(canonical, cl);
    const s1 = result.stories.find((s: any) => s.id === 'S1');
    const s2 = result.stories.find((s: any) => s.id === 'S2');
    expect(s1.completed).toBe(true);
    expect(s2.status).toBe('pending');
    expect(s2.completed).toBe(false);
  });

  it('carries over TC-writer-populated testCriteria facts, not just status fields', () => {
    const canonical = { stories: [{ id: 'S1', status: 'pending', completed: false }] };
    const cl = {
      stories: [{
        id: 'S1', status: 'completed', completed: true,
        testCriteria: { facts: ['getGreeting() returns hello dolly'] },
      }],
    };
    const { result } = runMergeBack(canonical, cl);
    const s1 = result.stories.find((s: any) => s.id === 'S1');
    expect(s1.testCriteria.facts).toEqual(['getGreeting() returns hello dolly']);
  });

  it('preserves canonical PRD fields the merge-back does not touch (project, implementationOrder)', () => {
    const canonical = {
      project: { name: 'mock-hello-world' },
      implementationOrder: { core: ['S1'] },
      stories: [{ id: 'S1', status: 'pending', completed: false }],
    };
    const cl = { stories: [{ id: 'S1', status: 'completed', completed: true }] };
    const { result } = runMergeBack(canonical, cl);
    expect(result.project).toEqual({ name: 'mock-hello-world' });
    expect(result.implementationOrder).toEqual({ core: ['S1'] });
  });

  it('is deterministic across repeated runs', () => {
    const canonical = { stories: [{ id: 'S1', status: 'pending', completed: false }] };
    const cl = { stories: [{ id: 'S1', status: 'completed', completed: true }] };
    for (let i = 0; i < 5; i++) {
      const { result } = runMergeBack(canonical, cl);
      expect(result.stories[0].completed).toBe(true);
    }
  });
});
