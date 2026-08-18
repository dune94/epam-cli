/**
 * THE MINT WAS TOLD IT MAY USE A NAME SHAPE THE PIPELINE CANNOT ROUTE.
 *
 * The agent-proposal template said:
 *
 *     name: kebab-case role name ending in "-engineer" or "-specialist"
 *
 * The registry resolves twenty name-shape rules and `specialist` is in none of them, so
 * resolveSeam throws on every name of that shape:
 *
 *     react-frontend-engineer   -> story-writer
 *     auth-security-specialist  -> THROWS: resolves to no seam
 *
 * Half the vocabulary the mint was authorised to use kills the run at mint, and which half it
 * picks is the model's choice of wording. mock3 happened to answer `typescript-vitest-engineer`.
 *
 * TWO LISTS OF THE SAME THING. The naming vocabulary lived as English in the template and as
 * regexes in the registry, with nothing keeping them in sync — and a third copy in the response
 * schema's description of `name`. The registry already declares everything needed: each
 * seamPattern carries the `kind` it serves (implementer / investigator) and the seam it routes to.
 *
 * So the prompt and the schema are DERIVED from the registry, and the mint can only be offered a
 * shape that resolves. That is what makes resolveSeam's final throw an invariant about the
 * registry rather than a guard against a contradiction the pipeline handed the model itself.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { mintNameVocabulary, mintNameRule } from '../../../src/scaffold/seamVocabulary';
import { getAgentProposalPrompt } from '../../../src/scaffold/prompts';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveSeam } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));
const registry = JSON.parse(
  readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));

describe('the mint was offered a suffix nothing routes', () => {
  it('DERIVES A VOCABULARY AT ALL — and not an empty one', () => {
    // Guard against a vacuous pass: every assertion below is trivially true over an empty map.
    const vocab = mintNameVocabulary(registry);
    expect(Object.keys(vocab).length, 'no kinds were derived from the registry').toBeGreaterThan(0);
    for (const [kind, suffixes] of Object.entries(vocab)) {
      expect(suffixes.length, `kind '${kind}' was derived with no suffixes`).toBeGreaterThan(0);
    }
  });

  it('EVERY SUFFIX OFFERED RESOLVES — to a seam serving that same kind', () => {
    const vocab = mintNameVocabulary(registry);
    for (const [kind, suffixes] of Object.entries(vocab)) {
      for (const suffix of suffixes) {
        const name = `some-domain-${suffix}`;
        const seam = resolveSeam(name);
        expect(seam, `'${name}' was offered to the mint and resolves to nothing`).toBeTruthy();
        // The rule that matched must be one declared for THIS kind, or the roster would be
        // routed to a seam that does different work than the kind promises.
        const kindsForSeam = registry.seamPatterns
          .filter((r: any) => r.seam === seam && r.kind)
          .map((r: any) => r.kind);
        expect(kindsForSeam, `'${name}' routes to '${seam}', which serves ${kindsForSeam.join('/') || 'no declared kind'}`)
          .toContain(kind);
      }
    }
  });

  it('THE RENDERED PROMPT OFFERS ONLY SHAPES THAT RESOLVE — the negative assertion', () => {
    const prompt = getAgentProposalPrompt();
    expect(prompt.length, 'the prompt rendered empty, so every check below proves nothing')
      .toBeGreaterThan(200);

    // Every "-word" the prompt quotes as a name shape must resolve. Read out of the prompt
    // itself rather than compared against a list written here, so a suffix added to the text by
    // hand — the way `-specialist` arrived — is caught rather than assumed absent.
    const quoted = [...prompt.matchAll(/"-([a-z][a-z0-9]*)"/g)].map((m) => m[1]);
    expect(quoted.length, 'the prompt quotes no name shape at all').toBeGreaterThan(0);
    for (const suffix of quoted) {
      expect(() => resolveSeam(`some-domain-${suffix}`),
        `the prompt offers "-${suffix}", which resolves to no seam and kills the run at mint`)
        .not.toThrow();
    }
  });

  it('names every kind the registry declares, so no kind is silently unavailable', () => {
    const prompt = getAgentProposalPrompt();
    const declared = new Set(registry.seamPatterns.map((r: any) => r.kind).filter(Boolean));
    for (const kind of declared) {
      expect(prompt, `the mint is never told it may propose a '${kind}'`).toContain(kind as string);
    }
  });

  it('the rule text is derived, not written — changing the registry changes the prompt', () => {
    // A registry with one rule for one kind must produce a rule naming that suffix and no other.
    const only = {
      profiles: { 'story-writer': { produces: 'implementation' } },
      seamPatterns: [{ match: '(^|-)wrangler$', seam: 'story-writer', kind: 'implementer' }],
    };
    const rule = mintNameRule(only as any);
    expect(rule, 'the derived rule does not name the registry\'s own suffix').toContain('wrangler');
    expect(rule, 'the derived rule carries a suffix the registry does not declare')
      .not.toContain('engineer');
  });
});
