import { describe, it, expect, afterEach } from 'vitest';
import { parseMarkupToolCalls, stripThinkingBlocks, createQwenProvider, OPENROUTER_BASE_URL } from '../../../src/providers/qwen/QwenProvider.js';

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

describe('stripThinkingBlocks', () => {
  it('returns unchanged text when no think blocks present', () => {
    expect(stripThinkingBlocks('Hello world')).toBe('Hello world');
  });

  it('strips a single think block', () => {
    const text = '<think>lots of reasoning here</think>I will write the file.';
    expect(stripThinkingBlocks(text)).toBe('I will write the file.');
  });

  it('strips multiline think blocks', () => {
    const text = '<think>\nStep 1: analyse\nStep 2: plan\n</think>\nActual response.';
    expect(stripThinkingBlocks(text)).toBe('Actual response.');
  });

  it('strips multiple think blocks', () => {
    const text = '<think>first thought</think>code here<think>second thought</think>more code';
    expect(stripThinkingBlocks(text)).toBe('code heremore code');
  });

  it('returns empty string when only a think block', () => {
    expect(stripThinkingBlocks('<think>all reasoning, no output</think>')).toBe('');
  });

  it('handles think block with tool markup after it', () => {
    const text = '<think>plan the write</think>\n<function=write_file>\n<parameter=path>a.ts</parameter>\n</function>';
    const result = stripThinkingBlocks(text);
    expect(result).not.toContain('<think>');
    expect(result).toContain('<function=write_file>');
  });
});

describe('createQwenProvider — OPENROUTER_BASE_URL override', () => {
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
  });

  it('uses default OpenRouter base URL when OPENROUTER_BASE_URL is not set', () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const provider = createQwenProvider();
    expect(JSON.stringify(provider)).toContain(OPENROUTER_BASE_URL);
  });

  it('uses OPENROUTER_BASE_URL override when set — enables mock server', () => {
    process.env.OPENROUTER_API_KEY = 'mock-key';
    process.env.OPENROUTER_BASE_URL = 'http://localhost:4000/v1';
    const provider = createQwenProvider();
    expect(JSON.stringify(provider)).toContain('http://localhost:4000/v1');
    expect(JSON.stringify(provider)).not.toContain(OPENROUTER_BASE_URL);
  });
});
