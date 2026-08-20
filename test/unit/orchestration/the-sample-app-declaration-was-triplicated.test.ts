// THE SAME CODELINE DECLARATION WAS WRITTEN OUT IN THREE PLACES.
//
// run-agent-orchestration.sh carried it as heredocs and FABRICATED it for client codelines it had
// never inspected — fixed separately. The other two copies are in tier3-travel-app-run.sh and
// tier3-skyscanner-app-run.sh, and those are NOT the same defect: both launchers scaffold a sample
// app they own, so declaring it is Node with vitest is a fact about something they create, not an
// assertion about somebody else's repository.
//
// What is wrong is that there are two copies of it, for one app. Both launchers target the same
// codeline — tier3-travel-app-run.sh's own header says "Travel App (Skyscanner)" and both default
// OUTPUT_DIR to the same directory — and the copies had already drifted: travel declares
// `vendorCacheExcludePatterns` and skyscanner does not.
//
// The third copy proves the point on its own: tier3-skyscanner-app-run.sh's known-fixes heredoc is
// byte-identical to orchestrations/projects/skyscanner/known-fixes.json, which already existed. The
// per-project config directory is where this belongs and the convention was already there.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const PROJECT = join(ROOT, 'orchestrations/projects/skyscanner');
const LAUNCHERS = ['tier3-travel-app-run.sh', 'tier3-skyscanner-app-run.sh'];
const MANIFESTS = ['dependency-check.json', 'contract-generation.json', 'known-fixes.json'];

describe('the declaration lives with the project', () => {
  for (const m of MANIFESTS) {
    it(`${m} is in the project config directory`, () => {
      expect(existsSync(join(PROJECT, m)), `${m} is not where the project keeps its config`).toBe(true);
    });

    it(`${m} is valid JSON`, () => {
      expect(() => JSON.parse(readFileSync(join(PROJECT, m), 'utf8'))).not.toThrow();
    });
  }

  it('and keeps the field that had drifted between the two copies', () => {
    // travel declared vendorCacheExcludePatterns and skyscanner did not. Dropping it on
    // consolidation would lose real configuration to a tidy-up.
    const dep = JSON.parse(readFileSync(join(PROJECT, 'dependency-check.json'), 'utf8'));
    expect(dep.vendorCacheExcludePatterns).toEqual(['.vite/*']);
  });

  it('and the declaration a sample app OWNS is kept, not stripped', () => {
    // requiredDevDependencies is an imposition on a CLIENT repo and was removed there. For an app
    // these launchers create themselves it is a statement about what they will build.
    const dep = JSON.parse(readFileSync(join(PROJECT, 'dependency-check.json'), 'utf8'));
    expect(dep.requiredDevDependencies).toContain('vitest');
    expect(dep.manifestFile).toBe('package.json');
  });
});

describe('no launcher carries its own copy', () => {
  for (const l of LAUNCHERS) {
    it(`${l} writes no manifest from a heredoc`, () => {
      const src = readFileSync(join(SCRIPTS, l), 'utf8');
      expect(src, `${l} still embeds the declaration`)
        .not.toMatch(/DEPCHECK_EOF|CONTRACTGEN_EOF|KNOWNFIXES_EOF/);
    });

    it(`${l} takes them from the project config directory instead`, () => {
      const src = readFileSync(join(SCRIPTS, l), 'utf8');
      expect(src).toMatch(/projects\/skyscanner|EPAM_PROJECT_CONFIG_DIR/);
      expect(src, `${l} does not copy the manifests anywhere`).toMatch(/dependency-check\.json/);
    });
  }

  it('and the scan is real — the launchers exist and are non-trivial', () => {
    for (const l of LAUNCHERS) {
      expect(readFileSync(join(SCRIPTS, l), 'utf8').length).toBeGreaterThan(2000);
    }
  });
});
