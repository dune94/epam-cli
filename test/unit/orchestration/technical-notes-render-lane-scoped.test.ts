/**
 * The writer prompt must show a lane ONLY its own codeline.
 *
 * Live incident, 2026-08-03, lane gotransit, AMSD-2041: one writer call billed
 * in=1,916,632 out=40,859 ($0.624, 11.58min) and produced nothing. Its final text was
 * "this is a significant refactor with cross-file impact ... Let me confirm the scope
 * with the user before proceeding" — in a non-interactive loop, a dead end. It had spent
 * the call comparing three repositories, reporting facts obtainable only by reading them:
 * "UPExpress uses CONTENTSTACK_PREVIEW_TOKEN (not ...MANAGEMENT_TOKEN)", "UPExpress has
 * no applyLivePreviewQuery export".
 *
 * Cause: `## Technical Notes` renders technicalNotes with a blanket
 * `jq to_entries | map("- \(.key): \(.value)")`. The per-codeline manifest is stored on
 * technicalNotes, so the resolution map for EVERY codeline — sibling absolute checkout
 * paths, and the fact that they diverge (upexpress .ts, metrolinx lowercase) — was handed
 * to a writer scoped to one lane. It took the invitation.
 *
 * This test EXECUTES the real render expression extracted verbatim from claude.sh and
 * asserts on the rendered text. The previous wiring test only grepped claude.sh for the
 * string "perCodeline"; that string also appears in a comment, so deleting the working
 * consumer line left all 9 tests green (mutation-verified). Grepping source cannot
 * observe this defect: it lives in the artifact, not the code.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

/**
 * Pull the REAL render expression out of claude.sh rather than restating it here —
 * a restated copy would keep passing after the script changed.
 */
function extractRenderExpression(): string {
  const marker = '## Technical Notes';
  const i = src.indexOf(marker);
  expect(i, 'the "## Technical Notes" prompt section vanished from claude.sh').toBeGreaterThan(-1);
  const after = src.slice(i + marker.length);
  const line = after.split('\n').find((l) => l.includes('technical_notes') && l.includes('jq'));
  expect(line, 'no jq render line follows the Technical Notes heading').toBeTruthy();
  return line!.trim();
}

/**
 * Run that expression for a given lane and return what the writer would actually read.
 *
 * Fixtures go in via the environment, NOT interpolated into the script — escaping them
 * into a bash string mangles the jq program's own quotes and `\(.key)` sequences, which
 * silently drove every render to the "None specified" fallback. Under that fallback every
 * `not.toContain` assertion in this file passes while proving nothing, so the guard below
 * treats an empty render as a harness failure rather than a result.
 */
function runRender(tnJson: string, codeline: string): string {
  const probe = [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    'technical_notes="$TN_FIXTURE"',
    '_cl_name="$CL_FIXTURE"',
    // The extracted text is a `$(...)` substitution: assign it verbatim, no escaping.
    `_rendered=${extractRenderExpression()}`,
    'printf \'%s\\n\' "$_rendered"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', probe], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, TN_FIXTURE: tnJson, CL_FIXTURE: codeline },
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

function render(technicalNotes: unknown, codeline: string): string {
  const out = runRender(JSON.stringify(technicalNotes), codeline);
  expect(
    out,
    'HARNESS FAILURE: the render fell through to its fallback, so nothing was actually ' +
      'rendered and every negative assertion below would pass vacuously',
  ).not.toContain('None specified');
  expect(out.trim().length, 'HARNESS FAILURE: empty render').toBeGreaterThan(0);
  return out;
}

/** The live AMSD-2041 shape: same five declared files, three repos, three real spellings. */
const NOTES = {
  files: ['src/services/contentstack.ts', 'src/context/ContentstackContext.tsx'],
  perCodeline: {
    gotransit: {
      files: ['src/services/contentstack.ts', 'src/context/ContentstackContext.tsx'],
      resolved: [
        {
          declared: 'src/context/ContentstackContext.tsx',
          actual: 'src/context/ContentstackContext.tsx',
          match: 'exact',
          verified_against: '/home/bradleyjerome/projects/metrolinx/next.gotransit.com',
        },
      ],
      unresolved: [],
    },
    upexpress: {
      files: ['src/services/contentstack.ts', 'src/context/ContentstackContext.ts'],
      resolved: [
        {
          declared: 'src/context/ContentstackContext.tsx',
          actual: 'src/context/ContentstackContext.ts',
          match: 'extension_variant',
          verified_against: '/home/bradleyjerome/projects/metrolinx/next.upexpress.com',
        },
      ],
      unresolved: [],
    },
    metrolinx: {
      files: ['src/services/contentstack.ts', 'src/context/contentstackContext.tsx'],
      resolved: [
        {
          declared: 'src/context/ContentstackContext.tsx',
          actual: 'src/context/contentstackContext.tsx',
          match: 'case_variant',
          verified_against: '/home/bradleyjerome/projects/metrolinx/next.metrolinx.com',
        },
      ],
      unresolved: [],
    },
  },
};

describe('the rendered Technical Notes block is scoped to the lane', () => {
  it('REPRODUCES the live leak: a gotransit writer must not be shown the other two repos', () => {
    const out = render(NOTES, 'gotransit');
    expect(
      out,
      'the writer was handed a sibling codeline checkout — this is what sent the ' +
        'AMSD-2041 gotransit writer cross-repo for 1.9M input tokens',
    ).not.toContain('next.upexpress.com');
    expect(out).not.toContain('next.metrolinx.com');
  });

  it('does not leak a sibling\'s divergent FILENAME either', () => {
    const out = render(NOTES, 'gotransit');
    expect(out, 'the upexpress spelling is an invitation to go compare').not.toContain(
      'ContentstackContext.ts"',
    );
    expect(out).not.toContain('contentstackContext.tsx');
    expect(out).not.toContain('extension_variant');
    expect(out).not.toContain('case_variant');
  });

  it('STILL shows the lane its own resolved truth (the manifest must not be gutted)', () => {
    const out = render(NOTES, 'gotransit');
    expect(out).toContain('next.gotransit.com');
    expect(out).toContain('src/context/ContentstackContext.tsx');
  });

  it('each lane sees itself and only itself', () => {
    const up = render(NOTES, 'upexpress');
    expect(up).toContain('next.upexpress.com');
    expect(up).not.toContain('next.gotransit.com');
    expect(up).not.toContain('next.metrolinx.com');

    const mx = render(NOTES, 'metrolinx');
    expect(mx).toContain('next.metrolinx.com');
    expect(mx).not.toContain('next.gotransit.com');
    expect(mx).not.toContain('next.upexpress.com');
  });

  it('renders ordinary keys unchanged — this is a projection, not a filter', () => {
    const out = render(NOTES, 'gotransit');
    expect(out).toContain('- files:');
    expect(out).toContain('src/services/contentstack.ts');
  });

  /**
   * NO HARDCODED KEY NAME. Excluding "perCodeline" by name means the next per-codeline
   * key added to technicalNotes leaks again, and the fix has to be reapplied in a
   * different file each time. The rule is shape-based: any object keyed by codeline name
   * is projected to the current lane, whatever the key is called.
   */
  it('projects ANY per-codeline map, not one named key', () => {
    const out = render(
      {
        somethingAddedLater: {
          gotransit: 'mine',
          upexpress: 'LEAK-upexpress',
          metrolinx: 'LEAK-metrolinx',
        },
      },
      'gotransit',
    );
    expect(
      out,
      'keying the fix to the literal string "perCodeline" leaves every future key leaking',
    ).not.toContain('LEAK-');
    expect(out).toContain('mine');
  });

  it('leaves a map that is NOT keyed by this codeline completely alone', () => {
    const out = render({ dependsOn: { someLib: '^1.0.0' } }, 'gotransit');
    expect(out, 'an ordinary object must not be mistaken for a per-codeline map').toContain(
      'someLib',
    );
  });

  it('does not crash, and still renders, when the lane is unknown', () => {
    const out = render(NOTES, '');
    expect(out).toContain('- files:');
    expect(out).not.toMatch(/jq: error|syntax error|parse error/i);
  });

  it('renders "None specified" for empty notes rather than a bare or broken line', () => {
    const probe = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      'technical_notes=""',
      '_cl_name="gotransit"',
      `printf '%s\\n' "${extractRenderExpression().replace(/"/g, '\\"')}"`,
    ].join('\n');
    const r = spawnSync('bash', ['-c', probe], { encoding: 'utf8', timeout: 20000 });
    expect(`${r.stdout}${r.stderr}`).toContain('None specified');
  });
});
