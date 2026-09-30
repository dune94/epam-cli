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
 *   - no SI or persona inside the PROMPT: one path — an agent's identity travels as its SI only
 *     (operator, 2026-09-30: "I want only one path - not two or more");
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
  // A CALL THE MOCK CANNOT ATTRIBUTE (its prompt matches no template it recognises) still carries
  // exactly one seam's SI — which one is not knowable here, but none, or several, is a defect.
  if (!profiles[seam]) {
    const carried = Object.keys(profiles).filter((s) => profiles[s].si && system.includes(firstLine(profiles[s].si)));
    const persona = rosterPersonas(orchestrationsDir).some((p) => system.includes(p));
    if (!carried.length && !persona) out.push('no SI of any seam');
    if (carried.length > 1) out.push(`SIs of more than one seam (${carried.join(', ')})`);
    return out;
  }
  const expected: string[] = [];
  if (profiles[seam].si) expected.push(profiles[seam].si);
  for (const [name, e] of rosterEntries(orchestrationsDir)) if ((name === seam || e.ancestor === seam) && e.persona) expected.push(e.persona);
  if (!expected.some((si) => system.includes(si))) out.push(`no SI of seam ${seam}`);
  for (const [s, p] of Object.entries<any>(profiles)) {
    if (s === seam || !p.si) continue;
    const l = firstLine(p.si);
    if (l && system.includes(l) && !expected.some((si) => si.includes(l))) out.push(`carries ${s}'s SI`);
  }
  return out;
}

/** Every project roster entry in the install: [name, entry]. */
function rosterEntries(orchestrationsDir: string): [string, { persona?: string; ancestor?: string }][] {
  const out: [string, { persona?: string; ancestor?: string }][] = [];
  const projects = join(orchestrationsDir, 'projects');
  for (const p of existsSync(projects) ? readdirSync(projects) : []) {
    const f = join(projects, p, 'roster.json');
    if (!existsSync(f)) continue;
    try { out.push(...Object.entries<{ persona?: string; ancestor?: string }>(JSON.parse(readFileSync(f, 'utf8')).agents || {})); } catch { /* unreadable */ }
  }
  return out;
}
const rosterPersonas = (dir: string) => rosterEntries(dir).map(([, e]) => e.persona || '').filter(Boolean);

/**
 * The call's OWN identity texts: its seam's SI, the roster entries of that seam (or ancestored to it),
 * and every profiles.json persona whose name the registry resolves to that seam. Other agents' SIs may
 * be the SUBJECT of a prompt (a roster reviewer reads the roster); the call's own identity may not.
 */
function ownIdentities(seam: string, orchestrationsDir: string): { who: string; line: string }[] {
  const out: { who: string; line: string }[] = [];
  const add = (who: string, text: unknown) => { const l = typeof text === 'string' ? firstLine(text) : ''; if (l.length > 40) out.push({ who, line: l }); };
  const regFile = join(orchestrationsDir, 'agents/invocation-profiles.json');
  try { add(`seam ${seam}`, (JSON.parse(readFileSync(regFile, 'utf8')).profiles || {})[seam]?.si); } catch { /* none */ }
  for (const [n, e] of rosterEntries(orchestrationsDir)) if (n === seam || e.ancestor === seam) add(`roster ${n}`, e.persona);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveSeam } = require(join(orchestrationsDir, 'scripts/lib/seam-invocation.js'));
  for (const f of ['agents/profiles.json', 'agents/profiles.canonical.json']) {
    let profiles: Record<string, any> = {};
    try { profiles = JSON.parse(readFileSync(join(orchestrationsDir, f), 'utf8')); } catch { continue; }
    for (const [n, v] of Object.entries(profiles)) {
      let s2 = ''; try { s2 = resolveSeam(n, regFile, { ignoreXref: true }); } catch { continue; }
      if (s2 === seam) add(`profile ${n}`, typeof v === 'string' ? v : v && v.persona);
    }
  }
  return out;
}

/** The call's own SI or persona pasted into the PROMPT — the second path the operator forbids. */
export function personaInPrompt(call: Call, orchestrationsDir: string): string[] {
  const prompt = call.req.messages.filter((m) => m.role === 'user').map((m) => m.text || '').join('\n');
  const hit = ownIdentities(call.seam, orchestrationsDir).find((i) => prompt.includes(i.line));
  if (!hit) return [];
  // A PASTED IDENTITY IS ONE IDENTITY. A prompt whose subject is the roster (a roster reviewer) carries
  // many seams' SIs — its own among them — as the material under review, not as who it is.
  let others = 0;
  try {
    const profiles = JSON.parse(readFileSync(join(orchestrationsDir, 'agents/invocation-profiles.json'), 'utf8')).profiles || {};
    others = Object.keys(profiles).filter((x) => x !== call.seam && profiles[x].si && prompt.includes(firstLine(profiles[x].si))).length;
  } catch { others = 0; }
  return others ? [] : [`an SI or persona inside the prompt (${hit.who})`];
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
  // THE TASK SIDE ONLY. The runner's own system prompt is the runner's (Claude Code's built-in text
  // names its built-in skills); host configuration arrived in the user turn (£0 brownfield, 2026-09-30).
  const text = call.req.messages.filter((m) => m.role === 'user').map((m) => m.text || '').join('\n');
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
