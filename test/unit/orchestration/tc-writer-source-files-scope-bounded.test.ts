// THE TC WRITER LISTS EXTERNAL LIBRARY FILES IN sourceFiles.
//
// Live REGI-004b (2026-09-17, run 20260916T200108Z): the TC writer read
// regintel/classifier.py, traced its `from dial.client import …` import, read
// dial/client.py (an external library in the venv), and wrote "dial/client.py"
// into testCriteria.sourceFiles. The applier accepted it verbatim. Pre-flight
// check #18 caught it and hard-failed — blocking the resume.
//
// Root cause: the prompt says `"<a real path you read, exactly as it appears in
// this repository>"`. The story context already supplies IMPL_SOURCE_FILES — the
// declared implementation scope — but the prompt never tells the agent to stay
// within that scope. Reading a library while tracing an import is expected; listing
// that library as a sourceFile is the arch gap.
//
// Fix: the template must:
//   1. Restrict sourceFiles to paths the agent found in IMPL_SOURCE_FILES.
//   2. Explicitly tell the agent not to include external/library files.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/tc-writer.json');

const body = (): string => {
  const j = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  return String(j.body ?? Object.values(j.bodies ?? {}).join('\n'));
};

describe('tc-writer: sourceFiles scope is bounded to the declared implementation scope', () => {
  it('restricts sourceFiles entries to paths from IMPL_SOURCE_FILES', () => {
    // The agent receives IMPL_SOURCE_FILES in __STORY_CONTEXT__. The prompt must
    // say those are the only valid entries for sourceFiles — not every file it
    // happened to open while tracing imports. The current template mentions
    // IMPL_SOURCE_FILES in step 2 ("READ every IMPL_SOURCE_FILES path"), but never
    // says "only those paths go into sourceFiles". That is the gap.
    const b = body();
    // The sourceFiles field description or the instructions must say "only" or
    // "restrict" in the context of IMPL_SOURCE_FILES — not just say to read them.
    const sourceFilesSection = b.slice(b.indexOf('"sourceFiles"'), b.indexOf('"sourceFiles"') + 300);
    const hasExplicitScope =
      /only.*IMPL_SOURCE_FILES|IMPL_SOURCE_FILES.*only|restrict.*IMPL_SOURCE_FILES|from IMPL_SOURCE_FILES/i.test(b);
    expect(
      hasExplicitScope,
      `the prompt never restricts sourceFiles to IMPL_SOURCE_FILES; "${sourceFilesSection.slice(0, 200)}" says to read them but not to restrict the output to them`
    ).toBe(true);
  });

  it('explicitly excludes external library files from sourceFiles', () => {
    // "a real path you read" is too broad. Tracing an import into an external
    // library is a legitimate read; listing that library path in sourceFiles is
    // not. The prompt must name the exclusion class.
    const b = body().toLowerCase();
    expect(
      b,
      'the prompt never tells the agent that external/library files are excluded from sourceFiles'
    ).toMatch(/external|librar|third.party|outside.*scope|outside.*impl/);
  });
});
