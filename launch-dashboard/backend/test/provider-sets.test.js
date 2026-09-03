/**
 * provider-sets.js — the picker's source of truth. NEVER hardcoded: a 5th set added to
 * orchestrations/config/provider-sets.json must become selectable with no dashboard code change.
 *
 *   node --test launch-dashboard/backend/test/
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProviderSets, listProviderSets, isKnownProviderSet } from '../src/provider-sets.js';

let tmp;
let file;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-sets-'));
  file = path.join(tmp, 'provider-sets.json');
});

function write(sets) {
  fs.writeFileSync(file, JSON.stringify({ sets }));
}

describe('provider-sets.js', () => {
  test('lists every set declared in the file, name and description', () => {
    write({
      claude: { description: 'Plain Claude Code.' },
      openrouter: { description: 'OpenRouter and MiniMax.' },
    });
    const list = loadProviderSets(file);
    assert.deepEqual(
      list.map((s) => s.name).sort(),
      ['claude', 'openrouter'],
    );
    const claude = list.find((s) => s.name === 'claude');
    assert.equal(claude.description, 'Plain Claude Code.');
  });

  test('a set added to the file alone — no code change — becomes listed', () => {
    // The proof this is config-driven, not a hardcoded enum: a name no code here could possibly
    // have anticipated becomes visible purely from the file.
    write({ 'a-fabricated-vendor-set': { description: 'fabricated for this test' } });
    const list = loadProviderSets(file);
    assert.deepEqual(list.map((s) => s.name), ['a-fabricated-vendor-set']);
  });

  test('isKnownProviderSet is true only for a name actually declared in the file', () => {
    write({ claude: { description: 'x' }, mockserver: { description: 'y' } });
    assert.equal(isKnownProviderSet('claude', file), true);
    assert.equal(isKnownProviderSet('mockserver', file), true);
    assert.equal(isKnownProviderSet('not-a-real-set', file), false);
  });

  test('an unreadable file fails LOUDLY — never an empty, silently-accepted list', () => {
    assert.throws(() => loadProviderSets(path.join(tmp, 'does-not-exist.json')), /provider-sets/i);
  });

  test('malformed JSON fails loudly, not with a silently empty list', () => {
    fs.writeFileSync(file, 'not json');
    assert.throws(() => loadProviderSets(file));
  });

  test('listProviderSets() (no arg) reads PROVIDER_SETS_FILE from the environment', () => {
    write({ claude: { description: 'x' } });
    const prev = process.env.PROVIDER_SETS_FILE;
    process.env.PROVIDER_SETS_FILE = file;
    try {
      assert.deepEqual(listProviderSets().map((s) => s.name), ['claude']);
    } finally {
      if (prev === undefined) delete process.env.PROVIDER_SETS_FILE;
      else process.env.PROVIDER_SETS_FILE = prev;
    }
  });
});
