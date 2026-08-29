/**
 * THE REPLY THAT FAILED IS THE ONLY EVIDENCE OF WHY.
 *
 * content-retry gives up after N attempts and prints "what it actually returned (first 2000
 * chars)". The rest is discarded — the reply exists nowhere on disk.
 *
 * On 2026-08-29 the agent-mint rejected its answer three times as having no "proposedAgents"
 * array, having received `[{"proposedAgents":[...]}]`. A fix to unwrap that envelope was written,
 * tested and committed — and the next paid run failed identically. Whether the array held one
 * element (the fix should have fired) or several (it correctly refuses) could not be established,
 * because the log cut off at 2000 characters and nothing kept the rest.
 *
 * So the next step was a guess, and the pipeline's own rule is that anything it generates is
 * written to disk at generation time. A rejected reply is exactly the artefact a person needs.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require_ = createRequire(import.meta.url);
const { retryUntilParsed } = require_(join(__dirname, '../../../orchestrations/scripts/lib/content-retry.js'));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A reply longer than the excerpt, so truncation is observable. */
const LONG = `[{"proposedAgents":[{"name":"gotransit-checkout-investigator","pad":"${'x'.repeat(4000)}"}]}]`;

function runGiveUp() {
  const dir = mkdtempSync(join(tmpdir(), 'reply-')); dirs.push(dir);
  try {
    retryUntilParsed({
      call: () => LONG,
      parse: () => ({ ok: false, reason: 'the response had no "proposedAgents" array' }),
      attempts: 2,
      what: 'agent-mint proposals',
      logDir: dir,
    });
  } catch { /* giving up is the point */ }
  return dir;
}

describe('A REJECTED REPLY IS KEPT WHOLE', () => {
  it('writes the full reply to disk, not a 2000-char excerpt', () => {
    const dir = runGiveUp();
    const files = readdirSync(dir).filter((f) => /reject|reply|raw/i.test(f));
    expect(files.length, 'the reply that failed exists nowhere — the next step has to be a guess')
      .toBeGreaterThan(0);
    const body = readFileSync(join(dir, files[0]), 'utf8');
    expect(body.length, 'the persisted copy is truncated too').toBeGreaterThan(4000);
    expect(body).toContain('gotransit-checkout-investigator');
  });

  it('names what was being parsed, so the file can be found later', () => {
    const dir = runGiveUp();
    const files = readdirSync(dir).filter((f) => /reject|reply|raw/i.test(f));
    expect(files.join(' ')).toMatch(/agent-mint|proposals/);
  });
});
