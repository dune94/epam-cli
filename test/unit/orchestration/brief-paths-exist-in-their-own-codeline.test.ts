/**
 * A BRIEF MAY NOT NAME A FILE THAT IS NOT IN ITS OWN CODELINE.
 *
 * Live 2026-08-09, AMSD-2041. The estate survey scoped its evidence per codeline, correctly:
 *
 *     gotransit:  contentstack.ts, ContentstackContext.tsx, useContent.ts
 *     upexpress:  contentstack.ts, ContentstackContext.ts
 *     metrolinx:  contentstack.ts                              <- one file, that is all
 *
 * The mint renders all three as one labelled list and writes five briefs from that pooled
 * view. The metrolinx investigator came back citing `src/context/ContentstackContext.tsx` —
 * gotransit's file, and absent from metrolinx — plus `src/providers/`, which exists nowhere.
 * The roster review did not catch it: it raised one checkable finding that run, and this was
 * not it.
 *
 * So the per-codeline survey work was thrown away one step later, and an investigator was
 * dispatched to a file its repository does not contain. That is the failure that cost 120
 * iterations on an earlier run — a writer handed a path its checkout does not have assumes a
 * second file exists, creates it, deletes it, and every retry reproduces the same error.
 *
 * The machinery to prevent this already existed and was pointed at the wrong thing:
 * verify-findings checks path_exists per codeline, but only for claims the REVIEWER chooses to
 * raise. Nothing ever checked the briefs themselves. Discretionary grounding is why the
 * previous roster had zero violations and this one had two — same unguarded process, different
 * sample.
 *
 * This makes it deterministic. No codeline, client or file name appears here: every path is
 * read from the fixture estate the test builds.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roster = require('../../../orchestrations/scripts/lib/agent-roster.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * Three codelines with DIFFERENT file sets — the property that makes this defect possible.
 * Mirrors the live estate: a context module in the first two under different extensions, and
 * a third that has only the shared service.
 */
function estate() {
  const root = mkdtempSync(join(tmpdir(), 'brief-estate-')); dirs.push(root);
  const layout: Record<string, string[]> = {
    alpha: ['src/services/content.ts', 'src/context/ContentContext.tsx', 'src/hooks/useContent.ts'],
    beta: ['src/services/content.ts', 'src/context/ContentContext.ts'],
    gamma: ['src/services/content.ts'],
  };
  const codelines = Object.entries(layout).map(([name, files]) => {
    const repo = join(root, name);
    for (const f of files) {
      mkdirSync(join(repo, f.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(repo, f), '// fixture\n');
    }
    return { name, path: repo };
  });
  return { root, codelines, layout };
}

const check = (brief: string, codeline: string, codelines: any[]) =>
  roster.ungroundedBriefPaths({ systemPrompt: brief, codeline, kind: 'investigator' }, codelines);

describe('the fixture estate really differs between codelines', () => {
  it('the third codeline lacks what the first one has', () => {
    const { codelines, layout } = estate();
    expect(layout.gamma).not.toContain('src/context/ContentContext.tsx');
    expect(layout.alpha).toContain('src/context/ContentContext.tsx');
    expect(codelines.length).toBe(3);
  });
});

describe('a brief grounded in its own codeline passes', () => {
  it('every cited path exists there — nothing flagged', () => {
    const { codelines, layout } = estate();
    const brief = `Own this codeline. Start at ${layout.alpha[0]} and ${layout.alpha[1]}.`;
    expect(check(brief, 'alpha', codelines)).toEqual([]);
  });

  it('a brief citing no paths at all is not flagged', () => {
    const { codelines } = estate();
    expect(check('Investigate how content is fetched. Report what you find.', 'gamma', codelines)).toEqual([]);
  });
});

describe('THE DEFECT: another codeline\'s file is caught', () => {
  it('a path from a sibling codeline is reported', () => {
    const { codelines, layout } = estate();
    const brief = `Start at ${layout.alpha[1]}.`;          // exists in alpha, not gamma
    expect(
      check(brief, 'gamma', codelines),
      "a brief sent an investigator to a file its own repository does not contain",
    ).toEqual([layout.alpha[1]]);
  });

  it('a path that exists in NO codeline is reported', () => {
    const { codelines } = estate();
    expect(check('Look in src/providers/ for the wiring.', 'gamma', codelines)).toContain('src/providers/');
  });

  it('the extension variant matters — a near-miss is still a miss', () => {
    const { codelines, layout } = estate();
    // beta has the .ts form; alpha has .tsx. Citing alpha's spelling for beta is wrong.
    expect(check(`Start at ${layout.alpha[1]}.`, 'beta', codelines)).toEqual([layout.alpha[1]]);
    expect(check(`Start at ${layout.beta[1]}.`, 'beta', codelines)).toEqual([]);
  });

  it('several bad paths are all reported, not just the first', () => {
    const { codelines, layout } = estate();
    const brief = `See ${layout.alpha[1]} and ${layout.alpha[2]} and src/nowhere/x.ts.`;
    expect(check(brief, 'gamma', codelines).length).toBe(3);
  });

  it('a directory reference is checked like any other path', () => {
    const { codelines } = estate();
    expect(check('The wiring lives in src/services/', 'gamma', codelines)).toEqual([]);
    expect(check('The wiring lives in src/context/', 'gamma', codelines)).toContain('src/context/');
  });
});

describe('an implementer spans the estate, so its paths need only exist somewhere', () => {
  const spanning = (brief: string, codelines: any[]) =>
    roster.ungroundedBriefPaths({ systemPrompt: brief, codeline: '*', kind: 'implementer' }, codelines);

  it('a path present in one codeline is accepted', () => {
    const { codelines, layout } = estate();
    expect(spanning(`Wire it at ${layout.alpha[1]}.`, codelines)).toEqual([]);
  });

  it('a path present in none is still reported', () => {
    const { codelines } = estate();
    expect(spanning('Wire it at src/nowhere/x.ts.', codelines)).toContain('src/nowhere/x.ts');
  });
});

/**
 * The check is only worth anything if the MINT applies it. A pure function nothing calls is
 * the shape of every gate in this pipeline that turned out to be inert.
 */
describe('the mint refuses a brief that is not grounded in its codeline', () => {
  function mint(codeline: string, brief: string) {
    const { codelines, root } = estate();
    const profilesPath = join(root, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({ 'canonical-agent': 'CANON' }, null, 2));
    return roster.mergeProjectAgents({
      profilesPath, agentsDir: root, codelines,
      proposals: [{
        name: 'some-investigator', kind: 'investigator', codeline,
        systemPrompt: brief,
        rationale: 'This codeline needs its own investigation of how content is fetched.',
      }],
    });
  }

  it('a grounded brief is minted — the gate is not refusing everything', () => {
    const { layout } = estate();
    const res = mint('alpha', `Own this codeline. Start at ${layout.alpha[1]}.`);
    expect(res.rejected).toEqual([]);
    expect(res.minted.map((m: any) => m.name)).toEqual(['some-investigator']);
  });

  it('THE DEFECT: a brief citing a sibling codeline\'s file is rejected', () => {
    const { layout } = estate();
    const res = mint('gamma', `Start at ${layout.alpha[1]}.`);
    expect(
      res.minted,
      'an investigator was dispatched to a file its own repository does not contain',
    ).toEqual([]);
    expect(res.rejected.length).toBe(1);
  });

  it('the rejection names the offending paths, so a corrective cycle can act on it', () => {
    const { layout } = estate();
    const res = mint('gamma', `Start at ${layout.alpha[1]}.`);
    expect(res.rejected[0].reason).toContain(layout.alpha[1]);
    expect(res.rejected[0].reason).toMatch(/do not exist/i);
  });

  it('and it is not written into profiles.json', () => {
    const { codelines, root, layout } = estate();
    const profilesPath = join(root, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({ 'canonical-agent': 'CANON' }, null, 2));
    roster.mergeProjectAgents({
      profilesPath, agentsDir: root, codelines,
      proposals: [{
        name: 'some-investigator', kind: 'investigator', codeline: 'gamma',
        systemPrompt: `Start at ${layout.alpha[1]}.`,
        rationale: 'This codeline needs its own investigation of how content is fetched.',
      }],
    });
    const written = JSON.parse(require('node:fs').readFileSync(profilesPath, 'utf8'));
    expect(written['some-investigator']).toBeUndefined();
  });
});

/**
 * NO DIRECTORY NAME IS BAKED IN.
 *
 * The first version of this check matched paths with a literal alternation —
 * src|test|tests|lib|app|packages — which is a convention list for one ecosystem. An estate
 * laid out any other way (cmd/, pkg/, internal/, Sources/, source/) would have every brief
 * pass unexamined, and the check would report "grounded" about paths it never looked at. The
 * candidate roots are read from the repositories themselves.
 */
describe('the check works on an estate that shares no naming convention with this one', () => {
  function foreignEstate() {
    const root = mkdtempSync(join(tmpdir(), 'foreign-estate-')); dirs.push(root);
    const layout: Record<string, string[]> = {
      one: ['cmd/server/main.go', 'internal/content/client.go'],
      two: ['cmd/server/main.go'],
    };
    const codelines = Object.entries(layout).map(([name, files]) => {
      const repo = join(root, name);
      for (const f of files) {
        mkdirSync(join(repo, f.split('/').slice(0, -1).join('/')), { recursive: true });
        writeFileSync(join(repo, f), '// fixture\n');
      }
      return { name, path: repo };
    });
    return { codelines, layout };
  }

  it('a grounded path under a non-standard root is not flagged', () => {
    const { codelines, layout } = foreignEstate();
    expect(roster.ungroundedBriefPaths(
      { systemPrompt: `Start at ${layout.one[1]}.`, codeline: 'one', kind: 'investigator' }, codelines,
    )).toEqual([]);
  });

  it('THE HARDCODING: a sibling\'s file under a non-standard root is still caught', () => {
    const { codelines, layout } = foreignEstate();
    expect(
      roster.ungroundedBriefPaths(
        { systemPrompt: `Start at ${layout.one[1]}.`, codeline: 'two', kind: 'investigator' }, codelines,
      ),
      'the path root was not in the engine\'s baked-in list, so the brief went unchecked',
    ).toEqual([layout.one[1]]);
  });

  it('a root that exists in no codeline at all is caught', () => {
    const { codelines } = foreignEstate();
    expect(roster.ungroundedBriefPaths(
      { systemPrompt: 'Look in vendor/thirdparty/x.go', codeline: 'two', kind: 'investigator' }, codelines,
    )).toContain('vendor/thirdparty/x.go');
  });

  it('the module source carries no directory-name vocabulary of its own', () => {
    const src = require('node:fs').readFileSync(
      join(__dirname, '../../../orchestrations/scripts/lib/agent-roster.js'), 'utf8');
    // The alternation that was here named six conventions. Any literal list of directory
    // names in a path matcher is the same defect wearing different words.
    expect(src).not.toMatch(/\(\?:src\|test/);
    expect(src).not.toMatch(/src\|tests?\|lib\|app/);
  });
});

describe('degenerate input does not throw', () => {
  it.each([
    ['no proposal', undefined],
    ['no systemPrompt', { codeline: 'alpha' }],
    ['no codeline', { systemPrompt: 'src/x.ts' }],
  ])('%s', (_l, p) => {
    const { codelines } = estate();
    expect(() => roster.ungroundedBriefPaths(p as any, codelines)).not.toThrow();
  });

  it('an unknown codeline cannot be checked, so nothing is invented', () => {
    const { codelines, layout } = estate();
    expect(roster.ungroundedBriefPaths(
      { systemPrompt: layout.alpha[1], codeline: 'no-such-codeline', kind: 'investigator' }, codelines,
    )).toEqual([]);
  });

  it('an empty codeline list settles nothing rather than flagging everything', () => {
    expect(roster.ungroundedBriefPaths(
      { systemPrompt: 'src/anything.ts', codeline: 'alpha', kind: 'investigator' }, [],
    )).toEqual([]);
  });

  it('a path outside the repo is never resolved against the filesystem', () => {
    const { codelines } = estate();
    const out = roster.ungroundedBriefPaths(
      { systemPrompt: 'see src/../../../etc/passwd', codeline: 'alpha', kind: 'investigator' }, codelines,
    );
    expect(out.every((p: string) => !p.includes('..'))).toBe(true);
  });
});

/**
 * THE SAME LITERAL-RESOLUTION DEFECT, WITH A DIFFERENT SYMPTOM.
 *
 * assessment_apply rejected a bare filename; this rejected an extension-less path. Live
 * 2026-08-09 the mint refused all three investigators in one cycle:
 *
 *   gotransit-...-investigator: brief names 1 path(s) that do not exist in 'gotransit':
 *                               src/hooks/useContent
 *
 * `src/hooks/useContent.ts` exists in all three codelines. The survey itself reported the file
 * that way, without its extension, so the brief inherited the form. The correction loop
 * re-minted and recovered, but it cost a cycle per lane and would have failed permanently on a
 * brief that did not get corrected.
 *
 * A module reference without its extension is how TypeScript and every bundler name a file —
 * `import { useContent } from 'hooks/useContent'` is the normal spelling. Requiring the
 * extension makes the check reject the codebase's own convention.
 */
describe('an extension-less module path resolves to the real file', () => {
  function estateWithModule() {
    const root = mkdtempSync(join(tmpdir(), 'ext-estate-')); dirs.push(root);
    const repo = join(root, 'one');
    mkdirSync(join(repo, 'src', 'hooks'), { recursive: true });
    writeFileSync(join(repo, 'src', 'hooks', 'useContent.ts'), 'export const useContent = 1;\n');
    mkdirSync(join(repo, 'src', 'context'), { recursive: true });
    writeFileSync(join(repo, 'src', 'context', 'Ctx.tsx'), 'export const C = 1;\n');
    return [{ name: 'one', path: repo }];
  }
  const check = (brief: string, codelines: any[]) =>
    roster.ungroundedBriefPaths({ systemPrompt: brief, codeline: 'one', kind: 'investigator' }, codelines);

  it('the fixture really lacks the extension-less file', () => {
    const cls = estateWithModule();
    expect(require('node:fs').existsSync(join(cls[0].path, 'src/hooks/useContent'))).toBe(false);
    expect(require('node:fs').existsSync(join(cls[0].path, 'src/hooks/useContent.ts'))).toBe(true);
  });

  it('THE DEFECT: the exact path that refused three investigators is accepted', () => {
    expect(
      check('Start at src/hooks/useContent and trace the fetch.', estateWithModule()),
      'an extension-less module path was called a fabrication, refusing a correct brief',
    ).toEqual([]);
  });

  it('a .tsx module resolves too', () => {
    expect(check('See src/context/Ctx for the provider.', estateWithModule())).toEqual([]);
  });

  it('a path that exists in no form is still reported', () => {
    expect(check('See src/hooks/useNothing for the provider.', estateWithModule()))
      .toEqual(['src/hooks/useNothing']);
  });

  it('an extension-less path in the WRONG directory is still reported', () => {
    expect(check('See src/wrong/useContent.', estateWithModule())).toEqual(['src/wrong/useContent']);
  });

  it('a path with an extension still resolves exactly, as before', () => {
    expect(check('See src/hooks/useContent.ts', estateWithModule())).toEqual([]);
    expect(check('See src/hooks/useContent.js', estateWithModule())).toEqual(['src/hooks/useContent.js']);
  });
});
