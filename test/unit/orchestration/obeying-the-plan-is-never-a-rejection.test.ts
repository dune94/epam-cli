/**
 * OBEYING THE PLAN IS NEVER A REJECTION.
 *
 * Live failure, run 20260814T213253Z (metrolinx, AMSD-2041). The plan of record named
 * FIVE sites:
 *
 *     src/services/contentstack.ts
 *     src/context/contentstackContext.tsx
 *     src/pages/_app.tsx
 *     .env.local.sample
 *     src/hooks/useContent.ts
 *
 * The implementer changed exactly those five and nothing else. The reviewer rejected
 * it: "the change is over-engineered: it modifies 6 files when the prescribed minimal
 * fix requires only 2 (contentstack.ts and _app.tsx)". That number appears nowhere in
 * the plan the reviewer was handed — it invented a stricter standard, so no attempt
 * could pass while obeying its instructions, and the story burned its entire ladder
 * across four review cycles.
 *
 * A deterministic answer to "did the implementer stay inside the plan" removes the
 * question from the reviewer's judgment entirely. Scope is arithmetic against the
 * prescription; it is not an opinion.
 *
 * NOTHING IS HARDCODED. The prescription is read from the story's own fixSiteAnalysis;
 * this gate contains no path, no filename, no count and no threshold. A project that
 * prescribes different files is checked the same way, and a story with no prescription
 * is reported as UNCHECKED rather than passed.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GATE = join(__dirname, '../../../orchestrations/scripts/lib/plan-fidelity-gate.sh');
const STORY = 'AMSD-2041';

/** Run the real gate over a PRD fixture and a set of changed files. */
function runGate(
  sites: Array<Record<string, unknown>> | null,
  changed: string[],
  depManifest?: Record<string, unknown>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'fidelity-'));
  try {
    const prd = join(dir, 'prd.json');
    const story: Record<string, unknown> = { id: STORY, title: 't' };
    if (sites !== null) story.fixSiteAnalysis = sites;
    writeFileSync(prd, JSON.stringify({ stories: [story] }));
    const changedFile = join(dir, 'changed.txt');
    writeFileSync(changedFile, changed.join('\n') + (changed.length ? '\n' : ''));
    let depArg = '';
    if (depManifest) {
      const depFile = join(dir, 'dependency-check.json');
      writeFileSync(depFile, JSON.stringify(depManifest));
      depArg = ` "${depFile}"`;
    }
    const res = spawnSync(
      'bash',
      ['-c', `. "${GATE}"; plan_fidelity_check "${prd}" "${STORY}" "${changedFile}"${depArg}`],
      { encoding: 'utf8' },
    );
    return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The exact prescription the live run carried: five sites, none carrying changeRequired. */
const LIVE_SITES = [
  { file: 'src/services/contentstack.ts' },
  { file: 'src/context/contentstackContext.tsx' },
  { file: 'src/pages/_app.tsx' },
  { file: '.env.local.sample' },
  { file: 'src/hooks/useContent.ts' },
];
const LIVE_CHANGED = LIVE_SITES.map((s) => s.file);

describe('obeying the plan is never a rejection', () => {
  it('PASSES the exact live diff the reviewer rejected', () => {
    // This is the whole point: five prescribed, five changed, none extra.
    const res = runGate(LIVE_SITES, LIVE_CHANGED);
    expect(res.status, `the compliant live diff was flagged:\n${res.out}`).toBe(0);
  });

  it('PASSES when the implementer changed only some prescribed files', () => {
    // Staying inside the plan is compliance whether or not every site needed an edit.
    const res = runGate(LIVE_SITES, ['src/services/contentstack.ts', 'src/pages/_app.tsx']);
    expect(res.status).toBe(0);
  });

  it('FAILS when a file outside the plan was changed, and names it', () => {
    const res = runGate(LIVE_SITES, [...LIVE_CHANGED, 'src/components/Unrelated.tsx']);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain('src/components/Unrelated.tsx');
    // The compliant files must not be reported as problems.
    expect(res.out).not.toContain('src/pages/_app.tsx');
  });

  it('FAILS when a site the plan EXEMPTS was changed', () => {
    // changeRequired:false means "part of the fix, correctly left untouched".
    const sites = [
      { file: 'src/services/contentstack.ts', changeRequired: true },
      { file: 'src/hooks/useContent.ts', changeRequired: false },
    ];
    const res = runGate(sites, ['src/services/contentstack.ts', 'src/hooks/useContent.ts']);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain('src/hooks/useContent.ts');
  });

  it('reports UNCHECKED, never a pass, when the story has no prescription', () => {
    const res = runGate(null, ['anything.ts']);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/unchecked|no prescription/i);
  });

  it('says so when no site carries changeRequired — the live data gap', () => {
    // All five live sites lacked the field the detective contract calls REQUIRED, so
    // nothing could distinguish "must edit" from "verify only". Absent is UNKNOWN and
    // must be visible, never silently treated as a clean result.
    const res = runGate(LIVE_SITES, LIVE_CHANGED);
    expect(res.out).toMatch(/changeRequired/);
  });

  it('does not flag files the PROJECT declares as dependency-managed', () => {
    // Installing a package the fix needs touches files no site analysis names. Those
    // come from the project's own manifest, never from this engine — so a compliant
    // change that adds a dependency is not a scope violation.
    const res = runGate(
      LIVE_SITES,
      [...LIVE_CHANGED, 'package.json', 'package-lock.json', 'jest.config.js'],
      {
        manifestFile: 'package.json',
        coupledFilePairs: [['package.json', 'package-lock.json']],
        dependencySensitiveConfigFiles: ['jest.config.js'],
      },
    );
    expect(res.status, `dependency-managed files were flagged:\n${res.out}`).toBe(0);
  });

  it('still flags a genuinely unrelated file even with a dependency manifest present', () => {
    // The dependency allowance must not become a hole: only what the project declares
    // is exempt, nothing else.
    const res = runGate(LIVE_SITES, [...LIVE_CHANGED, 'src/components/Unrelated.tsx'], {
      manifestFile: 'package.json',
      coupledFilePairs: [['package.json', 'package-lock.json']],
      dependencySensitiveConfigFiles: ['jest.config.js'],
    });
    expect(res.status).not.toBe(0);
    expect(res.out).toContain('src/components/Unrelated.tsx');
  });

  it('a project declaring nothing gets no exemptions', () => {
    const res = runGate(LIVE_SITES, [...LIVE_CHANGED, 'package.json'], {});
    expect(res.status).not.toBe(0);
    expect(res.out).toContain('package.json');
  });

  it('holds for any project — the gate names no file of its own', () => {
    const sites = [{ file: 'lib/thing.rb' }, { file: 'Gemfile' }];
    const res = runGate(sites, ['lib/thing.rb', 'spec/other_spec.rb']);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain('spec/other_spec.rb');

    const code = readFileSync(GATE, 'utf8').replace(/^\s*#.*$/gm, '');
    for (const literal of ['contentstack', '_app.tsx', 'useContent', '.env.local']) {
      expect(code, `gate hardcodes ${literal}`).not.toContain(literal);
    }
    // No magic counts either — scope is read from the prescription, never assumed.
    expect(code).not.toMatch(/-(eq|le|ge|lt|gt) [0-9]{1,}\b.*file/i);
  });
});
