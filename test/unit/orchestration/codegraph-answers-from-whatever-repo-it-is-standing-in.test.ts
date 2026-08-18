/**
 * codegraph_query ANSWERS FROM THE PROCESS CWD, SO A MULTI-CODELINE AGENT QUERIES ONE REPO.
 *
 *   codegraph-plugin.js    const projectRoot = process.cwd();  env: { PROJECT_ROOT: projectRoot }
 *   codegraph-agent-query  REPO="${PROJECT_ROOT:-$(pwd)}"      codegraph explore … --path "$REPO"
 *
 * There is no way to ask the tool about a different codeline. Collide that with the estate survey,
 * which exists to sweep EVERY codeline — "For EVERY codeline above, OPEN IT and decide whether this
 * work reaches it" — while mint-agents-step resolves ONE repoPath for the whole estate.
 *
 * Live 2026-08-17, run 20260817T183930Z. Every query about mockb was answered from mocka's index,
 * with no error, because from the tool's side nothing was wrong. The survey reported mockb
 * in_scope on src/fares.ts (mockb has only schedule.ts), tried to read it, got a correct ENOENT and
 * concluded its tools were broken. The mint then briefed an implementer to apply the SAME fare fix
 * to both repositories, and MOCK3-2 — the actual mockb defect — vanished from the roster entirely.
 *
 * A missing index is NOT the cause: codegraph-agent-query.sh self-heals by indexing REPO on demand.
 * mock-b had no index precisely because it was never the REPO. Pre-building indexes would leave the
 * contamination untouched.
 *
 * The codebase already documented this class for the builtin tools — "read_file/list_files/search
 * resolve paths via path.resolve against the CLI process's OWN cwd — none of them consult
 * PROJECT_ROOT" — and nobody connected codegraph_query to it.
 *
 * THE FIX: the call names its codeline, resolved from what the run already publishes. Ambiguity is
 * the defect, so cwd stays the default ONLY when the scope holds one codeline; with several in
 * scope and none named, it must refuse rather than silently answer from a neighbour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const PLUGIN = join(ROOT, 'orchestrations/plugins/codegraph-plugin.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require(PLUGIN);

let work: string;
let a: string;
let b: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'cg-scope-'));
  a = join(work, 'repo-a');
  b = join(work, 'repo-b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
});
afterEach(() => {
  delete process.env.EPAM_CODELINE_PATHS;
  delete process.env.EPAM_PROJECT_OUTPUT_DIR;
  rmSync(work, { recursive: true, force: true });
});

/** The artefact discovery already writes: the run's own name -> path record. */
function publishScope(codelines: Array<{ name: string; path: string }>) {
  const logs = join(work, 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'codeline-discovery.json'), JSON.stringify({ codelines }));
  process.env.EPAM_PROJECT_OUTPUT_DIR = logs;
}

describe('codegraph answers from whatever repo it is standing in', () => {
  it('the resolver is reachable', () => {
    expect(typeof plugin.resolveQueryRepo,
      'nothing resolves which codeline a query is about').toBe('function');
  });

  it('A NAMED CODELINE WINS over the process cwd — the whole defect', () => {
    publishScope([{ name: 'aaa', path: a }, { name: 'bbb', path: b }]);
    const r = plugin.resolveQueryRepo({ codeline: 'bbb' }, { cwd: a });
    expect(r.ok, r.error).toBe(true);
    expect(r.repo, 'a query about bbb was answered from the cwd repo').toBe(b);
  });

  it('SEVERAL IN SCOPE AND NONE NAMED IS AN ERROR, not a silent cwd answer', () => {
    // This is what produced a roster briefing a fare fix into a repo with no fare code.
    publishScope([{ name: 'aaa', path: a }, { name: 'bbb', path: b }]);
    const r = plugin.resolveQueryRepo({}, { cwd: a });
    expect(r.ok, 'an ambiguous query silently answered from the cwd').toBe(false);
    expect(r.error, 'the error does not say which codelines it could have meant').toMatch(/aaa/);
    expect(r.error).toMatch(/bbb/);
    expect(r.error, 'the error does not name the field to supply').toMatch(/codeline/);
  });

  it('ONE in scope and none named still uses it — the unambiguous case is not broken', () => {
    // Single-codeline agents (the detective) never name a codeline and must keep working.
    publishScope([{ name: 'aaa', path: a }]);
    const r = plugin.resolveQueryRepo({}, { cwd: a });
    expect(r.ok, r.error).toBe(true);
    expect(r.repo).toBe(a);
  });

  it('no published scope at all falls back to the cwd, as before', () => {
    // Plenty of callers run outside a discovered estate; this must not become a hard failure.
    const r = plugin.resolveQueryRepo({}, { cwd: a });
    expect(r.ok, r.error).toBe(true);
    expect(r.repo).toBe(a);
  });

  it('an unknown codeline names what IS in scope rather than guessing', () => {
    publishScope([{ name: 'aaa', path: a }, { name: 'bbb', path: b }]);
    const r = plugin.resolveQueryRepo({ codeline: 'ccc' }, { cwd: a });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ccc/);
    expect(r.error, 'it does not say what was available').toMatch(/aaa/);
  });

  it('EPAM_CODELINE_PATHS is honoured too — the loop exports it before discovery lands', () => {
    process.env.EPAM_CODELINE_PATHS = `${a},${b}`;
    const r = plugin.resolveQueryRepo({}, { cwd: a });
    expect(r.ok, 'two paths in scope were treated as unambiguous').toBe(false);
    expect(r.error).toMatch(/codeline/);
  });

  it('the tool ADVERTISES the field, or no agent can use it', () => {
    const tool = (plugin.tools || []).find((t: any) => t.name === 'codegraph_query');
    expect(tool, 'the codegraph_query tool is not exported').toBeTruthy();
    // The plugin API nests the schema under `definition`; find the properties wherever they live
    // rather than assuming a shape, so this asserts the AGENT-VISIBLE contract.
    const def: any = tool.definition || {};
    const props = (def.inputSchema && def.inputSchema.properties)
      || (def.input_schema && def.input_schema.properties)
      || (def.parameters && def.parameters.properties);
    expect(props, 'the codegraph_query schema is not reachable').toBeTruthy();
    expect(Object.keys(props), 'agents cannot name a codeline because the schema has no field for it')
      .toContain('codeline');
  });

  it('RESOLUTION IS DERIVED — no repository path or codeline name in the plugin', () => {
    const src = readFileSync(PLUGIN, 'utf8')
      .split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    expect(src, 'an absolute path was baked into the plugin').not.toMatch(/\/(home|Users)\//);
    expect(src, 'the plugin names a codeline').not.toMatch(/mock[-]?[ab]|metrolinx|gotransit/i);
  });
});
