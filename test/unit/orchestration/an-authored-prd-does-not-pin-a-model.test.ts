/**
 * THE LADDER OWNS THE MODEL. AN AUTHORED PRD DOES NOT.
 *
 * A story-level `model` outranks the ladder: run-agent-orchestration.sh says so in place — "THE
 * LADDER IS THE ONLY SOURCE ... a run-wide pin that silently outranked the seam, behind a literal
 * that always answered", which is how two of three ladder positions resolved no model for months
 * and nothing noticed.
 *
 * mock3's authored PRD pinned MiniMax-M3 on both stories. Under a mockserver rehearsal — whose
 * whole purpose is to cost nothing and whose set declares a Claude ladder — the writer ran
 * `provider=minimax model=MiniMax-M3`, exhausted a ladder that was not the declared one, and
 * abandoned both stories without ever climbing the ladder that was.
 *
 * A pin also silently defeats the provider set: EPAM_PROVIDER_SET routes the seams, and a pinned
 * story ignores it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROJECTS = path.join(__dirname, '../../../orchestrations/projects');

const ROOT = path.join(__dirname, '../../../');

/**
 * Every PRD a human authored: prd.authored.json beside a project, AND the file a project names as
 * PRD_CANONICAL in its config.env — the greenfield shape, restored over the runtime PRD at every
 * launch. The greenfield canonical was outside this universe, so the skyscanner PRD pinned
 * MiniMax-M3 on all four stories and pre-flight refused every £0 launch of it (2026-09-13).
 */
function authoredPrds(): string[] {
  const out = new Set<string>();
  for (const d of fs.readdirSync(PROJECTS)) {
    const beside = path.join(PROJECTS, d, 'prd.authored.json');
    if (fs.existsSync(beside)) out.add(beside);
    const cfg = path.join(PROJECTS, d, 'config.env');
    if (!fs.existsSync(cfg)) continue;
    const m = fs.readFileSync(cfg, 'utf8').match(/^PRD_CANONICAL=(.+)$/m);
    if (!m) continue;
    const c = m[1].trim().replace(/^["']|["']$/g, '');
    const f = path.isAbsolute(c) ? c : path.join(ROOT, c);
    if (fs.existsSync(f)) out.add(f);
  }
  return [...out];
}

describe('an authored PRD does not pin a model', () => {
  it('there are authored PRDs to check — otherwise this proves nothing', () => {
    expect(authoredPrds().length).toBeGreaterThan(0);
  });

  it.each(authoredPrds())('%s lets the ladder choose', (file) => {
    const prd = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A provider pin is the same override by another name: EPAM_PROVIDER_SET routes the seams,
    // and a story that names its own vendor ignores it.
    const pinned = (prd.stories || [])
      .filter((s: any) => s && (s.model || s.aiProvider))
      .map((s: any) => `${s.id}=${s.model || ''}${s.aiProvider ? `@${s.aiProvider}` : ''}`);
    expect(pinned, `these stories pin a model, so the ladder and the provider set are both `
      + `overridden: ${pinned.join(', ')}`).toEqual([]);
  });

  // THE ASSIGNER OWNS THE ASSIGNMENT. A story that arrives already carrying agentRole is skipped by
  // the assigner and judged against the roster this run minted — which need not hold that name.
  // The greenfield canonical carried typescript-engineer on all four stories, the £0 run minted
  // stand-in-engineer, and the mint refused: "not in the roster — it has no profile entry".
  it.each(authoredPrds())('%s lets the assigner choose the agent', (file) => {
    const prd = JSON.parse(fs.readFileSync(file, 'utf8'));
    const assigned = (prd.stories || [])
      .filter((s: any) => s && (s.agentRole || s.assignedAgent || s.agent))
      .map((s: any) => `${s.id}=${s.agentRole || s.assignedAgent || s.agent}`);
    expect(assigned, `these stories arrive pre-assigned, so the assigner never runs and the roster `
      + `is bypassed: ${assigned.join(', ')}`).toEqual([]);
  });
});

/**
 * AN AUTHORED PRD NAMES ITS DELIVERABLES INSIDE THE CODELINE.
 *
 * The greenfield canonical declared every deliverable as an absolute path into one host's home
 * directory — the OUTPUT_DIR of an August run. A run building elsewhere verified its deliverables
 * against that stale directory and reported them present (2026-09-13). A deliverable is a path
 * within the codeline; where the codeline lives is the run's declaration, not the PRD's.
 */
describe('an authored PRD names its deliverables inside the codeline', () => {
  it.each(authoredPrds())('%s declares no absolute deliverable path', (file) => {
    const prd = JSON.parse(fs.readFileSync(file, 'utf8'));
    const absolute: string[] = [];
    for (const s of prd.stories || []) {
      const tn = (s && s.technicalNotes) || {};
      const lists = [tn.files || [], ...Object.values(tn.perCodeline || {}).map((c: any) => (c && (c.files || c)) || [])];
      for (const f of lists.flat()) if (typeof f === 'string' && path.isAbsolute(f)) absolute.push(`${s.id}: ${f}`);
    }
    expect(absolute, 'deliverables declared outside any codeline').toEqual([]);
  });

  // The same host path had also been written into descriptions, acceptance criteria and
  // workingDir — text the model reads as where the work must land. A story's text names no host.
  it.each(authoredPrds())('%s writes the output directory into no story', (file) => {
    const prd = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = prd.project && prd.project.outputDir;
    if (!out) return;
    const hits: string[] = [];
    for (const s of prd.stories || []) {
      if (JSON.stringify(s).includes(out)) hits.push(s.id);
    }
    expect(hits, `stories carrying the host path ${out}`).toEqual([]);
  });
});
