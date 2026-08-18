/**
 * THE TESTING-FAILURES LOG STAYS USABLE AS IT GROWS.
 *
 * TESTING-FAILURES.md records defects that reached a live run because the test covering them was
 * WRONG rather than absent. It is expected to become large — that is the point of keeping it — and
 * large is exactly when such a log stops being read: entries get appended to one file, the file
 * gets truncated by whoever reads it next, and a severed entry reads as a complete one.
 *
 * So the structure is an index plus one file per entry, and this test holds the structure:
 *
 *   EVERY ENTRY IS INDEXED. An entry nobody can find is an entry nobody reads.
 *   EVERY INDEX LINE POINTS AT A REAL FILE. A dead link is worse than a missing one.
 *   EVERY ENTRY IS COMPLETE. The sections exist because each answers a question the next reader
 *     will have; the one that matters most is WHY THE TEST PASSED, which is the part that
 *     generalises. An entry without it is a bug report, not a testing failure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const INDEX = join(ROOT, 'TESTING-FAILURES.md');
const DIR = join(ROOT, 'docs/testing-failures');

const entries = () => (existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.md')) : []);

describe('THE LOG EXISTS AND IS FINDABLE', () => {
  it('the index is at the repository root', () => {
    expect(existsSync(INDEX), 'the testing-failures index is gone').toBe(true);
  });

  it('entries live in their own files, not appended into the index', () => {
    // A single growing document is the failure mode this structure exists to prevent.
    expect(entries().length, 'no entry files — entries are being written into the index').toBeGreaterThan(0);
  });

  it('the index stays short enough to actually read', () => {
    // It carries one line per entry. If it starts growing with the entries, the split has broken.
    const lines = readFileSync(INDEX, 'utf8').split('\n').length;
    expect(lines, 'the index is growing with the entries — entry bodies are leaking into it')
      .toBeLessThan(200);
  });
});

describe('NOTHING IS LOST BETWEEN THE INDEX AND THE ENTRIES', () => {
  it('every entry file is linked from the index', () => {
    const index = readFileSync(INDEX, 'utf8');
    for (const f of entries()) {
      expect(index, `${f} exists but nothing in the index points to it — nobody will find it`)
        .toContain(f);
    }
  });

  it('every link in the index resolves to a file that exists', () => {
    const index = readFileSync(INDEX, 'utf8');
    const linked = [...index.matchAll(/docs\/testing-failures\/([^)\s]+\.md)/g)].map((m) => m[1]);
    expect(linked.length, 'the index links to no entries at all').toBeGreaterThan(0);
    for (const l of linked) {
      expect(existsSync(join(DIR, l)), `the index links to ${l}, which does not exist`).toBe(true);
    }
  });
});

describe('EVERY ENTRY ANSWERS THE QUESTION THE LOG EXISTS FOR', () => {
  const REQUIRED = ['**Agreed**', '**Shipped**', '**The test**', '**Why it passed**',
    '**Testing rule**', '**Status**'];

  for (const section of REQUIRED) {
    it(`every entry carries ${section}`, () => {
      for (const f of entries()) {
        const body = readFileSync(join(DIR, f), 'utf8');
        expect(body, `${f} is missing ${section}`).toContain(section);
      }
    });
  }

  it('the why-it-passed section is substantive, not a placeholder', () => {
    // "The test was wrong" is not a reason. The next person needs to see the specific way a green
    // test can miss the requirement, or the entry teaches nothing.
    for (const f of entries()) {
      const body = readFileSync(join(DIR, f), 'utf8');
      const at = body.indexOf('**Why it passed**');
      const section = body.slice(at, body.indexOf('**Testing rule**', at));
      expect(section.length, `${f}'s why-it-passed is too thin to be useful`).toBeGreaterThan(200);
    }
  });

  it('every entry states a testing rule, not only a code fix', () => {
    // The code fix belongs in the commit. What belongs here is the rule that prevents the class.
    for (const f of entries()) {
      const body = readFileSync(join(DIR, f), 'utf8');
      const at = body.indexOf('**Testing rule**');
      const section = body.slice(at, at + 400);
      expect(section.length, `${f} states no testing rule`).toBeGreaterThan(100);
    }
  });
});
