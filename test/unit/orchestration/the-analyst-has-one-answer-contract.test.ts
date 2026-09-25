/**
 * THE FAILURE ANALYST HAS ONE ANSWER CONTRACT — THE TEMPLATE'S.
 *
 * Its prompt is the persona (profiles.json.original → profiles.json, restored every run by
 * pre-run-reset.sh) substituted at the top of the failure-analyst template. The persona carried a
 * contract of its own — `"target":"prd|tc|skill|kb|none"`, no escalate — above the template's full
 * one. Live 2026-09-24 (regintel REGI-009a) the analyst diagnosed a defect in another story's file
 * twice and answered target=skill both times; the writer then spent 11.4M tokens on a file it did
 * not own. The persona says who the analyst is; the template says how it answers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS = join(__dirname, '../../../orchestrations/agents');
const TPL = join(__dirname, '../../../orchestrations/prompts/templates/failure-analyst.json');
const persona = (f: string) => JSON.parse(readFileSync(join(AGENTS, f), 'utf8'))['failure-analyst'] as string;
const CONTRACT = /"target"\s*:\s*"[a-z|]+"/;

describe('the failure analyst has one answer contract', () => {
  for (const f of ['profiles.json.original', 'profiles.canonical.json']) {
    it(`${f}: the persona states no answer contract of its own`, () => {
      const p = persona(f);
      expect(p.length, 'no persona — nothing tested').toBeGreaterThan(100);
      expect(p, 'the persona still carries its own JSON answer contract').not.toMatch(CONTRACT);
      expect(p, 'the persona still restricts the targets').not.toMatch(/target=none: spec and skills are correct/);
    });
  }

  it('the template carries the one contract, and it offers escalate', () => {
    const body = JSON.parse(readFileSync(TPL, 'utf8')).body as string;
    const contracts = body.match(new RegExp(CONTRACT.source, 'g')) || [];
    expect(contracts.length).toBe(1);
    expect(contracts[0]).toContain('escalate');
  });

  it('the rendered prompt — persona at the top of the template — carries exactly one contract', () => {
    const body = JSON.parse(readFileSync(TPL, 'utf8')).body as string;
    expect(body).toContain('__ANALYST_PROFILE__');
    const rendered = body.replace('__ANALYST_PROFILE__', persona('profiles.json.original'));
    expect((rendered.match(new RegExp(CONTRACT.source, 'g')) || []).length).toBe(1);
  });
});
