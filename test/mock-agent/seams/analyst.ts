/**
 * impl-failure-analyst — diagnoses the failure it is handed, as a careful analyst would.
 *
 * The failure evidence is the request's own. When it names a file that ANOTHER story declares (the
 * PRD's technicalNotes.files), the fix belongs to that story: the answer escalates to it by name.
 * Otherwise the answer is the contract's declared preference, with a diagnosis quoting the failure
 * and an imperative note the retry can act on. The answer is the prompt's own exemplar, filled —
 * every field the code asks for, none it does not.
 */
import { exemplar, fill } from '../answer';
import type { Contract } from '../declarations';
import type { World } from '../world';

/** Paths the failure text names that some story declares, with the stories that declare them. */
export function namedFiles(world: World, failure: string): { file: string; owners: string[] }[] {
  const out: { file: string; owners: string[] }[] = [];
  const declared = new Map<string, string[]>();
  for (const s of world.stories()) for (const f of s.technicalNotes?.files || []) if (typeof f === 'string') declared.set(f, [...(declared.get(f) || []), s.id]);
  for (const [f, owners] of declared) if (f && !f.endsWith('/') && failure.includes(f)) out.push({ file: f, owners });
  return out;
}

export function failureAnalyst(world: World, prompt: string, story: string, contract?: Contract, templateText = ''): string {
  const ex = exemplar(prompt, contract, templateText) || {};
  const failure = prompt.slice(Math.max(0, prompt.search(/FAILURE|Failure/)));
  const firstLine = (failure.split('\n').map((l) => l.trim()).find((l) => /FAILED|Error|error|missing|not exist|assert/i.test(l)) || 'the verification failed').slice(0, 160);
  const foreign = namedFiles(world, failure).map((n) => ({ ...n, owners: n.owners.filter((o) => o !== story) })).find((n) => n.owners.length && !world.story(story)?.technicalNotes?.files?.includes(n.file));
  const prefer = (contract?.prefer || {}) as Record<string, unknown>;
  const target = foreign ? 'escalate' : String(prefer.target || 'skill');
  const base = fill(ex, (_k, o) => (o.includes(target) ? target : o[0])) as Record<string, unknown>;
  const answer: Record<string, unknown> = {
    ...base,
    diagnosis: foreign ? `${foreign.file} is ${foreign.owners[0]}'s file and holds the defect: ${firstLine}` : `The attempt failed verification: ${firstLine}`,
    target,
    ...( 'evidence' in base ? { evidence: `read the verification output: ${firstLine}` } : {}),
    ...( 'reason' in base ? { reason: foreign ? 'Only the owning story may change that file.' : 'The retry needs the missing step stated.' } : {}),
  };
  if ('escalation' in base) answer.escalation = foreign ? { targetFile: foreign.file, ownerStoryId: foreign.owners[0], requiredFix: `Fix ${foreign.file} so that: ${firstLine}` } : {};
  if ('skill_note' in base) answer.skill_note = foreign ? '' : `Always create every file the story declares before finishing, at the exact paths listed — ${firstLine}`;
  for (const k of ['ac_patches', 'tc_patches']) if (k in base) answer[k] = [];
  delete answer.provisioning; delete answer.tool_spec;
  return JSON.stringify(answer);
}

/**
 * agent-failure-analyst — why an agent produced nothing usable, and what its next attempt must do first. Read from the
 * prompt's own sections, as a model reads them: what the agent produced, why it was refused, and the class's hint (the
 * template states the corrective each failure class needs). Nothing about any project or agent is known here.
 */
export function agentFailureDiagnosis(prompt: string): string {
  const section = (name: RegExp) => {
    const at = prompt.search(name); if (at < 0) return '';
    const rest = prompt.slice(at).split('\n').slice(1).join('\n');
    const end = rest.search(/\n=== /); return (end < 0 ? rest : rest.slice(0, end)).trim();
  };
  const produced = (section(/=== WHAT THE AGENT PRODUCED/).split('\n').find((l) => l.trim()) || 'nothing').trim().slice(0, 200);
  const why = section(/=== WHY THIS ATTEMPT WAS REFUSED/).split('\n')[0]?.trim().slice(0, 200) || 'it produced no usable output';
  // The class hint is the paragraph before the first section header (the template places it there).
  const head = prompt.slice(0, Math.max(0, prompt.search(/\n=== /)));
  const hint = (head.split(/(?<=\.)\s+/).find((s) => /directive must|must make|FIRST action|commit output/i.test(s)) || '').trim();
  const diagnosis = `The agent said "${produced}" and was refused because ${why}. ${hint || 'Its next attempt must produce the required output first, before anything else.'}`;
  return JSON.stringify({ diagnosis, target: 'skill', reason: 'The refusal names exactly what was missing; the retry must start there.' });
}
