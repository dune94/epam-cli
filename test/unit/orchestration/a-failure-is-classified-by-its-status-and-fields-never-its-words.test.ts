/**
 * A FAILED CALL IS CLASSIFIED BY ITS STATUS AND ITS STRUCTURED FIELDS — NEVER BY ITS WORDS.
 *
 * The copilot and codemie-web plugins read a failure's class out of its English ("insufficient",
 * "unauthorized", "rate limit", "plugin") — a vendor rewording, a translated message, or a model's own
 * prose quoted in an error flips a story into a halt (credit, auth) or out of one (review of
 * 2026-09-29, item 2). Both vendors say why a call failed in fields made for it: an HTTP status,
 * CodeMie's `error_code` enum (codemie-sdk ErrorCode), Copilot's `session.error` `errorType` /
 * `errorCode`, Node's system error `code`. The class is read from those, through the declared maps
 * (config/failure-classes.json, each plugin's failures.json), and from nothing else.
 *
 * Executed: the plugins' real judges on the shapes the vendors emit (Copilot's taken from recorded
 * session-state events; CodeMie's from the SDK's AgentErrorDetails / ApiError). Each case pairs a
 * structured cause with words that point the other way, so a word-reader and a field-reader disagree.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const PROVIDERS = join(ROOT, 'orchestrations/plugins/providers');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** codemie-web: the real judge on a chat response (r) or a thrown ApiError-shaped error (err). */
function codemie(input: { r?: unknown; err?: Record<string, unknown> }) {
  const out = spawnSync(process.execPath, ['-e', `
    const { judge } = require(${JSON.stringify(join(PROVIDERS, 'codemie-web/result.js'))});
    const i = JSON.parse(process.argv[1]);
    const err = i.err ? Object.assign(new Error(i.err.message || ''), i.err) : undefined;
    process.stdout.write(JSON.stringify(judge({ r: i.r, err, model: 'm' })));
  `, JSON.stringify(input)], { encoding: 'utf8' });
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout);
}

/** copilot: the real normaliser (its CLI, as the runner calls it) on one call's events and stderr. */
function copilot(events: object[], stderr = '') {
  const d = mkdtempSync(join(tmpdir(), 'fc-')); dirs.push(d);
  writeFileSync(join(d, 'e.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(d, 'e.stderr'), stderr);
  spawnSync(process.execPath, [join(PROVIDERS, 'copilot/copilot-result.js'), join(d, 'e.jsonl'), join(d, 'e.stderr'), join(d, 'r.json')], { encoding: 'utf8' });
  return JSON.parse(readFileSync(join(d, 'r.json'), 'utf8'));
}
const sessionError = (data: Record<string, unknown>) => ({ type: 'session.error', id: 'e1', data });

describe('codemie-web: the status and the error_code decide', () => {
  it('a 402 is credit, whatever it says', () => {
    expect(codemie({ err: { statusCode: 402, message: 'hello' } }).error.class).toBe('credit');
  });
  it('a 503 is transient even when its words say quota', () => {
    expect(codemie({ err: { statusCode: 503, message: 'insufficient quota, budget exceeded' } }).error.class).toBe('transient');
  });
  it('a connection refused (Node system code) is transient', () => {
    expect(codemie({ err: { code: 'ECONNREFUSED', message: 'connect' } }).error.class).toBe('transient');
  });
  it('agent_budget_exceeded is credit, even worded blandly', () => {
    expect(codemie({ r: { success: false, generated: '', agent_error: { error_code: 'agent_budget_exceeded', message: 'stopped' } } }).error.class).toBe('credit');
  });
  it('llm_rate_limited is rate_limit', () => {
    expect(codemie({ r: { success: false, generated: '', agent_error: { error_code: 'llm_rate_limited', message: 'x' } } }).error.class).toBe('rate_limit');
  });
  it('an internal error worded as quota and unauthorised is neither credit nor auth', () => {
    const c = codemie({ r: { success: false, generated: '', agent_error: { error_code: 'agent_internal_error', message: 'Unauthorized: insufficient quota, not signed in' } } }).error.class;
    expect(c).not.toBe('credit'); expect(c).not.toBe('auth'); expect(c).toBe('provider');
  });
  it('an error with no status and no code is provider, whatever its words', () => {
    expect(codemie({ err: { message: 'Unauthorized — insufficient credit — rate limit — plugin' } }).error.class).toBe('provider');
  });
  it('no answer with tool errors is the plugin, not an empty reply', () => {
    expect(codemie({ r: { success: true, generated: '', tool_errors: [{ tool_name: '_read_file', error_code: 'tool_execution_failed', message: 'x' }] } }).error.class).toBe('plugin');
  });
  it('an answer is an answer — no class at all', () => {
    const j = codemie({ r: { success: true, generated: 'insufficient quota, unauthorized' } });
    expect(j.is_error).toBe(false); expect(j.result).toBe('insufficient quota, unauthorized');
  });
});

describe('copilot: statusCode, errorType and errorCode decide', () => {
  it('errorCode quota_exceeded alone is credit', () => {
    expect(copilot([sessionError({ errorType: 'query', errorCode: 'quota_exceeded', message: 'hi' })]).error.class).toBe('credit');
  });
  it('errorType quota alone is credit', () => {
    expect(copilot([sessionError({ errorType: 'quota', message: 'hi' })]).error.class).toBe('credit');
  });
  it('a 500 is transient even when its words say insufficient quota', () => {
    expect(copilot([sessionError({ errorType: 'query', statusCode: 500, message: 'insufficient quota exceeded' })]).error.class).toBe('transient');
  });
  it('errorType authentication is auth (recorded shape: no status)', () => {
    expect(copilot([sessionError({ errorType: 'authentication', message: 'please' })]).error.class).toBe('auth');
  });
  it('errorType system_econnreset is transient (recorded shape)', () => {
    expect(copilot([sessionError({ errorType: 'system_econnreset', message: 'Error: read ECONNRESET' })]).error.class).toBe('transient');
  });
  it('a query error worded as unauthorised and rate-limited is provider', () => {
    expect(copilot([sessionError({ errorType: 'query', message: 'Unauthorized: rate limit, insufficient credit' })]).error.class).toBe('provider');
  });
  it('the CLI refusing on stderr with no session event is invocation — whatever the words', () => {
    const j = copilot([], 'error: quota exceeded unauthorized\n');
    expect(j.is_error).toBe(true); expect(j.error.class).toBe('invocation');
  });
});
