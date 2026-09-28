/**
 * story-writer — an implementer working through its tools, turn by turn.
 *
 * Turn 1 (a fresh conversation): write every file the story declares, through the write tool the
 * request offers (recognised by its parameters, not its name), in the working directory the
 * runner states. Later turns (tool results came back): finish with a short summary. The content of
 * each file is the codeline's ecosystem's declared stand-in, so what is written is what that stack's
 * gates can run — no stack is known here.
 */
import { isAbsolute, dirname } from 'node:path';
import type { Behaviour, Call } from '../agent';
import type { ToolCall, ToolDef } from '../wire';
import { newCallId } from '../wire';
import { deliveries } from '../ecosystem';
import type { World } from '../world';

/** The tool whose parameters say it writes a file: a path and a content. */
export const writeTool = (tools: ToolDef[]) => tools.find((t) => {
  const p = Object.keys(t.params?.properties || {});
  return p.some((k) => /path/i.test(k)) && p.some((k) => /content|text/i.test(k));
});

const keyLike = (t: ToolDef, re: RegExp) => Object.keys(t.params?.properties || {}).find((k) => re.test(k))!;

/** Where the runner says it works: its own system prompt names the directory. */
export function workingDirectory(call: Call, world: World): string {
  return (/[Ww]orking directory:\s*(\S+)/.exec(call.req.system) || [])[1] || world.codelines()[0]?.path || '';
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
    const [pathKey, contentKey] = [keyLike(tool, /path/i), keyLike(tool, /content|text/i)];
    // WHERE THE PROMPT SAYS TO WRITE IT. A story in a worktree lane is handed its own absolute paths
    // ("Files to Create/Modify"); writing to the main checkout left the lane with no commits. The
    // path the prompt gives wins; otherwise a relative path, which the runner resolves where it runs.
    const prompt = call.req.messages.find((m) => m.role === 'user')?.text || '';
    const given = (f: string) => (prompt.match(new RegExp(`(/[^\\s\`'"]*/${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=[\\s\`'"]|$)`, 'm')) || [])[1];
    const calls: ToolCall[] = d.map((x) => ({ id: newCallId(), name: tool.name, input: { [pathKey]: isAbsolute(x.path) ? x.path : given(x.path) || x.path, [contentKey]: x.content } }));
    // A WRITE TOOL THAT SAYS ITS PARENT DIRECTORIES MUST EXIST (its own description — the GitHub Copilot
    // CLI's `create`) answers a new directory with an error; a model reads that and makes the directory.
    // The model's move, made up front: one shell call creating the new directories, then the writes.
    // A write tool that makes its own directories (claude's Write) says no such thing, and gets none.
    const shell = call.req.tools.find((t) => Object.keys(t.params?.properties || {}).includes('command'));
    if (shell && /parent director(y|ies)[^.]*must exist/i.test(tool.description || '')) {
      const dirs = [...new Set(calls.map((c) => dirname(String(c.input[pathKey]))).filter((x) => x && x !== '.' && x !== '/'))];
      if (dirs.length) {
        const input: Record<string, unknown> = { command: `mkdir -p ${dirs.map((x) => JSON.stringify(x)).join(' ')}` };
        for (const k of shell.params?.required || []) {
          if (k in input) continue;
          const spec = shell.params?.properties?.[k] || {};
          input[k] = Array.isArray(spec.enum) && spec.enum.length ? spec.enum[0] : 'create the directories the files go in';
        }
        calls.unshift({ id: newCallId(), name: shell.name, input });
      }
    }
    return { kind: 'tools', calls };
  };
}
