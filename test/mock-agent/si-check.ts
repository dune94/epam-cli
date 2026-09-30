/**
 * EVERY MODEL CALL CARRIES ITS SI AND ITS TASK — checked where every call lands.
 *
 * Operator, 2026-09-30: "ensure SI and prompts are BOTH sent for ALL LLM calls - no exceptions - I
 * need 100% guarantee". The mocking agent stands where every vendor stands, so every call the
 * pipeline makes reaches it, whichever path sent it. Each is checked here:
 *   - a system prompt, and a task, both non-empty; the SI never travelling inside the task;
 *   - the pipeline-wide constitution (config/agent-contract.json) in the system prompt;
 *   - the SI of the seam the call was made for: its registry base, or the project roster's entry
 *     for that seam or for an agent ancestored to it;
 *   - no other seam's SI;
 *   - none of the HOST's Claude Code configuration: the install's and the user's CLAUDE.md, the names of
 *     the skills installed on this machine, the working directory's own commit subjects (a runner's
 *     git status). Each marker is read from the host itself, never spelled here.
 * Nothing expected is written here: every value is read from the install's declarations and roster.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { Call } from './agent';

const firstLine = (s: string) => s.split('\n').find((l) => l.trim().length > 20) || '';
/** The text of a rule up to its first placeholder — the part the run cannot have filled differently. */
const fixedPart = (rule: string) => rule.split('{')[0].trim();

export function siFindings(call: Call, orchestrationsDir: string): string[] {
  const out: string[] = [];
  const system = String(call.req.system || '');
  const task = call.req.messages.find((m) => m.role === 'user')?.text || '';
  if (!system.trim()) out.push('no system prompt');
  if (!task.trim()) out.push('no task');
  if (system.trim() && task.includes(system.trim())) out.push('the SI travelled inside the task');

  const contract = JSON.parse(readFileSync(join(orchestrationsDir, 'config/agent-contract.json'), 'utf8'));
  const c = contract.constitution || {};
  if (c.header && !system.includes(c.header)) out.push('no constitution');
  for (const r of (c.rules || []) as string[]) if (!system.includes(fixedPart(r))) out.push(`constitution rule missing: ${fixedPart(r).slice(0, 60)}`);

  const profiles = JSON.parse(readFileSync(join(orchestrationsDir, 'agents/invocation-profiles.json'), 'utf8')).profiles || {};
  const seam = call.seam;
  if (!profiles[seam]) { out.push(`call not attributable to a declared seam (${seam})`); return out; }
  const expected: string[] = [];
  if (profiles[seam].si) expected.push(profiles[seam].si);
  const projects = join(orchestrationsDir, 'projects');
  for (const p of existsSync(projects) ? readdirSync(projects) : []) {
    const f = join(projects, p, 'roster.json');
    if (!existsSync(f)) continue;
    let agents: Record<string, { persona?: string; ancestor?: string }> = {};
    try { agents = JSON.parse(readFileSync(f, 'utf8')).agents || {}; } catch { continue; }
    for (const [name, e] of Object.entries(agents)) if ((name === seam || e.ancestor === seam) && e.persona) expected.push(e.persona);
  }
  if (!expected.some((si) => system.includes(si))) out.push(`no SI of seam ${seam}`);
  for (const [s, p] of Object.entries<any>(profiles)) {
    if (s === seam || !p.si) continue;
    const l = firstLine(p.si);
    if (l && system.includes(l) && !expected.some((si) => si.includes(l))) out.push(`carries ${s}'s SI`);
  }
  return out;
}

const lineOf = (f: string) => { try { return readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).find((l) => l.length > 12) || ''; } catch { return ''; } };

/** Skill names installed on this machine (user skills and plugin skills), from their SKILL.md. */
function hostSkillNames(): string[] {
  const out = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 7 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'SKILL.md') { const m = /^name:\s*(\S+)/m.exec(readFileSync(p, 'utf8')); if (m && m[1].length >= 12) out.add(m[1]); }
    }
  };
  walk(join(homedir(), '.claude/skills'), 0); walk(join(homedir(), '.claude/plugins'), 0);
  return [...out];
}
let SKILLS: string[] | null = null;

/** Host configuration the runner added to the request — what the pipeline never sent. */
export function hostFindings(call: Call, orchestrationsDir: string): string[] {
  const text = `${call.req.system || ''}\n${call.req.messages.map((m) => m.text || '').join('\n')}`;
  const out: string[] = [];
  for (const f of [join(dirname(orchestrationsDir), 'CLAUDE.md'), join(homedir(), '.claude/CLAUDE.md')]) {
    const l = lineOf(f); if (l && text.includes(l)) out.push(`host CLAUDE.md in the request (${f})`);
  }
  SKILLS = SKILLS || hostSkillNames();
  const skill = SKILLS.find((n) => text.includes(n)); if (skill) out.push(`host skills in the request (${skill})`);
  const cwd = (/[Ww]orking directory:\s*(\S+)/.exec(text) || [])[1];
  if (cwd && existsSync(cwd)) {
    let subjects: string[] = [];
    try { subjects = execFileSync('git', ['-C', cwd, 'log', '--format=%s', '-5'], { encoding: 'utf8' }).split('\n').filter((x) => x.length > 12); } catch { /* not a repo */ }
    const hit = subjects.find((x) => text.includes(x)); if (hit) out.push(`the runner's git status in the request ("${hit.slice(0, 50)}")`);
  }
  return out;
}
