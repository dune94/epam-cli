/**
 * ONE LIST, ONE HOME.
 *
 * src/auth/types.ts declares `type ProviderName = 'anthropic' | 'openai' | 'gemini'` — and a type
 * vanishes at runtime, so four runtime arrays grew up beside it: provider.ts, doctor.ts, keys.ts
 * and UserCommand.ts. Found by the hardcoding audit on 2026-08-28, already drifted: three carried
 * three providers and the fourth carried six.
 *
 * The fourth is not simply stale — it enumerates providers the CLI can hold CREDENTIALS for, which
 * legitimately includes ones with no LLM implementation (codex, copilot, codemie). Two concepts,
 * not one list copied wrong. So neither is deleted: the LLM providers get a single runtime source
 * with the type derived from it, and the credential list is derived from the credential maps that
 * already exist, so adding a provider to a map cannot leave the list behind.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('THE LLM PROVIDER LIST IS DECLARED ONCE', () => {
  it('auth/types.ts exports a runtime list, not only a type', () => {
    // A type cannot be iterated, which is exactly why the copies appeared.
    expect(read('src/auth/types.ts'),
      'ProviderName is a type only, so every caller that needs to ITERATE providers must write the '
      + 'list again — which is how four copies appeared and one drifted')
      .toMatch(/export const PROVIDER_NAMES/);
  });

  it('the type is derived from that list, so they cannot disagree', () => {
    expect(read('src/auth/types.ts')).toMatch(/typeof PROVIDER_NAMES\[number\]/);
  });

  for (const f of ['src/cli/commands/provider.ts', 'src/cli/commands/doctor.ts', 'src/cli/commands/keys.ts']) {
    it(`${f.split('/').pop()} reads the list instead of repeating it`, () => {
      const src = read(f);
      expect(src, 'the provider list is written out again here')
        .not.toMatch(/\[\s*'anthropic',\s*'openai',\s*'gemini'\s*\]/);
      expect(src, 'nothing imports the single source').toMatch(/PROVIDER_NAMES/);
    });
  }
});

describe('THE CREDENTIAL LIST IS DERIVED FROM THE CREDENTIAL MAPS', () => {
  it('UserCommand does not hand-keep a provider list', () => {
    expect(read('src/cli/repl/commands/UserCommand.ts'),
      'a provider added to ENV_VAR or TOKEN_ENV_VAR would be invisible to `user list`')
      .not.toMatch(/const KNOWN_PROVIDERS = \[\s*'anthropic'/);
  });

  it('every provider with a credential env var is enumerable', () => {
    const src = read('src/cli/repl/commands/UserCommand.ts');
    // derived from the maps that already exist, plus the LLM providers themselves
    expect(src).toMatch(/KNOWN_PROVIDERS[\s\S]{0,200}(ENV_VAR|PROVIDER_NAMES)/);
  });
});
