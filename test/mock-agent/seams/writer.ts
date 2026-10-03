/**
 * story-writer — an implementer working through its tools, turn by turn.
 *
 * Turn 1 (a fresh conversation): write every file the story declares, through the write tool the
 * request offers (recognised by its parameters, not its name), in the working directory the
 * runner states. Later turns (tool results came back): finish with a short summary. The content of
 * each file is the codeline's ecosystem's declared stand-in, so what is written is what that stack's
 * gates can run — no stack is known here.
 */
import { isAbsolute, dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Behaviour, Call } from '../agent';
import type { ToolCall, ToolDef } from '../wire';
import { newCallId } from '../wire';
import { deliveries } from '../ecosystem';
import { quotedLiterals } from './discovery';
import type { World } from '../world';

/** The tool whose parameters say it writes a file: a path and a content. */
// A parameter NAMED content/text (whole word): Grep's `context` is not a file's content, and matching
// it sent the repro stand-in's test file to Grep (£0 brownfield, 2026-09-30).
export const writeTool = (tools: ToolDef[]) => tools.find((t) => {
  const p = Object.keys(t.params?.properties || {});
  return p.some((k) => /path/i.test(k)) && p.some((k) => /(^|_)(content|text)$/i.test(k));
});

/**
 * AN EXISTING FILE IS EDITED, NEVER REPLACED — as a model working a brownfield ticket does. The
 * ticket's own quoted literals say what changes: one the file holds is replaced by one it does not
 * (the same reading the fix-plan stand-in makes). With no such pair, the file keeps everything it
 * had and gains the stack's stand-in content, so its existing exports survive.
 */
export function literalChange(existing: string, prompt: string): { from: string; to: string } | null {
  const literals = quotedLiterals(prompt);
  // A literal the file holds AS A QUOTED VALUE is the one to change: 'Close' in `return 'Close';`,
  // replaced by the ticket's literal the file does not hold — even one that extends it ('Close
  // notification'), since the quotes make the match exact.
  for (const q of [`'`, `"`, '`']) {
    const old = literals.find((l) => existing.includes(`${q}${l}${q}`));
    const want = old && literals.find((l) => l !== old && !existing.includes(`${q}${l}${q}`));
    if (old && want) return { from: `${q}${old}${q}`, to: `${q}${want}${q}` };
  }
  const old = literals.find((l) => existing.includes(l));
  const want = old && literals.find((l) => l !== old && !existing.includes(l) && !l.includes(old) && !old.includes(l));
  return old && want ? { from: old, to: want } : null;
}

export function edited(existing: string, prompt: string, standIn: string): string {
  const c = literalChange(existing, prompt);
  if (c) return existing.split(c.from).join(c.to);
  return `${existing.replace(/\n?$/, '\n')}${standIn}`;
}

/** The tool whose parameters say it replaces text in a file: a path, an old and a new string. */
export const editTool = (tools: ToolDef[]) => tools.find((t) => {
  const p = Object.keys(t.params?.properties || {});
  return p.some((k) => /path/i.test(k)) && p.some((k) => /^old/i.test(k)) && p.some((k) => /^new/i.test(k));
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
    const tool = writeTool(call.req.tools);
    // WHAT THIS CONVERSATION HAS ALREADY DONE: a model reads, then writes, then reports.
    const called = (t?: ToolDef) => !!t && call.req.messages.some((m) => (m.toolCalls || []).some((c) => c.name === t.name));
    if (!isFirstTurn(call) && (!tool || called(tool) || called(editTool(call.req.tools)))) return { kind: 'text', text: `Implemented ${call.story}: wrote the declared files and their tests.` };
    if (!story || !tool) return { kind: 'text', text: `Nothing to write for ${call.story || 'this request'}.` };
    const cwd = workingDirectory(call, world);
    // THE FILES THE PROMPT HANDS IT, as a model reads them: the "Files to Create/Modify" list. The
    // project's PRD is not what the writer is given — on a resume the lane's own PRD carries the spec
    // and the canonical one may not (multi-lane £0, 2026-10-02: the writer answered with no calls).
    const prompt0 = call.req.messages.find((m) => m.role === 'user')?.text || '';
    const listed = ((/## Files to Create\/Modify[^\n]*\n([\s\S]*?)(?:\n## |$)/.exec(prompt0) || [, ''])[1])
      .split('\n').map((l) => l.trim()).filter((l) => /^[^\s]+\.[A-Za-z0-9]+$/.test(l) || /^\/[^\s]+$/.test(l));
    const declared = (story.technicalNotes?.files || []).filter((f): f is string => typeof f === 'string' && f.trim() !== '');
    const files = [...new Set([...declared, ...listed])];
    const d = deliveries(install, cwd, world.prdPath(), files) || files.map((f) => ({ path: f, content: `${f}: delivered\n`, kind: 'other' as const }));
    const [pathKey, contentKey] = [keyLike(tool, /path/i), keyLike(tool, /(^|_)(content|text)$/i)];
    // WHERE THE PROMPT SAYS TO WRITE IT. A story in a worktree lane is handed its own absolute paths
    // ("Files to Create/Modify"); writing to the main checkout left the lane with no commits. The
    // path the prompt gives wins; otherwise a relative path, which the runner resolves where it runs.
    const prompt = call.req.messages.find((m) => m.role === 'user')?.text || '';
    const given = (f: string) => (prompt.match(new RegExp(`(/[^\\s\`'"]*/${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=[\\s\`'"]|$)`, 'm')) || [])[1];
    // AN EXISTING FILE IS READ BEFORE IT IS WRITTEN — as a model does, and as a runner may enforce
    // (Claude Code refuses the write otherwise: "File has not been read yet"). The read tool is the one
    // whose only required parameter is a path; the files are the ones already on disk.
    const readTool = call.req.tools.find((t) => t !== tool && (t.params?.required || []).length === 1 && /path/i.test((t.params?.required || [])[0] || ''));
    const existing = d.map((x) => (isAbsolute(x.path) ? x.path : given(x.path) || x.path)).filter((at) => existsSync(isAbsolute(at) ? at : join(cwd, at)));
    if (readTool && existing.length && !called(readTool)) {
      const rk = (readTool.params?.required || [])[0];
      const abs = /path[^.]*must be absolute/i.test(readTool.description || '');
      return { kind: 'tools', calls: existing.map((at) => ({ id: newCallId(), name: readTool.name, input: { [rk]: abs && !isAbsolute(at) ? join(cwd, at) : at } })) };
    }
    // A TOOL THAT SAYS ITS PATH MUST BE ABSOLUTE (its own description — the GitHub Copilot CLI's
    // create/edit) is given the absolute path in the working directory, as a model reads that rule.
    const wantsAbsolute = (t?: ToolDef) => !!t && /path[^.]*must be absolute/i.test(t.description || '');
    // AN EXISTING FILE IS EDITED THROUGH THE EDIT TOOL when the runner offers one whose write tool
    // refuses an existing path ("Cannot be used if the specified path already exists") — the
    // change replaces the ticket's old literal; with none, the stand-in is appended after the last line.
    const edit = editTool(call.req.tools);
    const createRefusesExisting = /cannot be used if the specified path already exists/i.test(tool.description || '');
    const calls: ToolCall[] = d.map((x) => {
      const at0 = isAbsolute(x.path) ? x.path : given(x.path) || x.path;
      const onDisk = isAbsolute(at0) ? at0 : join(cwd, at0);
      if (existsSync(onDisk) && edit && createRefusesExisting) {
        const existingText = readFileSync(onDisk, 'utf8');
        const c = literalChange(existingText, prompt);
        const lines = existingText.split('\n');
        const line = c ? lines.find((l) => l.includes(c.from))! : lines.filter((l) => l.trim()).pop() || '';
        const replaced = c ? line.split(c.from).join(c.to) : `${line}\n${x.content.replace(/\n$/, '')}`;
        const [pk, ok, nk] = [keyLike(edit, /path/i), keyLike(edit, /^old/i), keyLike(edit, /^new/i)];
        return { id: newCallId(), name: edit.name, input: { [pk]: wantsAbsolute(edit) ? onDisk : at0, [ok]: line, [nk]: replaced } };
      }
      const content = existsSync(onDisk) ? edited(readFileSync(onDisk, 'utf8'), prompt, x.content) : x.content;
      return { id: newCallId(), name: tool.name, input: { [pathKey]: wantsAbsolute(tool) ? onDisk : at0, [contentKey]: content } };
    });
    // A WRITE TOOL THAT SAYS ITS PARENT DIRECTORIES MUST EXIST (its own description — the GitHub Copilot
    // CLI's `create`) answers a new directory with an error; a model reads that and makes the directory.
    // The model's move, made up front: one shell call creating the new directories, then the writes.
    // A write tool that makes its own directories (claude's Write) says no such thing, and gets none.
    const shell = call.req.tools.find((t) => Object.keys(t.params?.properties || {}).includes('command'));
    if (shell && /parent director(y|ies)[^.]*must exist/i.test(tool.description || '')) {
      const dirs = [...new Set(calls.filter((c) => c.name === tool.name).map((c) => dirname(String(c.input[pathKey]))).filter((x) => x && x !== '.' && x !== '/' && !existsSync(isAbsolute(x) ? x : join(cwd, x))))];
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
