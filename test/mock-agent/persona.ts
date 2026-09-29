/**
 * DID EVERY MODEL CALL CARRY ITS AGENT'S PERSONA? — asked of what the model was actually sent.
 *
 * Each seam declares whose persona it speaks as (agents/invocation-profiles.json `persona`). The
 * persona reaches the model in the request — the codemie-web assistant's system instructions, or
 * the rendered prompt on every other stack. A call whose request carries neither is an agent
 * working with thin instructions (operator, 2026-09-29: "We cannot have thin SI").
 *
 * The persona is resolved the way the pipeline resolves it (lib/agent-roster.js agentPersona): the
 * install's profiles before a project roster exists, the roster's specialised text once it does —
 * so a call made before the roster was written carries the one, a call after it the other, and
 * either counts. Nothing is named here: the seams, their personas and their text come from the
 * install under test.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Call } from './agent';

export type PersonaGap = { n: number; seam: string; persona: string; where: 'request' | 'system' | 'authored'; why?: string };

/** The standing instructions si-author wrote for each seam of this project (lib/assistant-instructions.js). */
function authoredFor(install: string, projectConfigDir: string, seam: string): { rendered: string } | undefined {
  if (!projectConfigDir) return undefined;
  const req = createRequire(join(install, 'orchestrations/scripts/lib/assistant-instructions.js'));
  const { readAuthored } = req(join(install, 'orchestrations/scripts/lib/assistant-instructions.js'));
  return readAuthored(seam, { ...process.env, EPAM_PROJECT_CONFIG_DIR: projectConfigDir }) || undefined;
}

/** The section headings of the authored layout (templates/assistant-instructions.json). */
function layoutHeadings(install: string): string[] {
  const t = JSON.parse(readFileSync(join(install, 'orchestrations/prompts/templates/assistant-instructions.json'), 'utf8'));
  return String(t.bodies.authored).split('\n').filter((l) => l.startsWith('## '));
}

/** The install's personas as they stand now — taken before a run, since a run may augment them. */
export function personasNow(install: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(install, 'orchestrations/agents/profiles.json'), 'utf8'));
}

/**
 * `atStart`: the install's personas before the run (personasNow) — the text a call made early in
 * the run was sent, before the run's own skill assessment augmented them.
 * `systemIsTheAgent`: on a stack whose agents are stored assistants (codemie-web), the system
 * instructions ARE the agent — they must carry THIS seam's persona, not another seam's.
 */
export function personaGaps(install: string, projectConfigDir: string, calls: Call[], atStart: Record<string, unknown> = {}, systemIsTheAgent = false): PersonaGap[] {
  const agentsDir = join(install, 'orchestrations/agents');
  const reg = JSON.parse(readFileSync(join(agentsDir, 'invocation-profiles.json'), 'utf8')).profiles as Record<string, { persona?: string }>;
  const req = createRequire(join(install, 'orchestrations/scripts/lib/agent-roster.js'));
  const { agentPersona } = req(join(install, 'orchestrations/scripts/lib/agent-roster.js'));
  const roster = projectConfigDir && existsSync(join(projectConfigDir, 'roster.json')) ? projectConfigDir : '';
  const gaps: PersonaGap[] = [];
  const review = Object.keys(reg).find((k) => (reg[k] as any).produces === 'instructions-review') || '';
  for (const c of calls) {
    const seam = reg[c.seam] ? c.seam : Object.keys(reg).find((k) => k.replace(/[^a-z0-9]/gi, '_') === c.seam) || '';
    const who = seam ? reg[seam].persona || '' : '';
    if (!who) continue;                                       // an unrecognised request is judged elsewhere
    const sent = [c.req.system, ...c.req.messages.map((m) => m.text || '')].join('\n');
    const start = atStart[who];
    const texts = [agentPersona(who, agentsDir, ''), roster ? agentPersona(who, agentsDir, roster) : '',
      typeof start === 'string' ? start : String((start as any)?.persona || '')]
      .map((t: string) => String(t || '').trim()).filter(Boolean);
    const authored = systemIsTheAgent ? authoredFor(install, projectConfigDir, seam) : undefined;
    const system = String(c.req.system || '').trim();
    if (authored) {
      // ON A STACK WHOSE AGENTS ARE STORED ASSISTANTS, an authored seam's system instructions ARE its
      // authored ones — exactly a text si-review was handed for this seam before this call. A run
      // re-authors a seam whose inputs changed (the roster, the codeline's ecosystem), so the call may
      // carry an earlier authoring than the final artefact; never one nobody reviewed.
      const reviewed = calls.some((r) => r.n < c.n && r.seam === review && r.req.messages.some((m) => (m.text || '').includes(`\`${seam}\``) && (m.text || '').includes(system)));
      const unlaid = layoutHeadings(install).filter((h) => !system.includes(h));
      if (!system || unlaid.length || !reviewed) {
        gaps.push({ n: c.n, seam, persona: who, where: 'authored', why: !system ? 'no system instructions' : unlaid.length ? `lacks ${unlaid.join(', ')}; begins "${system.slice(0, 160)}"` : `no si-review before it was handed this text; begins "${system.slice(0, 160)}"` });
      }
      continue;
    }
    if (!texts.some((t) => sent.includes(t))) gaps.push({ n: c.n, seam, persona: who, where: 'request' });
    else if (systemIsTheAgent && !texts.some((t) => system.includes(t))) gaps.push({ n: c.n, seam, persona: who, where: 'system' });
  }
  return gaps;
}
