/**
 * THE ANALYST'S SUCCESS MUST NOT DEPEND ON THE WORDING OF A LOG LINE.
 *
 * self-heal.js decides whether the analyst ran by scraping its stderr:
 *
 *     const analysed = /diagnosing\s+\S+\s+via\s+\S+/.test(err);
 *     const declined = rc === 0 && !analysed && !corrective;
 *
 * So a change to one human-readable sentence turns every successful analysis into a "decline".
 * That is the exact failure recorded in this file's own comments — live 2026-08-27, seven refusals
 * with zero healing episodes and zero rc=2, because "the analyst was not failing, it was declining,
 * and the two are indistinguishable from the outside". The detection was rebuilt in a form that can
 * break the same way, silently, on an edit nobody would think twice about.
 *
 * The caller already controls the child's environment, so it can DECLARE the marker it will look
 * for and the analyst can echo it back. Then the two cannot drift: there is one string, chosen by
 * the reader, and prose is free to change.
 *
 * Proven by MUTATION — the log wording is changed on disk, md5 checked, and the verdict must
 * survive it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LADDERS } from '../helpers/seam-receiver';

const REPO = join(__dirname, '../..');
const ANALYST = join(REPO, 'orchestrations/scripts/agent-attempt-analyst.sh');
const md5 = (p: string) => createHash('md5').update(readFileSync(p)).digest('hex');

/** A project the analyst can actually analyse for, with the runner stubbed. */
function fixture() {
  const work = mkdtempSync(join(tmpdir(), 'self-heal-'));
  const proj = join(work, 'proj');
  mkdirSync(join(proj, 'prompts'), { recursive: true });
  copyFileSync(join(REPO, 'orchestrations/prompts/templates/agent-failure-analyst.json'),
    join(proj, 'prompts/agent-failure-analyst.json'));
  writeFileSync(join(proj, 'llm-settings.json'), '{}');
  writeFileSync(join(proj, 'roster.json'), JSON.stringify({
    agents: { 'agent-failure-analyst': { persona: 'You diagnose a failed attempt.', kind: 'analyst' } },
  }));
  const stub = join(work, 'stub');
  writeFileSync(stub, '#!/usr/bin/env bash\ncat > /dev/null\nprintf "%s" "RETRY WITH: narrow the change"\n');
  chmodSync(stub, 0o755);
  return { work, proj, stub };
}

/** What self-heal.js reports for a real analyst run. */
function selfHeal(f: ReturnType<typeof fixture>) {
  const out = execFileSync(process.execPath, ['-e', `
    const sh = require(${JSON.stringify(join(REPO, 'orchestrations/scripts/lib/self-heal.js'))});
    const r = sh.selfHeal({
      reason: 'no_output', output: 'the writer produced nothing and exited 1',
      context: 'story S-1, attempt 2 of 3',
      model: 'claude-sonnet-5', provider: 'claude',
      runner: ${JSON.stringify(f.stub)},
      projectConfigDir: ${JSON.stringify(f.proj)},
      logDir: ${JSON.stringify(f.work)},
    });
    process.stdout.write(JSON.stringify({ rc: r.rc, analysed: r.analysed, declined: r.declined }));
  `], { encoding: 'utf8', timeout: 120000, cwd: REPO,
    env: { ...process.env, ...LADDERS, EPAM_PROVIDER_SET: 'claude', CLAUDE_CMD: f.stub } });
  return JSON.parse(out);
}

describe('the analyst\'s success does not depend on the wording of a log line', () => {
  it('a real analysis is reported as analysed, not declined', () => {
    const r = selfHeal(fixture());
    expect(r.rc, 'the analyst reported failure on a run that should succeed').toBe(0);
    expect(r.analysed, 'a successful analysis was not recognised as one').toBe(true);
    expect(r.declined, 'a successful analysis was reported as a decline').toBe(false);
  }, 180_000);

  it('and it survives the log sentence being reworded', () => {
    // The mutation this exists for. Nothing about the analyst's BEHAVIOUR changes here — only the
    // prose it prints — and the caller's verdict must be unaffected.
    const before = md5(ANALYST);
    const src = readFileSync(ANALYST, 'utf8');
    const reworded = src.replace(/diagnosing /g, 'now examining ');
    expect(reworded, 'the log sentence this scrapes no longer exists — the shape has changed')
      .not.toBe(src);
    writeFileSync(ANALYST, reworded);
    try {
      const after = md5(ANALYST);
      expect(after, 'the mutation did not apply').not.toBe(before);
      const r = selfHeal(fixture());
      expect(r.analysed,
        'rewording one log sentence turned a successful analysis into a decline — the caller is '
        + 'scraping prose to decide whether the analyst ran').toBe(true);
      expect(r.declined).toBe(false);
    } finally {
      writeFileSync(ANALYST, src);
      expect(md5(ANALYST), 'the analyst was not restored').toBe(before);
    }
  }, 180_000);
});
