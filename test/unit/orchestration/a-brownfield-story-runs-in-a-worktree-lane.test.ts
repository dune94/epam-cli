/**
 * A BROWNFIELD STORY RUNS IN A WORKTREE LANE — NEVER IN THE CLIENT'S CHECKOUT.
 *
 * Operator, 2026-10-02: "We need to work in worktrees" / "It was built - and you somehow destroyed
 * it". It was: metrolinx run 12 (2026-07-22) ran its brownfield writer in the primary worktree lane
 * (Step 13 `…-wt-primary`, Step 14 primary agent). The next day (ffb148f0) a single-story run was
 * defaulted to agentGroup "main" in the synthesiser, so every one-ticket brownfield run since —
 * AMSD-2974 included — wrote straight into the codeline's checkout.
 *
 * The lane is decided where the stories are categorised: in brownfield, the main lane's stories
 * are worktree stories. A PRD already synthesised with "main" (a resume) is routed the same way,
 * without editing the PRD. Greenfield keeps its main lane.
 *
 * EXECUTED: the real "Categorize stories by agent group" block of run-agent-orchestration.sh.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH_SH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
// The main file itself: this block is top-level code in it, never moved into a module.
const src = require('node:fs').readFileSync(ORCH_SH, 'utf8');
const lines = src.split('\n');
const start = lines.findIndex((l) => l.includes('# Categorize stories by agent group'));
const end = lines.findIndex((l, i) => i > start && l.startsWith('review_stories='));
const block = lines.slice(start, end).join('\n');

const work = mkdtempSync(join(tmpdir(), 'bf-worktree-lane-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function lanes(brownfield: string, group: string) {
  const prd = join(work, `prd-${brownfield}-${group}.json`);
  writeFileSync(prd, JSON.stringify({ implementationOrder: { core: ['S-1'] }, stories: [{ id: 'S-1', status: 'pending', completed: false, agentGroup: group }] }));
  const out = execFileSync('bash', ['-c', `set -e\nPHASE=core\nPRD_FILE=${JSON.stringify(prd)}\n${block}\nprintf 'MAIN=%s\\nPRIMARY=%s\\n' "$main_stories" "$primary_stories"`], { encoding: 'utf8', env: { ...process.env, EPAM_BROWNFIELD: brownfield } });
  const pick = (k: string) => (out.split('\n').find((l) => l.startsWith(`${k}=`)) || '').slice(k.length + 1).trim();
  return { main: pick('MAIN'), primary: pick('PRIMARY') };
}

describe('a brownfield story runs in a worktree lane', () => {
  it('the block under test was found', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('brownfield, agentGroup "main" (a single-story PRD, a resume): the primary worktree lane', () => {
    expect(lanes('1', 'main')).toEqual({ main: '', primary: 'S-1' });
  });

  it('brownfield, agentGroup "primary": the primary worktree lane, as before', () => {
    expect(lanes('1', 'primary')).toEqual({ main: '', primary: 'S-1' });
  });

  it('greenfield keeps its main lane', () => {
    expect(lanes('0', 'main')).toEqual({ main: 'S-1', primary: '' });
  });
});

/**
 * THE TOPOLOGY NEVER MOVES A BROWNFIELD STORY OUT OF ITS WORKTREE.
 *
 * Live 2026-10-02 (AMSD-2974 writer relaunch, cx-shared lane): the story was categorised into the
 * primary lane, then the count heuristic answered "single" for one worktree story and the collapse
 * moved it into main_stories — Step 8 wrote straight into the codeline's checkout. "single" means
 * ONE lane; in brownfield that one lane is still a worktree.
 *
 * EXECUTED: the real file from "# Categorize stories by agent group" through the topology collapse,
 * with the real lib/prd-integrity.sh; the model router is declined (EPAM_TOPOLOGY_ROUTER=0), so the
 * deterministic count heuristic decides — £0.
 */
const SCRIPTS_DIR = join(__dirname, '../../../orchestrations/scripts');
const topoEnd = lines.findIndex((l, i) => i > start && l.includes('# topology=parallel: leave'));
const throughTopology = lines.slice(start, topoEnd).join('\n');

function lanesAfterTopology(brownfield: string, ids: string[], extra: Record<string, string> = {}) {
  const prd = join(work, `prd-topo-${brownfield}-${ids.length}-${Object.keys(extra).join('')}.json`);
  writeFileSync(prd, JSON.stringify({ implementationOrder: { core: ids }, stories: ids.map((id) => ({ id, status: 'pending', completed: false, agentGroup: 'main' })) }));
  const out = execFileSync('bash', ['-c', `log(){ :; }; info(){ :; }; warning(){ :; }; error(){ :; }; success(){ :; }
source ${JSON.stringify(join(SCRIPTS_DIR, 'lib/prd-integrity.sh'))}
SCRIPT_DIR=${JSON.stringify(SCRIPTS_DIR)}; PHASE=core; PRD_FILE=${JSON.stringify(prd)}; PHASE_COST_FILE=/dev/null
${throughTopology}
printf 'MAIN=%s\\nPRIMARY=%s\\nTOPO=%s\\n' "$(echo $main_stories)" "$(echo $primary_stories)" "$_topology_decision"`], { encoding: 'utf8', env: { ...process.env, EPAM_BROWNFIELD: brownfield, EPAM_TOPOLOGY_ROUTER: '0', ...extra } });
  const pick = (k: string) => (out.split('\n').find((l) => l.startsWith(`${k}=`)) || '').slice(k.length + 1).trim();
  return { main: pick('MAIN'), primary: pick('PRIMARY'), topology: pick('TOPO') };
}

describe('the topology never moves a brownfield story out of its worktree', () => {
  it('the span under test was found', () => { expect(topoEnd).toBeGreaterThan(start); });

  it('brownfield, one story: topology single, and the story stays in the primary worktree lane', () => {
    expect(lanesAfterTopology('1', ['S-1'])).toEqual({ main: '', primary: 'S-1', topology: 'single' });
  });

  it('brownfield, declared sequential, several stories: one worktree lane holds them all', () => {
    const r = lanesAfterTopology('1', ['S-1', 'S-2'], { EPAM_TOPOLOGY: 'sequential' });
    expect(r.main).toBe('');
    expect(r.primary.split(' ').sort()).toEqual(['S-1', 'S-2']);
  });

  it('greenfield, one story: single collapses into main, as before', () => {
    expect(lanesAfterTopology('0', ['S-1'])).toEqual({ main: 'S-1', primary: '', topology: 'single' });
  });
});
