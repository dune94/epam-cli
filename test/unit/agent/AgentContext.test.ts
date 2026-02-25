import { describe, it, expect } from 'vitest';
import { AgentContext } from '../../../src/agent/AgentContext.js';

describe('AgentContext', () => {
  it('builds initial user message when no entries exist', () => {
    const ctx = new AgentContext('You are helpful');
    const messages = ctx.buildMessages('Hello!');
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello!');
  });

  it('tracks user and assistant entries', () => {
    const ctx = new AgentContext('system');
    ctx.addUserMessage('ping');
    ctx.addAssistantMessage('pong');
    const entries = ctx.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].role).toBe('user');
    expect(entries[1].role).toBe('assistant');
  });

  it('clear removes all entries', () => {
    const ctx = new AgentContext('system');
    ctx.addUserMessage('hello');
    ctx.clear();
    expect(ctx.getEntries()).toHaveLength(0);
  });

  it('estimateTokenCount returns a positive number for non-empty context', () => {
    const ctx = new AgentContext('system');
    ctx.addUserMessage('a'.repeat(400));
    expect(ctx.estimateTokenCount()).toBeGreaterThan(0);
  });

  it('shouldCompress returns false below threshold', () => {
    const ctx = new AgentContext('system', 80000);
    ctx.addUserMessage('short');
    expect(ctx.shouldCompress()).toBe(false);
  });

  it('shouldCompress returns true when threshold exceeded', () => {
    const ctx = new AgentContext('system', 10);
    ctx.addUserMessage('a'.repeat(200));
    expect(ctx.shouldCompress()).toBe(true);
  });
});
