/**
 * story-writer — an implementer working through its tools, turn by turn.
 *
 * Turn 1 (a fresh conversation): write every file the story declares, through the write tool the
 * request offers (recognised by its parameters, not its name), in the working directory the
 * runner states. Later turns (tool results came back): finish with a short summary. The content of
 * each file is the codeline's ecosystem's declared stand-in, so what is written is what that stack's
 * gates can run — no stack is known here.
 */
import { isAbsolute } from 'node:path';
import type { Behaviour, Call } from '../agent';
import type { ToolCall, ToolDef } from '../wire';
import { newCallId } from '../wire';
import { deliveries } from '../ecosystem';
import type { World } from '../world';

/** The tool whose parameters say it writes a file: a path and a content. */
export const writeTool = (tools: ToolDef[]) => tools.find((t) => {
  const p = Object.keys(t.params?.properties || {});
  return p.some((k) => /path/i.test(k)) && p.some((k) => /content/i.test(k));
});

const keyLike = (t: ToolDef, re: RegExp) => Object.keys(t.params?.properties || {}).find((k) => re.test(k))!;

/** Where the runner says it works: its own system prompt names the directory. */
export function workingDirectory(call: Call, world: World): string {
  return (/Working directory:\s*(\S+)/.exec(call.req.system) || [])[1] || world.codelines()[0]?.path || '';
}

export const isFirstTurn = (call: Call) => !call.req.messages.some((m) => m.role === 'tool' || m.toolCalls);

export function writerDelivers(world: World, install: string): Behaviour {
  return (call) => {
    const story = world.story(call.story);
    if (!isFirstTurn(call)) return { kind: 'text', text: `Implemented ${call.story}: wrote the declared files and their tests.` };
    const tool = writeTool(call.req.tools);
    if (!story || !tool) return { kind: 'text', text: `Nothing to write for ${call.story || 'this request'}.` };
    const cwd = workingDirectory(call, world);
    const files = (story.technicalNotes?.files || []).filter((f): f is string => typeof f === 'string' && f.trim() !== '');
    const d = deliveries(install, cwd, world.prdPath(), files) || files.map((f) => ({ path: f, content: `${f}: delivered\n`, kind: 'other' as const }));
    const [pathKey, contentKey] = [keyLike(tool, /path/i), keyLike(tool, /content/i)];
    // WHERE THE PROMPT SAYS TO WRITE IT. A story in a worktree lane is handed its own absolute paths
    // ("Files to Create/Modify"); writing to the main checkout left the lane with no commits. The
    // path the prompt gives wins; otherwise a relative path, which the runner resolves where it runs.
    const prompt = call.req.messages.find((m) => m.role === 'user')?.text || '';
    const given = (f: string) => (prompt.match(new RegExp(`(/[^\\s\`'"]*/${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=[\\s\`'"]|$)`, 'm')) || [])[1];
    const calls: ToolCall[] = d.map((x) => ({ id: newCallId(), name: tool.name, input: { [pathKey]: isAbsolute(x.path) ? x.path : given(x.path) || x.path, [contentKey]: x.content } }));
    return { kind: 'tools', calls };
  };
}
