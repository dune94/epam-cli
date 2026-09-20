/**
 * A RESUME HANDS THE ORCHESTRATOR THE RUN'S COMPLETED STORIES — INTACT.
 *
 * The seam: launcher (tier3-run.sh) → greenfield lifecycle → REAL prd-remediate.sh → orchestrator.
 * regintel 20260919T224649Z resume 6 (2026-09-20) passed every unit on that line and still redid
 * 14 completed stories: the lifecycle dropped --reset, the orchestrator re-queued only the failed
 * story, and the remediation between them reset the phase. What the orchestrator RECEIVED is the
 * only assertion that covers the handoff, so the stand-in orchestrator records the PRD as it finds
 * it. The fresh launch is asserted too, so the fix cannot be "never reset".
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const LAUNCHER = join(ROOT, 'orchestrations/scripts/tier3-run.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function stub(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(dir, name), 0o755);
}
function story(id: string, status: string, completed: boolean, extra: Record<string, unknown> = {}) {
  return {
    id, status, completed, title: id, description: `d ${id}`, acceptanceCriteria: [`ac ${id}`],
    aiProvider: 'openrouter', model: 'z-ai/glm-5.3', effort: 'medium',
    technicalNotes: { files: [`regintel/${id.toLowerCase()}.py`] },
    testCriteria: { facts: ['f'], sourceFiles: [`regintel/${id.toLowerCase()}.py`] },
    specification: { runId: 'R1', status: 'completed', assignedAgents: ['openspec'], agentContributions: [{ agent: 'openspec', applied: true }] },
    ...extra,
  };
}

function launch(resume: string) {
  const ws = mkdtempSync(join(tmpdir(), 'gf-resume-handoff-')); dirs.push(ws);
  const projects = join(ws, 'projects'); const proj = join(projects, 'demo'); mkdirSync(proj, { recursive: true });
  const out = join(ws, 'build'); mkdirSync(out, { recursive: true });
  const bins = join(ws, 'bins'); mkdirSync(bins);
  const seen = join(ws, 'orchestrator-saw.json');
  const prd = join(ws, 'demo-prd.json');
  const runtime = {
    project: { name: 'demo', outputDir: out }, configuration: { protectedPaths: [] },
    implementationOrder: { scaffold: ['S-001'], core: ['S-002', 'S-003', 'S-005b'] },
    stories: [
      story('S-001', 'completed', true), story('S-002', 'completed', true, { completedAt: 't2' }),
      story('S-003', 'completed', true, { completedAt: 't3' }), story('S-005b', 'failed', false, { error: 'tests failed' }),
    ],
  };
  writeFileSync(prd, JSON.stringify(runtime));
  writeFileSync(join(proj, 'prd.authored.json'), JSON.stringify({ ...runtime, stories: runtime.stories.map((s) => ({ ...s, status: 'pending', completed: false, specification: undefined })) }));
  writeFileSync(join(proj, 'config.env'), [
    'EPAM_BROWNFIELD=0', `OUTPUT_DIR=${out}`, 'EPAM_PHASES="scaffold core"', `PRD_FILE=${prd}`, `PRD_CANONICAL=${join(proj, 'prd.authored.json')}`,
    'EPAM_PROMPT_PROVISION_MODE=copy', 'EPAM_PROVIDER_SET=mockserver',
  ].join('\n'));
  spawnSync('git', ['-C', out, 'init', '-q']);
  mkdirSync(join(ws, 'logs'), { recursive: true });
  writeFileSync(join(ws, 'logs', 'phase-gates.jsonl'), JSON.stringify({ phase_id: 'scaffold', decision: 'go', timestamp: 'x' }) + '\n');
  // The orchestrator stand-in records the PRD exactly as the real one would first read it.
  stub(bins, 'orch.sh', `jq -c '{args: $a, stories: [.stories[] | {id, status, completed, completedAt}]}' --arg a "$*" "${prd}" >> "${seen}"; exit 0`);
  stub(bins, 'preflight.sh', 'exit 0');
  stub(bins, 'reset.sh', 'echo PRE_RUN_RESET_STATE_CLEARED; exit 0');
  const r = spawnSync('bash', [LAUNCHER, '--project', 'demo', '--yes'], {
    encoding: 'utf8', cwd: ws, timeout: 120_000,
    env: {
      ...process.env, EPAM_PROJECTS_DIR: projects, EPAM_ORCHESTRATOR_BIN: join(bins, 'orch.sh'),
      EPAM_PREFLIGHT_BIN: join(bins, 'preflight.sh'), PRE_RUN_RESET_SCRIPT: join(bins, 'reset.sh'),
      EPAM_FREE_RUN: '1', EPAM_PROJECT_OUTPUT_DIR: join(ws, 'logs'), EPAM_RESUME_RUN: resume,
    },
  });
  const log = `${r.stdout}\n${r.stderr}`;
  let calls: any[] = [];
  try { calls = readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
  return { log, calls, status: r.status };
}

describe('a resume hands the orchestrator the run\'s completed stories', () => {
  const t = launch('20260919T224649Z');
  const core = t.calls.find((c) => /--phase core/.test(c.args));
  const by: Record<string, any> = {}; for (const s of core?.stories || []) by[s.id] = s;

  it('the real remediation ran and the core phase was handed over once, without --reset', () => {
    expect(t.log, t.log).toMatch(/\[prd-remediate\]/);
    expect(t.calls.filter((c) => /--phase core/.test(c.args)), t.log).toHaveLength(1);
    expect(core.args).not.toMatch(/--reset/);
  });

  it('the completed core stories arrive completed, with their record', () => {
    expect(by['S-002'], JSON.stringify(core)).toMatchObject({ status: 'completed', completed: true, completedAt: 't2' });
    expect(by['S-003']).toMatchObject({ status: 'completed', completed: true, completedAt: 't3' });
  });

  it('the failed story arrives pending — the one thing the resume is for', () => {
    expect(by['S-005b']).toMatchObject({ status: 'pending', completed: false });
  });

  it('the finished scaffold phase is not handed over at all', () => {
    expect(t.calls.some((c) => /--phase scaffold/.test(c.args))).toBe(false);
  });
});

describe('a fresh launch still resets the phase before handing it over', () => {
  it('every core story arrives pending, with --reset', () => {
    const t = launch('');
    const core = t.calls.find((c) => /--phase core/.test(c.args));
    expect(core, t.log).toBeTruthy();
    expect(core.args).toMatch(/--reset/);
    for (const s of core.stories) if (s.id !== 'S-001') expect(s, s.id).toMatchObject({ status: 'pending', completed: false });
  });
});
