/**
 * A pinned codeline scope must actually resolve to repositories.
 *
 * Pinning JIRA_CODELINES makes the scope declared and replayable instead of
 * re-decided by a model each run. The first attempt at it failed the run
 * outright, and silently in the sense that mattered — the pipeline did not say
 * "your scope is malformed", it just produced one bogus lane:
 *
 *   project.outputDirs: [{"codeline":"cdts","path":".../azure.commerce.cdts"}]
 *   story.codeline:     "gotransit upexpress metrolinx"     <- the whole list
 *   [orch] Codeline 'cdts': no stories — skipping
 *   Tier 3 Metrolinx FAILED — stories not completed
 *
 * TWO MISTAKES, both invisible in the config itself:
 *
 *   synthesize-prd-from-jira.js does `JIRA_CODELINES.split(',')`. A
 *   SPACE-separated value is therefore one codeline whose name happens to
 *   contain spaces — syntactically fine, semantically nonsense.
 *
 *   Each name resolves its repository through
 *   `JIRA_WORKTREE_${codeline.toUpperCase()}`. Names without those mappings
 *   point at nothing.
 *
 * A config file cannot fail a type check, so this test does the checking: it
 * parses the real config with the SAME rules the consumer uses, and requires
 * every declared codeline to resolve to a directory that exists on disk. It is
 * deliberately about the CONSUMER's rules rather than "does the file look
 * right" — the file looked right.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG = join(__dirname, '../../../orchestrations/projects/metrolinx/config.env');
const SYNTH = join(__dirname, '../../../orchestrations/scripts/synthesize-prd-from-jira.js');

/** Read a shell-style KEY="value" out of the project config. */
function cfg(key: string): string | undefined {
  const src = readFileSync(CONFIG, 'utf8');
  const m = src.match(new RegExp(`^${key}="?([^"\\n]*)"?$`, 'm'));
  return m ? m[1] : undefined;
}

describe('the consumer\'s parsing rules are what the config must satisfy', () => {
  it('the synthesiser still splits on comma', () => {
    // If this ever changes, the config's separator must change with it — which
    // is the point of asserting it here rather than hardcoding "comma" as lore.
    expect(readFileSync(SYNTH, 'utf8'),
      'JIRA_CODELINES is no longer comma-split; the pinned scope may now be wrong')
      .toMatch(/JIRA_CODELINES\.split\(','\)/);
  });

  it('the synthesiser still resolves paths via JIRA_WORKTREE_<NAME>', () => {
    expect(readFileSync(SYNTH, 'utf8'))
      .toMatch(/JIRA_WORKTREE_\$\{codeline\.toUpperCase\(\)\}/);
  });
});

describe('metrolinx declares a usable scope', () => {
  const raw = cfg('JIRA_CODELINES');

  it('pins the scope at all', () => {
    expect(raw, 'JIRA_CODELINES is unset — discovery decides scope again, and it flip-flopped on c365')
      .toBeTruthy();
  });

  it('parses to three distinct codelines under the consumer\'s own rule', () => {
    const names = (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
    expect(names,
      `parsed as ${names.length} codeline(s): ${JSON.stringify(names)} — a space-separated ` +
      'value yields ONE codeline whose name contains spaces, which is how the ' +
      'first pin produced a single bogus lane')
      .toEqual(['gotransit', 'upexpress', 'metrolinx']);
  });

  it('gives every codeline a worktree path that exists', () => {
    const names = (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const n of names) {
      const key = `JIRA_WORKTREE_${n.toUpperCase()}`;
      const path = cfg(key);
      expect(path, `${n} has no ${key} — it resolves to no repository`).toBeTruthy();
      expect(existsSync(path!), `${key} points at a missing directory: ${path}`).toBe(true);
    }
  });

  it('does not include c365', () => {
    // Inspected 2026-07-29: a .NET CRM integration with zero live-preview code
    // and no node_modules. Discovery asserted the opposite once out of five runs
    // on a scorer tie it labels "CLOSE — genuine ambiguity".
    expect((raw || '').toLowerCase()).not.toContain('c365');
  });
});
