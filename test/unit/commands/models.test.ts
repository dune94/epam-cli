import { describe, it, expect } from 'vitest';
import { createModelsCommand } from '../../../src/cli/commands/models.js';

function captureOutput(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

describe('models command', () => {
  it('lists all Anthropic models including claude-opus-4-7', async () => {
    const cmd = createModelsCommand();
    const output = await new Promise<string>(res => {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
      cmd.parseAsync([], { from: 'user' }).finally(() => {
        console.log = orig;
        res(lines.join('\n').replace(/\x1b\[[0-9;]*m/g, ''));
      });
    });
    expect(output).toContain('claude-opus-4-7');
    expect(output).toContain('claude-opus-4-6');
    expect(output).toContain('claude-sonnet-4-6');
    expect(output).toContain('claude-haiku-4-5-20251001');
    expect(output).toContain('(default)');
  });

  it('lists updated OpenAI models including gpt-4.1, o3, o4-mini', async () => {
    const cmd = createModelsCommand();
    const output = await new Promise<string>(res => {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
      cmd.parseAsync([], { from: 'user' }).finally(() => {
        console.log = orig;
        res(lines.join('\n').replace(/\x1b\[[0-9;]*m/g, ''));
      });
    });
    expect(output).toContain('gpt-4.1');
    expect(output).toContain('gpt-4.1-mini');
    expect(output).toContain('gpt-4o');
    expect(output).toContain('o3');
    expect(output).toContain('o4-mini');
  });

  it('lists Gemini 2.5 models and no legacy 1.5 models', async () => {
    const cmd = createModelsCommand();
    const output = await new Promise<string>(res => {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
      cmd.parseAsync([], { from: 'user' }).finally(() => {
        console.log = orig;
        res(lines.join('\n').replace(/\x1b\[[0-9;]*m/g, ''));
      });
    });
    expect(output).toContain('gemini-2.5-pro');
    expect(output).toContain('gemini-2.5-flash');
    expect(output).not.toContain('gemini-1.5-pro');
    expect(output).not.toContain('gemini-1.5-flash');
  });

  it('filters by provider', async () => {
    const cmd = createModelsCommand();
    const output = await new Promise<string>(res => {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
      cmd.parseAsync(['--provider', 'anthropic'], { from: 'user' }).finally(() => {
        console.log = orig;
        res(lines.join('\n').replace(/\x1b\[[0-9;]*m/g, ''));
      });
    });
    expect(output).toContain('claude-opus-4-7');
    expect(output).not.toContain('gpt-4');
    expect(output).not.toContain('gemini');
  });
});
