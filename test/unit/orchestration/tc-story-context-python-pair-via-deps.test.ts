// PYTHON SPLIT TEST STORY — IMPL FILES VIA DEPENDENCIES, NOT FILENAME MATCHING.
//
// tc-story-context.py/_pair_key() only handles JS/TS infix markers (.spec., .test., _spec., _test_).
// For a Python split story whose test file is `tests/test_portal.py`:
//   _pair_key('test_portal.py') → 'test_portal'   (extension stripped)
//   _pair_key('api.py')        → 'api'             (no marker, extension stripped)
// No intersection → IMPL_SOURCE_FILES is empty → TC writer is handed nothing.
//
// The PRD already encodes the correct answer: story.dependencies lists the impl peers.
// REGI-008b.dependencies = ["REGI-008a", "REGI-007"]. No filename pattern is needed.
//
// This test is RED while _pair_key()-based peer matching is in use.
// It is GREEN once the peer search is replaced with a dependencies-based lookup.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const HANDLER = join(ROOT, 'orchestrations/scripts/lib/handlers/tc-story-context.py');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

type Story = {
  id: string;
  files: string[];
  vcs?: string[];
  acs?: string[];
  dependencies?: string[];
};

function fixture(stories: Story[]): { out: string; prd: string } {
  const d = mkdtempSync(join(tmpdir(), 'tc-deps-')); made.push(d);
  const out = join(d, 'out'); mkdirSync(out, { recursive: true });
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    implementationOrder: { core: stories.map((s) => s.id) },
    stories: stories.map((s) => ({
      id: s.id,
      dependencies: s.dependencies ?? [],
      technicalNotes: { files: s.files },
      acceptanceCriteria: s.acs ?? [],
      verificationCriteria: s.vcs ?? [],
    })),
  }, null, 2));
  return { out, prd };
}

const context = (f: { out: string; prd: string }, story: string): string => {
  const r = spawnSync('python3', [HANDLER, f.out, f.prd, 'core', story], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`handler exited ${r.status}: ${r.stderr}`);
  return r.stdout;
};

// Split pair that mirrors the real REGI-008 topology:
//   S-007  impl story — regintel/classifier.py
//   S-008a impl story — regintel/api.py, regintel/static/index.html
//   S-008b test story — tests/test_portal.py, depends on S-008a and S-007
const splitFixture = (): ReturnType<typeof fixture> =>
  fixture([
    {
      id: 'S-007',
      files: ['regintel/classifier.py'],
      vcs: [],
    },
    {
      id: 'S-008a',
      files: ['regintel/api.py', 'regintel/static/index.html'],
      vcs: [],
    },
    {
      id: 'S-008b',
      files: ['tests/test_portal.py'],
      dependencies: ['S-008a', 'S-007'],
      vcs: ['Given a valid token, the portal returns a 200 response'],
      acs: ['The portal must authenticate requests'],
    },
  ]);

describe('Python split test story resolves impl files via dependencies', () => {
  it('gets a brief at all — not empty output', () => {
    const f = splitFixture();
    expect(context(f, 'S-008b').trim(),
      'S-008b has VCs and a test file but got an empty brief — peer lookup is broken').not.toBe('');
  });

  it('brief includes the direct impl peer files (S-008a)', () => {
    const c = context(splitFixture(), 'S-008b');
    expect(c, 'api.py from S-008a (direct dep) must appear in the brief').toMatch(/api\.py/);
    expect(c, 'index.html from S-008a (direct dep) must appear in the brief').toMatch(/index\.html/);
  });

  it('brief includes transitive impl peer files (S-007 via dependencies)', () => {
    const c = context(splitFixture(), 'S-008b');
    expect(c, 'classifier.py from S-007 (declared dep) must appear in the brief').toMatch(/classifier\.py/);
  });

  it('test file is NOT listed as an impl source file', () => {
    const c = context(splitFixture(), 'S-008b');
    // test_portal.py should appear as the TEST_FILE, not as an IMPL_SOURCE_FILES entry.
    // The brief must carry impl files only in the impl section.
    const implSection = c.includes('IMPL_SOURCE_FILES')
      ? c.slice(c.indexOf('IMPL_SOURCE_FILES'))
      : c;
    expect(
      implSection,
      'test_portal.py must not appear as an impl source — it is the test file, not an impl file',
    ).not.toMatch(/IMPL_SOURCE_FILES.*test_portal/s);
  });

  it('impl story with no test files and no VCs gets no brief (no false positive)', () => {
    const f = splitFixture();
    const c = context(f, 'S-008a');
    // S-008a has no VCs and no test files — it should not qualify for a brief
    expect(c.trim()).toBe('');
  });

  it('brief names the correct story ID', () => {
    const c = context(splitFixture(), 'S-008b');
    expect(c).toMatch(/S-008b/);
  });
});

describe('dependencies-based lookup does not regress brownfield', () => {
  it('a brownfield story with no dependencies still gets its own impl files', () => {
    const f = fixture([{
      id: 'BROWN-1',
      files: ['src/impl.ts', 'src/helper.ts'],
      vcs: ['observable behaviour'],
    }]);
    const c = context(f, 'BROWN-1');
    expect(c).toMatch(/impl\.ts/);
    expect(c).toMatch(/helper\.ts/);
  });

  it('a brownfield story does not pick up another phase story\'s files', () => {
    const f = fixture([
      { id: 'BROWN-1', files: ['src/impl.ts'], vcs: ['something'] },
      { id: 'BROWN-2', files: ['src/other.ts'], vcs: ['other thing'] },
    ]);
    const c = context(f, 'BROWN-1');
    expect(c).not.toMatch(/other\.ts/);
  });
});
