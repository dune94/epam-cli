/**
 * repro-test — one test that reproduces the defect the fix just corrected, written through a tool.
 *
 * As the test engineer the prompt addresses: it mirrors the repository's own example test (framework,
 * imports, style — "mirror its framework … EXACTLY") and asserts the value the fix introduced, which
 * the diff's added lines carry and its removed lines do not. The test goes to the exact path the
 * prompt names. Nothing about any stack is known here: the example is the template, the diff is the
 * expectation. A prompt whose example or diff cannot be read gets an honest "cannot" in prose.
 */
import type { Behaviour } from '../agent';
import type { ToolCall } from '../wire';
import { newCallId } from '../wire';
import { quotedLiterals } from './discovery';
import { writeTool, isFirstTurn } from './writer';

const keyLike = (params: Record<string, any>, re: RegExp) => Object.keys(params?.properties || {}).find((k) => re.test(k));

export function reproTest(prompt: string): { path: string; content: string } | null {
  const path = (/Write the test to EXACTLY this path[^:]*:\s*(\S+?)(?=\d+\.\s|\s|$)/.exec(prompt) || [])[1];
  const example = (/Example test from THIS repo[\s\S]*?```[^\n]*\n([\s\S]*?)```/.exec(prompt) || [])[1];
  const diff = (/```diff([\s\S]*?)```/.exec(prompt) || [])[1] || '';
  if (!path || !example || !diff) return null;
  const added = diff.split('\n').filter((l) => /^\+[^+]/.test(l)).join('\n');
  const removed = diff.split('\n').filter((l) => /^-[^-]/.test(l)).join('\n');
  const now = quotedLiterals(added).find((l) => !quotedLiterals(removed).includes(l));
  // The call the example makes of what it imports — the observable the fix changed.
  const imported = [...example.matchAll(/import\s*\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean));
  const call = imported.map((n) => new RegExp(`\\b${n}\\([^()]*\\)`).exec(example)?.[0]).find(Boolean);
  const itBlock = /(\n\s*)it\((['"`])[^]*?\2,\s*\(\)\s*=>\s*\{[\s\S]*?\n\s*\}\);/.exec(example);
  if (!now || !call || !itBlock) return null;
  const pad = itBlock[1];
  const replacement = `${pad}it('returns the corrected value', () => {${pad}  expect(${call}).toBe(${JSON.stringify(now)});${pad}});`;
  return { path, content: example.replace(itBlock[0], replacement) };
}

export function reproWriter(): Behaviour {
  return (call) => {
    const prompt = call.req.messages.find((m) => m.role === 'user')?.text || '';
    if (!isFirstTurn(call)) return { kind: 'text', text: 'Wrote the reproducing test: it asserts the corrected value, so it fails on the pre-fix code and passes with the fix.' };
    const tool = writeTool(call.req.tools);
    const t = reproTest(prompt);
    if (!tool || !t) return { kind: 'text', text: `I could not write a reproducing test: ${!tool ? 'no write tool was offered' : 'the prompt gave no readable example, diff or path'}.` };
    const [pathKey, contentKey] = [keyLike(tool.params, /path/i)!, keyLike(tool.params, /(^|_)(content|text)$/i)!];
    const calls: ToolCall[] = [{ id: newCallId(), name: tool.name, input: { [pathKey]: t.path, [contentKey]: t.content } }];
    return { kind: 'tools', calls };
  };
}
