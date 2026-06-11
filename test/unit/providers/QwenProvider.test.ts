import { describe, it, expect } from 'vitest';
import { parseMarkupToolCalls } from '../../../src/providers/qwen/QwenProvider.js';

describe('parseMarkupToolCalls', () => {
  it('returns empty toolUses and original text when input has no markup', () => {
    const text = 'I will help you with that task.';
    const result = parseMarkupToolCalls(text);
    expect(result.toolUses).toHaveLength(0);
    expect(result.cleanText).toBe(text);
  });

  it('returns empty toolUses for empty string', () => {
    const result = parseMarkupToolCalls('');
    expect(result.toolUses).toHaveLength(0);
    expect(result.cleanText).toBe('');
  });

  it('parses a single function call with one parameter', () => {
    const text = "I'll create the file.\n<function=write_file>\n<parameter=path>src/greet.ts</parameter><parameter=content>export const greet = () => 'hello';</parameter>\n</function>";
    const result = parseMarkupToolCalls(text);
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0]).toMatchObject({
      type: 'tool_use',
      name: 'write_file',
      input: { path: 'src/greet.ts', content: "export const greet = () => 'hello';" },
    });
    expect(result.toolUses[0].id).toMatch(/^qwen_markup_/);
    expect(result.cleanText).not.toContain('<function=');
    expect(result.cleanText).toContain("I'll create the file.");
  });

  it('parses multiline parameter content and trims surrounding whitespace', () => {
    const text = '<function=write_file>\n<parameter=path>\ngreet.ts\n</parameter><parameter=content>\nexport function greet(name: string): string {\n    return `Hello, ${name}!`;\n}\n</parameter>\n</function>';
    const result = parseMarkupToolCalls(text);
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].input).toMatchObject({
      path: 'greet.ts',
      content: "export function greet(name: string): string {\n    return `Hello, ${name}!`;\n}",
    });
    expect(result.cleanText.trim()).toBe('');
  });

  it('parses multiple function calls in one response', () => {
    const text = [
      '<function=write_file><parameter=path>a.ts</parameter><parameter=content>const a = 1;</parameter></function>',
      '<function=write_file><parameter=path>b.ts</parameter><parameter=content>const b = 2;</parameter></function>',
    ].join('\n');
    const result = parseMarkupToolCalls(text);
    expect(result.toolUses).toHaveLength(2);
    expect(result.toolUses[0].input).toMatchObject({ path: 'a.ts', content: 'const a = 1;' });
    expect(result.toolUses[1].input).toMatchObject({ path: 'b.ts', content: 'const b = 2;' });
    // Each gets a unique id
    expect(result.toolUses[0].id).not.toBe(result.toolUses[1].id);
  });

  it('removes stray </tool_call> artifact appended by Qwen', () => {
    const text = '<function=write_file><parameter=path>greet.ts</parameter><parameter=content>export const x = 1;</parameter></function>\n</tool_call>';
    const result = parseMarkupToolCalls(text);
    expect(result.toolUses).toHaveLength(1);
    expect(result.cleanText).not.toContain('</tool_call>');
  });

  it('preserves text before and after the function call block in cleanText', () => {
    const text = 'Here is my plan.\n\n<function=bash><parameter=command>ls -la</parameter></function>\n\nDone.';
    const result = parseMarkupToolCalls(text);
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0]).toMatchObject({
      name: 'bash',
      input: { command: 'ls -la' },
    });
    expect(result.cleanText).toContain('Here is my plan.');
    expect(result.cleanText).toContain('Done.');
    expect(result.cleanText).not.toContain('<function=');
  });

  it('returns no toolUses when text has only partial/unclosed markup', () => {
    const text = 'Hello <function=write_file> no closing tag here';
    const result = parseMarkupToolCalls(text);
    expect(result.toolUses).toHaveLength(0);
    expect(result.cleanText).toBe(text);
  });

  it('parses read_file call with single path parameter', () => {
    const text = '<function=read_file><parameter=path>src/index.ts</parameter></function>';
    const result = parseMarkupToolCalls(text);
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0]).toMatchObject({
      name: 'read_file',
      input: { path: 'src/index.ts' },
    });
  });
});
