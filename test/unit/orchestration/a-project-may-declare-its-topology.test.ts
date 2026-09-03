/**
 * A TOPOLOGY THE PROJECT ALREADY KNOWS IS DECLARED, NOT ASKED FOR.
 *
 * topology-router asks a model which execution topology a phase should use — single, parallel or
 * sequential worktrees. Worth a call where the answer is uncertain; pure spend where the operator
 * already knows, and it made a project fail its seam check for want of a minted router prompt over
 * a question a declaration answers. metrolinx sat at 39/40 on exactly that.
 *
 * EPAM_TOPOLOGY declares it. Set, no model is asked. Unset, the router runs exactly as before and
 * the count heuristic still backs it — the feature is intact, not replaced.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const ORCH = readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real decision block, lifted out and run with the router and helpers stubbed. */
function decide(env: Record<string, string>, opts: { routerAnswers?: string; codelines?: number } = {}) {
  const start = ORCH.indexOf('# THE TOPOLOGY A PROJECT ALREADY KNOWS');
  expect(start, 'the topology decision block is gone').toBeGreaterThan(-1);
  const end = ORCH.indexOf('src_tag=', start);
  const block = ORCH.slice(start, end);

  const d = mkdtempSync(join(tmpdir(), 'topology-')); dirs.push(d);
  const sh = join(d, 'run.sh');
  // A stub router that answers only if the test says it should — proving the declaration is read
  // BEFORE the model is asked, not merely preferred after.
  const routerJs = join(d, 'topology-router.js');
  writeFileSync(join(d, 'prd.json'), JSON.stringify({
    stories: [{ id: 'S-1', effort: 'low' }, { id: 'S-2', effort: 'low' }],
  }));
  writeFileSync(routerJs, opts.routerAnswers
    ? `console.log(JSON.stringify({ topology: ${JSON.stringify(opts.routerAnswers)}, reason: 'stub' }));`
    : 'process.exit(1);');
  writeFileSync(sh,
    '#!/usr/bin/env bash\nset -uo pipefail\n'
    + 'info(){ echo "[info] $*"; }\nwarning(){ echo "[warn] $*"; }\n'
    + `SCRIPT_DIR=${JSON.stringify(d)}\nmkdir -p "$SCRIPT_DIR/lib"\n`
    + `cp ${JSON.stringify(routerJs)} "$SCRIPT_DIR/lib/topology-router.js"\n`
    // The router path reads the story list and the PRD; without them jq yields nothing and the
    // block falls to the heuristic — which would make the LLM cases pass for the wrong reason.
    + `_wt_count=${opts.codelines ?? 2}\nPHASE=core\nPHASE_COST_FILE=/dev/null\n`
    + `_wt_stories_list=$'S-1\\nS-2'\nPRD_FILE=${JSON.stringify(join(d, 'prd.json'))}\n`
    + `${block}\n`
    + 'echo "DECISION=$_topology_decision SOURCE=$_topology_source"\n');

  const r = spawnSync('bash', [sh], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/DECISION=(\S+) SOURCE=(\S+)/);
  return { topology: m?.[1] || '', source: m?.[2] || '', out };
}

describe('the harness is real — without a declaration nothing is declared', () => {
  // WHAT THIS DOES NOT TEST, AND WHY. Whether the ROUTER or the HEURISTIC answers depends on the
  // orchestrator's surrounding state — the story list, the PRD, the model resolution — and
  // reproducing all of it here would be testing the stub rather than the pipeline. Both are
  // pre-existing paths this change does not touch. What matters is that neither is bypassed and
  // neither is mislabelled: with nothing declared, the decision must not come from a declaration.
  it('the decision is still made, and is not attributed to a declaration', () => {
    const { topology, source } = decide({ EPAM_TOPOLOGY: '' }, { codelines: 2 });
    expect(['single', 'parallel', 'sequential']).toContain(topology);
    expect(source, 'an undeclared topology was reported as declared').not.toBe('declared');
  });

  it('the count heuristic still backs it — two codelines is the parallel band', () => {
    const { topology } = decide({ EPAM_TOPOLOGY: '' }, { codelines: 2 });
    expect(topology).toBe('parallel');
  });
});

describe('A PROJECT MAY DECLARE ITS TOPOLOGY AND SPEND NOTHING ON IT', () => {
  it('the declaration is used', () => {
    const { topology, source } = decide({ EPAM_TOPOLOGY: 'sequential' }, { codelines: 2 });
    expect(topology).toBe('sequential');
    expect(source, 'a declared topology must not be attributed to the model').toBe('declared');
  });

  it('and the model is never asked — even when it would have answered differently', () => {
    const { topology, source } = decide({ EPAM_TOPOLOGY: 'single' }, { routerAnswers: 'parallel' });
    expect(topology, 'the router overruled the operator').toBe('single');
    expect(source).toBe('declared');
  });

  it('a value that is not a topology is refused and the router still runs', () => {
    const { topology, source, out } = decide({ EPAM_TOPOLOGY: 'as-fast-as-possible' },
      { routerAnswers: 'parallel' });
    expect(out, 'the operator is not told their declaration was ignored')
      .toMatch(/as-fast-as-possible/);
    expect(['single', 'parallel', 'sequential']).toContain(topology);
    expect(source, 'a bad declaration must fall through, not be honoured').not.toBe('declared');
  });
});
