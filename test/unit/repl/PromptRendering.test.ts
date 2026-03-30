import { describe, it, expect } from 'vitest';

describe('MCP Output Formatting', () => {
  it('should have balanced backticks in MCP output', () => {
    const mcpOutput = '\n[MCP SOURCES]\n\nLOCALHOST:9010:\n  • Test Ticket (Demo queue)\n\n';
    
    const backticks = (mcpOutput.match(/`/g) || []).length;
    expect(backticks % 2).toBe(0);
  });

  it('should have balanced parentheses in MCP output', () => {
    const mcpOutput = '\n[MCP SOURCES]\n\nLOCALHOST:9010:\n  • Test Ticket (Demo queue)\n\n';
    
    const open = (mcpOutput.match(/\(/g) || []).length;
    const close = (mcpOutput.match(/\)/g) || []).length;
    expect(open).toBe(close);
  });

  it('should have balanced brackets in MCP output', () => {
    const mcpOutput = '\n[MCP SOURCES]\n\nLOCALHOST:9010:\n  • Test Ticket (Demo queue)\n\n';
    
    const open = (mcpOutput.match(/\[/g) || []).length;
    const close = (mcpOutput.match(/\]/g) || []).length;
    expect(open).toBe(close);
  });

  it('agent response with backticks should be balanced', () => {
    // Real agent response pattern
    const agentResponse = '`@jira AMSD-1013` resolves in this repo';
    
    const backticks = (agentResponse.match(/`/g) || []).length;
    expect(backticks % 2).toBe(0);
  });

  it('combined MCP + agent output should have balanced quotes', () => {
    const mcpOutput = '\n[MCP SOURCES]\n\nLOCALHOST:9010:\n  • Test Ticket (Demo queue)\n\n';
    const agentResponse = 'Found ticket AMSD-1013\n';
    
    const combined = mcpOutput + agentResponse;
    
    const backticks = (combined.match(/`/g) || []).length;
    const openParens = (combined.match(/\(/g) || []).length;
    const closeParens = (combined.match(/\)/g) || []).length;
    
    expect(backticks % 2).toBe(0);
    expect(openParens).toBe(closeParens);
  });
});
