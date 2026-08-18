/**
 * NO AGENT'S MODEL IS WRITTEN INTO THE ENGINE.
 *
 * Every model default in the pipeline was `${VAR:-<a vendor model name>}`. Three things were wrong
 * with that shape, and the third is why it survived so long:
 *
 *   1. The literal is a vendor fact in the engine — a project could not change it without editing
 *      the engine, and it went stale the moment a vendor shipped a version.
 *   2. The run-wide variable (ORCH_GATE_MODEL, ESCALATION_MODEL_HIGH, SPEC_MODE_*_MODEL) is a
 *      SECOND source of truth that silently outranks the seam an agent was declared to occupy. An
 *      agent placed at the base of the ladder ran on whatever the run happened to pin.
 *   3. Because the literal always answered, THE LADDER NEVER HAD TO WORK. Two of its three
 *      positions declared no startModel in any project's llm-settings.json, and no run ever
 *      noticed — the literal covered it every single time.
 *
 * That is also why the previous attempt to remove these failed. On 2026-08-14 the literals were
 * deleted while the ladder still could not answer, seams resolved no model, the repro-test-writer
 * refused to run and Step 3.55 blocked the story. The ladder has to answer FIRST; these tests hold
 * both halves together so the pair cannot drift apart again.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const NODE = process.execPath;

const ENGINE_FILES = ['run-agent-orchestration.sh', 'claude.sh', 'spec-mode-runner.js'];

/** A vendor model name, as it would appear quoted in code. */
const VENDOR_MODEL = /['"](MiniMax-M[0-9]|z-ai\/glm-[0-9]|moonshotai\/kimi|zhipuai\/glm|deepseek\/|gpt-[0-9]|claude-[a-z0-9])/;

/** Lines that are not comments in either shell or JS. */
function codeLines(file: string): Array<{ n: number; line: string }> {
  return readFileSync(join(SCRIPTS, file), 'utf8')
    .split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => !/^\s*(#|\/\/|\*|\/\*)/.test(line));
}

/** Resolve a model the way the engine does, with mock3's ladders loaded. */
function modelFor(agent: string): string {
  const r = spawnSync('bash', ['-c',
    `set -a; . ${JSON.stringify(join(SCRIPTS, 'lib/model-ladders.sh'))}; set +a
     export_model_ladders ${JSON.stringify(join(ROOT, 'orchestrations/projects/mock3/llm-settings.json'))}
     . ${JSON.stringify(join(SCRIPTS, 'lib/seam-ladder.sh'))}
     seam_model_or_fail ${JSON.stringify(agent)} 2>/dev/null`,
  ], { encoding: 'utf8', env: { ...process.env, NODE_BIN: NODE } });
  return r.stdout.trim();
}

describe('the ladder is the only source of a model', () => {
  it('no engine file names a vendor model in executable code', () => {
    const offenders: string[] = [];
    for (const f of ENGINE_FILES) {
      for (const { n, line } of codeLines(f)) {
        if (VENDOR_MODEL.test(line)) offenders.push(`${f}:${n}: ${line.trim().slice(0, 100)}`);
      }
    }
    expect(offenders, `${offenders.length} executable line(s) still name a vendor model:`).toEqual([]);
  });

  it('finds the files — it is not scanning nothing', () => {
    for (const f of ENGINE_FILES) {
      expect(codeLines(f).length, `${f} produced no code lines`).toBeGreaterThan(100);
    }
  });

  it('every tier the project declares has a startModel, or the ladder cannot answer', () => {
    // The half that was missing. Without this, deleting the literals reproduces 2026-08-14.
    const dir = join(ROOT, 'orchestrations/projects');
    const projects = readdirSync(dir).filter((p) => {
      try { readFileSync(join(dir, p, 'llm-settings.json')); return true; } catch { return false; }
    });
    expect(projects.length, 'no project llm-settings.json was found').toBeGreaterThan(0);

    const gaps: string[] = [];
    for (const p of projects) {
      const j = JSON.parse(readFileSync(join(dir, p, 'llm-settings.json'), 'utf8'));
      for (const [tier, v] of Object.entries<any>(j.ladders || {})) {
        if (!v?.startModel) gaps.push(`${p}: ladder '${tier}' declares no startModel`);
      }
    }
    expect(gaps,
      `${gaps.length} ladder tier(s) cannot answer what model to start on. Every agent whose seam `
      + 'sits at that position resolves NO model, and the engine will refuse to invoke it:',
    ).toEqual([]);
  });

  it('every agent the engine invokes by name resolves a model', () => {
    const agents = [
      'prd-change-reviewer', 'gate-finding-analyst', 'story-ac-remediator', 'profile-augmentor',
      'spec-agent', 'spec-coordinator', 'story-writer', 'skills_audit', 'tools_audit',
      'story_recovery', 'lint-fixer', 'impl-failure-analyst', 'ac-classification',
      'prd-model-coordinator',
    ];
    const unresolved = agents.filter((a) => !modelFor(a));
    expect(unresolved, `${unresolved.length} agent(s) resolve no model from the ladder:`).toEqual([]);
  });

  it('the ladder position actually differentiates — it is not one model for everything', () => {
    // If every seam resolved the same model the ladder would be decorative, and this whole change
    // would have moved the hardcoding rather than removed it.
    const base = modelFor('ac-classification');
    const top = modelFor('story-writer');
    expect(base, 'a base-position seam resolved nothing').toBeTruthy();
    expect(top, 'a top-position seam resolved nothing').toBeTruthy();
    expect(base, 'base and top resolve the same model — position no longer affects anything')
      .not.toBe(top);
  });

  it('an agent climbs its own chain rather than a shared escalation model', () => {
    const r = spawnSync('bash', ['-c',
      `set -a; . ${JSON.stringify(join(SCRIPTS, 'lib/model-ladders.sh'))}; set +a
       export_model_ladders ${JSON.stringify(join(ROOT, 'orchestrations/projects/mock3/llm-settings.json'))}
       . ${JSON.stringify(join(SCRIPTS, 'lib/seam-ladder.sh'))}
       base=$(seam_model_or_fail ac-classification)
       top=$(seam_model_or_fail story-writer)
       echo "base=$(seam_next_model ac-classification "$base") top=$(seam_next_model story-writer "$top")"`,
    ], { encoding: 'utf8', env: { ...process.env, NODE_BIN: NODE } });
    const m = /base=(\S+) top=(\S+)/.exec(r.stdout);
    expect(m, `no climb resolved: ${r.stdout}${r.stderr}`).toBeTruthy();
    expect(m![1], 'the base seam climbs to the same model the top seam climbs to — that is a shared '
      + 'escalation pin, which is what this replaced').not.toBe(m![2]);
  });

  it('the set of valid models comes from the project, not from a list in the engine', () => {
    const src = readFileSync(join(SCRIPTS, 'spec-mode-runner.js'), 'utf8');
    const fn = /function buildKnownValidModels[\s\S]*?\n}/.exec(src);
    expect(fn, 'buildKnownValidModels is gone').toBeTruthy();
    expect(fn![0], 'the engine still carries its own list of real model names')
      .not.toMatch(VENDOR_MODEL);
    expect(fn![0], 'it no longer reads the project’s declared ladders').toMatch(/EPAM_MODEL_LADDER/);
  });
});
