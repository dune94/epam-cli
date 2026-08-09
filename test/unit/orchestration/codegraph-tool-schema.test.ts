/**
 * A TOOL'S CONTRACT BELONGS IN ITS SCHEMA, NOT IN A PARAGRAPH THE MODEL HAS TO OBEY.
 *
 * codegraph_query is the tool that exists so agents stop grepping. Its schema was:
 *
 *     mode: { type: 'string', enum: MODES }     // validated by the provider
 *     args: { type: 'string', description: 'domain nouns for explore/helpers, a symbol name for
 *             query/callers/callees/impact, or "<file> [startLine] [endLine]" for show' }
 *
 * `mode` is machine-checked. `args` means five different things and is checked by nobody: the
 * handler split it on whitespace and passed it through, so a wrong shape reached the query
 * script and came back as prose the model had to read, interpret and retry. Every one of those
 * is a paid round trip that a schema can make impossible instead.
 *
 * The other three plugins declare eight inputSchemas between them with ZERO enum constraints, so
 * this is the pattern rather than one tool's oversight.
 *
 * Deliberately NOT done here: token savings are not the argument. All four plugin descriptions
 * total ~3.5KB, while the writer prompt's file injection is 34,510 chars — claiming a token win
 * from schema tightening would be wrong by an order of magnitude. The argument is correctness:
 * an invalid call that cannot be expressed is cheaper than one corrected after the fact.
 *
 * Also deliberately kept: the legacy `args` string. Agents mid-run were built against it, and a
 * tool contract that changes underneath a running story is its own outage.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require(join(__dirname, '../../../orchestrations/plugins/codegraph-tools.js'));
const tool = plugin.tools[0];
const schema = tool.definition.inputSchema;
const { buildArgv } = plugin;

describe('the schema expresses the contract', () => {
  it('mode stays enum-constrained', () => {
    expect(schema.properties.mode.enum).toEqual(
      expect.arrayContaining(['explore', 'query', 'callers', 'callees', 'impact', 'helpers', 'show']),
    );
  });

  it('symbol-taking modes have a typed symbol field', () => {
    expect(schema.properties.symbol, 'query/callers/callees/impact still take a free string').toBeTruthy();
    expect(schema.properties.symbol.type).toBe('string');
  });

  it('search modes have a typed terms field', () => {
    expect(schema.properties.terms).toBeTruthy();
  });

  it('show has typed file and line fields, and the lines are numbers', () => {
    expect(schema.properties.file).toBeTruthy();
    expect(schema.properties.startLine.type).toMatch(/integer|number/);
    expect(schema.properties.endLine.type).toMatch(/integer|number/);
  });

  it('only mode is universally required — the rest depend on it', () => {
    expect(schema.required).toEqual(['mode']);
  });

  it('the legacy args string is still accepted, and marked as legacy', () => {
    expect(schema.properties.args).toBeTruthy();
    expect(JSON.stringify(schema.properties.args)).toMatch(/legacy|deprecat/i);
  });
});

describe('buildArgv turns a typed call into the right command', () => {
  it('query takes a symbol', () => {
    expect(buildArgv({ mode: 'query', symbol: 'applyDiscount' })).toEqual({
      ok: true, argv: ['query', 'applyDiscount'],
    });
  });

  it('explore takes multi-word terms', () => {
    expect(buildArgv({ mode: 'explore', terms: 'discount refund' })).toEqual({
      ok: true, argv: ['explore', 'discount', 'refund'],
    });
  });

  it('show takes a file and optional line bounds', () => {
    expect(buildArgv({ mode: 'show', file: 'src/a.ts', startLine: 40, endLine: 90 })).toEqual({
      ok: true, argv: ['show', 'src/a.ts', '40', '90'],
    });
  });

  it('show works with a file alone', () => {
    expect(buildArgv({ mode: 'show', file: 'src/a.ts' })).toEqual({ ok: true, argv: ['show', 'src/a.ts'] });
  });

  it('the legacy args form still produces the same command', () => {
    expect(buildArgv({ mode: 'show', args: 'src/a.ts 40 90' })).toEqual({
      ok: true, argv: ['show', 'src/a.ts', '40', '90'],
    });
    expect(buildArgv({ mode: 'query', args: 'applyDiscount' })).toEqual({
      ok: true, argv: ['query', 'applyDiscount'],
    });
  });

  it('a typed field wins over a legacy args string', () => {
    expect(buildArgv({ mode: 'query', symbol: 'realSymbol', args: 'stale' }).argv)
      .toEqual(['query', 'realSymbol']);
  });
});

describe('a wrong call is refused with the field name, not a paragraph', () => {
  it('query without a symbol says which field is missing', () => {
    const r = buildArgv({ mode: 'query' });
    expect(r.ok).toBe(false);
    expect(r.error, 'the agent is told to re-read prose instead of the missing field').toMatch(/symbol/);
    expect(r.error).toMatch(/query/);
  });

  it('explore without terms names terms', () => {
    expect(buildArgv({ mode: 'explore' }).error).toMatch(/terms/);
  });

  it('show without a file names file', () => {
    expect(buildArgv({ mode: 'show' }).error).toMatch(/file/);
  });

  it('an unknown mode lists the real modes', () => {
    const r = buildArgv({ mode: 'nonsense', symbol: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/explore/);
    expect(r.error).toMatch(/callers/);
  });

  it('line numbers that are not numbers are refused rather than shell-quoted', () => {
    // `startLine: "40; rm -rf /"` reaching argv would be an injection surface as well as a bug.
    const r = buildArgv({ mode: 'show', file: 'src/a.ts', startLine: '40; echo hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/startLine/);
  });

  it('endLine before startLine is refused', () => {
    const r = buildArgv({ mode: 'show', file: 'src/a.ts', startLine: 90, endLine: 40 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/endLine|before|after/i);
  });
});

describe('the tool still executes through the same seam', () => {
  it('execute() reports a structured error when the call is invalid', async () => {
    const out = await tool.execute({ mode: 'query' });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/symbol/);
  });

  it('an invalid mode is refused before anything is spawned', async () => {
    const out = await tool.execute({ mode: 'not-a-mode', symbol: 'x' });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/explore/);
  });
});
