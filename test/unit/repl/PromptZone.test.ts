import { describe, it, expect } from 'vitest';
import { buildPromptZoneLines, PromptZone } from '../../../src/cli/repl/PromptZone.js';

const COLS = 80;
const STATE = { provider: 'copilot', model: 'claude-sonnet-4-6', turns: 0 };

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');

describe('PromptZone separator', () => {
  it('buildPromptZoneLines: has exactly 1 separator (dim, above epam ›)', () => {
    const lines = buildPromptZoneLines(STATE, COLS);
    const plain = lines.map(stripAnsi);
    const sepLines = plain.filter(l => /^─+$/.test(l.trim()));
    expect(sepLines).toHaveLength(1);
  });

  it('buildPromptZoneLines: separator spans full column width', () => {
    const lines = buildPromptZoneLines(STATE, COLS);
    const plain = lines.map(stripAnsi);
    const sep = plain.find(l => /^─+$/.test(l.trim()))!;
    expect(sep.trim().length).toBe(COLS);
  });

  it('buildPromptZoneLines: dim separator comes AFTER header', () => {
    const lines = buildPromptZoneLines(STATE, COLS);
    const plain = lines.map(stripAnsi);
    const headerIdx = plain.findIndex(l => l.includes('copilot/claude-sonnet-4-6'));
    const sepIdx = plain.findIndex(l => /^─+$/.test(l.trim()));
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(sepIdx).toBeGreaterThan(headerIdx);
  });

  it('header contains provider and model', () => {
    const plain = buildPromptZoneLines(STATE, COLS).map(stripAnsi).join('\n');
    expect(plain).toContain('copilot/claude-sonnet-4-6');
  });

  it('header contains turn count', () => {
    const plain = buildPromptZoneLines({ ...STATE, turns: 3 }, COLS).map(stripAnsi).join('\n');
    expect(plain).toContain('3 turns');
  });

  it('header shows singular turn when turns=1', () => {
    const plain = buildPromptZoneLines({ ...STATE, turns: 1 }, COLS).map(stripAnsi).join('\n');
    expect(plain).toContain('1 turn');
    expect(plain).not.toContain('1 turns');
  });

  it('PromptZone class: first render has 1 sep (dim only), second has 2 (gray + dim)', () => {
    const written: string[] = [];
    const mockStream = {
      columns: 80,
      write: (s: string) => { written.push(s); return true; },
    } as unknown as NodeJS.WriteStream;

    const zone = new PromptZone(mockStream);

    zone.render(STATE);
    const firstPlain = stripAnsi(written.join(''));
    const firstSepCount = (firstPlain.match(/^─+$/gm) || []).length;

    written.length = 0;
    zone.render({ ...STATE, turns: 1 });
    const secondPlain = stripAnsi(written.join(''));
    const secondSepCount = (secondPlain.match(/^─+$/gm) || []).length;

    // First render: 1 separator (dim only — no gray sep before first prompt).
    expect(firstSepCount).toBe(1);
    // Second render: 2 separators (gray sep between turns + dim sep above prompt).
    expect(secondSepCount).toBe(2);
  });

  it('PromptZone class: gray separator appears BEFORE header on second render', () => {
    const written: string[] = [];
    const mockStream = {
      columns: 80,
      write: (s: string) => { written.push(s); return true; },
    } as unknown as NodeJS.WriteStream;

    const zone = new PromptZone(mockStream);
    zone.render(STATE);
    written.length = 0;
    zone.render({ ...STATE, turns: 1 });

    const secondPlain = stripAnsi(written.join(''));
    const lines = secondPlain.split('\n');
    const firstSepIdx = lines.findIndex(l => /^─+$/.test(l.trim()));
    const headerIdx = lines.findIndex(l => l.includes('copilot/claude-sonnet-4-6'));

    expect(firstSepIdx).toBeGreaterThanOrEqual(0);
    expect(headerIdx).toBeGreaterThan(firstSepIdx);
  });
});

