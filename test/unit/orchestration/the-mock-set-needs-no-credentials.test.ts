/**
 * A MOCKED RUN SPENDS NOTHING AND AUTHENTICATES AGAINST NOTHING.
 *
 * Proven 2026-08-25: plain `claude` honours ANTHROPIC_BASE_URL, reaches MockServer
 * (POST /v1/messages in its request log), and PARSES the SSE stream MockServer serves —
 * is_error:false, result:"OK", stop_reason:"end_turn".
 *
 * `--base-url` stays unusable: on the codemie WRAPPER it selects an SSO profile and fails with
 * "SSO credentials not found". So the mock set does not use the wrapper at all — that is the
 * whole point. It runs plain `claude`, which needs no CodeMie and no credentials.
 *
 * THE DANGER THIS GUARDS: a mock set that quietly resolves real models against a real endpoint
 * would spend money while every log line said "mock". So the assertions are about what it must
 * NOT do as much as what it must.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const CFG = join(ROOT, 'orchestrations/config');
const REG = JSON.parse(readFileSync(join(CFG, 'provider-sets.json'), 'utf8'));

const MOCK = Object.entries<any>(REG.sets).find(([n]) => /mockserver/i.test(n));

describe('the mockserver set needs no credentials', () => {
  it('is declared as a set of its own (named `mockserver` — `mock` is prose, `replay` is a provider)', () => {
    expect(MOCK, 'no mockserver set declared').toBeTruthy();
  });

  const file = MOCK ? join(CFG, MOCK[1].settingsFile) : '';
  const j = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;

  it('declares ladders — an empty set resolves NO chain and fails silently', () => {
    expect(j, `missing settings file: ${file}`).toBeTruthy();
    expect(Object.keys(j.ladders || {}).length).toBeGreaterThan(0);
  });

  it('its runner declares NO --base-url — that selects an SSO profile, it does not redirect', () => {
    const runner = Object.values<any>(j.runners || {})[0];
    expect(runner, 'the mock set declares no runner').toBeTruthy();
    const flagNames = Object.keys(runner.flags || {});
    expect(flagNames, '--base-url would make the mock demand credentials').not.toContain('--base-url');
  });

  it('redirects via ANTHROPIC_BASE_URL, which is what plain claude honours', () => {
    const runner = Object.values<any>(j.runners || {})[0];
    const envNames = Object.keys(runner.env || {});
    expect(envNames, 'nothing points the mock at MockServer').toContain('ANTHROPIC_BASE_URL');
  });

  it('every project resolves the mock set without a real credential', () => {
    // The set must not DEPEND on a credential — checked against what it DECLARES, not against
    // the prose. Grepping the whole file for /sso/ flagged the comment explaining why the mock
    // avoids SSO, which is the opposite of a finding.
    const declared = new Set<string>();
    for (const r of Object.values<any>(j.runners || {})) {
      Object.keys(r.env || {}).forEach((k) => declared.add(k));
      Object.values<any>(r.env || {}).forEach((v) => declared.add(String(v)));
      Object.keys(r.flags || {}).forEach((k) => declared.add(k));
    }
    // TOKENS (plural) is a COUNT, not a credential — MAX_OUTPUT_TOKENS tripped a looser regex.
    // A credential is a key, a secret, a bearer token (singular) or a JWT.
    const credentials = [...declared].filter(
      (k) => /API_KEY|SECRET|JWT|CREDENTIAL|\bTOKEN\b/i.test(k) && !/TOKENS$/i.test(k));
    expect(credentials, 'a mocked run must authenticate against nothing').toEqual([]);
  });
});
