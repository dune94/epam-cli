/**
 * WHO IS RUNNING, AND ON WHAT — one definition.
 *
 * This label names the trace Langfuse records, and it is therefore also the key a recorded run is
 * replayed by. Two copies of the rule would drift the moment either side changed, and the failure
 * would be silent: a replay looking up a name the recorder never wrote, reported as "this seam
 * was never recorded" when in fact it was recorded under a different spelling.
 *
 * Env is the only channel that reaches here without touching every call site — each agent call is
 * its own `epam run` subprocess.
 */
export function agentLabel(fallback = 'call'): string {
  const agent = process.env.EPAM_AGENT_NAME?.trim();
  const story = process.env.EPAM_STORY_ID?.trim();
  if (agent && story) return `${agent} · ${story}`;
  return agent || story || fallback;
}
