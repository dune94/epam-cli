import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const SPEC_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const src = readFileSync(SPEC_RUNNER, 'utf8');

function extractRunSpecAgentBody(): string {
  const start = src.indexOf('function runSpecAgent(');
  if (start === -1) throw new Error('runSpecAgent not found');
  // Skip past the parameter list (which may contain destructured {}) before
  // counting braces for the function body.
  let parenDepth = 0;
  let parenStart = src.indexOf('(', start);
  let bodyBraceStart = parenStart;
  for (let i = parenStart; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) { bodyBraceStart = i; break; }
    }
  }
  // Now find the { that opens the function body (after the closing paren).
  const braceStart = src.indexOf('{', bodyBraceStart);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('Could not find end of runSpecAgent');
}

describe('openspec semantic split heuristics — SPLIT RULES prompt contract', () => {
  const body = extractRunSpecAgentBody();

  it('contains rule 5: frontend/template vs build/tooling split', () => {
    expect(body).toMatch(/technicalNotes\.files.*frontend.*template/i);
    expect(body).toContain('*.html');
    expect(body).toContain('vite.config.*');
    expect(body).toContain('token bloat');
  });

  it('rule 5 lists canonical frontend file extensions', () => {
    expect(body).toContain('*.scss');
    expect(body).toContain('*.jsx');
    expect(body).toContain('*.tsx');
    expect(body).toContain('*.vue');
    expect(body).toContain('*.svelte');
  });

  it('rule 5 lists canonical build/tooling file extensions', () => {
    expect(body).toContain('webpack.config.*');
    expect(body).toContain('rollup.config.*');
    expect(body).toContain('Dockerfile');
    expect(body).toContain('Makefile');
  });

  it('contains rule 6: runtime role split', () => {
    expect(body).toMatch(/multiple independent runtime roles/i);
    expect(body).toMatch(/split by runtime role/i);
  });

  it('contains all 6 rules', () => {
    for (let i = 1; i <= 6; i++) {
      expect(body).toContain(`${i}.`);
    }
  });

  it('rules 5 and 6 appear before the "these rules apply only when splitDepth" line', () => {
    const rule5Pos = body.indexOf('technicalNotes.files contains BOTH frontend');
    const rule6Pos = body.indexOf('multiple independent runtime roles');
    const depthPos = body.indexOf('These rules apply only when splitDepth');
    expect(rule5Pos).toBeGreaterThan(0);
    expect(rule6Pos).toBeGreaterThan(0);
    expect(depthPos).toBeGreaterThan(0);
    expect(rule5Pos).toBeLessThan(depthPos);
    expect(rule6Pos).toBeLessThan(depthPos);
  });
});
