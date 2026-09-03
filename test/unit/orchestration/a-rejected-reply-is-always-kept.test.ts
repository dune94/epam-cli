/**
 * EVIDENCE IS NOT OPTIONAL, AND A MISSING logDir IS NOT A REASON TO DROP IT.
 *
 * metrolinx AMSD-1919 died three times on 2026-08-29 with a 3885-character reply the log excerpted
 * at 2000. The full reply was supposed to be persisted beside the run — but the persister took
 * logDir from its caller and returned empty when it had none, so the one artefact that could say
 * whether the envelope held one element or several was never written. The diagnosis needed a
 * second paid run to see what the first already knew.
 *
 * A caller that forgets to say where is not the same as "throw it away".
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { _persistRejected } = require('../../../orchestrations/scripts/lib/content-retry.js');

describe('a rejected reply is always kept', () => {
  it('writes the WHOLE reply when a logDir is given', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rej-'));
    const body = 'x'.repeat(5000);
    const file = _persistRejected(dir, 'agent-mint proposals', body);
    expect(file, 'a logDir was given, so the reply must be kept').toBeTruthy();
    expect(fs.readFileSync(file, 'utf8')).toHaveLength(5000);
  });

  it('still keeps it when the caller gives no logDir', () => {
    const body = '[{"proposedAgents":[]}]';
    const file = _persistRejected('', 'agent-mint proposals', body);
    expect(file, 'no logDir is a caller bug, not a licence to discard the evidence').toBeTruthy();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(body);
  });

  it('returns empty only when there is genuinely nothing to keep', () => {
    expect(_persistRejected('', 'agent-mint proposals', '')).toBe('');
  });
});
