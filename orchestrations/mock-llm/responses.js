'use strict';

// Pre-written TypeScript implementations that pass all hello-world ACs.
// Each entry maps to one or more write_file tool calls.

const GREET_TS = `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

// greet.test.ts already exists in the project root — do not overwrite it.

const FORMAT_DATE_TS = `export function formatDate(date: Date, format: 'short' | 'long'): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  if (format === 'short') {
    return \`\${year}-\${month}-\${day}\`;
  }
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return \`\${monthNames[date.getUTCMonth()]} \${day}, \${year}\`;
}
`;

const FORMAT_DATE_TEST_TS = `import { describe, it, expect } from 'vitest';
import { formatDate } from './formatDate.js';

describe('formatDate', () => {
  it("returns ISO date for 'short' format", () => {
    expect(formatDate(new Date('2026-06-04'), 'short')).toBe('2026-06-04');
  });

  it("returns human-readable date for 'long' format", () => {
    expect(formatDate(new Date('2026-06-04'), 'long')).toBe('June 04, 2026');
  });

  it('pads single-digit month', () => {
    expect(formatDate(new Date('2026-01-07'), 'short')).toBe('2026-01-07');
  });

  it('handles December (month 12)', () => {
    expect(formatDate(new Date('2026-12-31'), 'short')).toBe('2026-12-31');
  });

  it('handles year 2000', () => {
    expect(formatDate(new Date('2000-01-01'), 'long')).toBe('January 01, 2000');
  });
});
`;

// truncate(text, maxLength, suffix='...')
// Truncates when text.length >= maxLength (at-boundary truncates).
// truncate('hello world', 5)     → 'he...'   (11 >= 5 → slice(0,2)+'...')
// truncate('hi', 10)             → 'hi'       (2 < 10  → unchanged)
// truncate('hello', 5, '!')      → 'hell!'    (5 >= 5  → slice(0,4)+'!')
const TRUNCATE_TS = `export function truncate(text: string, maxLength: number, suffix: string = '...'): string {
  if (text.length < maxLength) return text;
  const end = Math.max(0, maxLength - suffix.length);
  return text.slice(0, end) + suffix;
}
`;

const TRUNCATE_TEST_TS = `import { describe, it, expect } from 'vitest';
import { truncate } from './truncate.js';

describe('truncate', () => {
  it("truncates 'hello world' to maxLength=5 with default suffix", () => {
    expect(truncate('hello world', 5)).toBe('he...');
  });

  it("returns text unchanged when shorter than maxLength", () => {
    expect(truncate('hi', 10)).toBe('hi');
  });

  it("uses custom suffix and truncates at exact maxLength boundary", () => {
    expect(truncate('hello', 5, '!')).toBe('hell!');
  });

  it("returns empty string for empty input", () => {
    expect(truncate('', 5)).toBe('');
  });

  it("handles maxLength=0 (suffix fills the entire slot)", () => {
    // 'hello'.length=5 >= 0 → end=max(0,0-3)=0 → ''+suffix
    expect(truncate('hello', 0, '!')).toBe('!');
  });

  it("handles Unicode characters (counts code units)", () => {
    expect(truncate('héllo world', 5)).toBe('hé...');
  });
});
`;

// slugify: lowercase → trim → replace [\s\W]+ with '-' → strip leading/trailing '-'
// slugify('Hello,  World!')       → 'hello-world'
// slugify('  Already-Slugged  ')  → 'already-slugged'
// slugify('')                     → ''
const SLUGIFY_TS = `export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[\\s\\W]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

const SLUGIFY_TEST_TS = `import { describe, it, expect } from 'vitest';
import { slugify } from './slugify.js';

describe('slugify', () => {
  it("converts 'Hello,  World!' to 'hello-world'", () => {
    expect(slugify('Hello,  World!')).toBe('hello-world');
  });

  it("strips leading/trailing whitespace and normalises hyphens", () => {
    expect(slugify('  Already-Slugged  ')).toBe('already-slugged');
  });

  it("returns empty string for empty input", () => {
    expect(slugify('')).toBe('');
  });

  it("collapses repeated separators into one hyphen", () => {
    expect(slugify('foo---bar')).toBe('foo-bar');
  });

  it("handles punctuation", () => {
    expect(slugify("it's a test!")).toBe('it-s-a-test');
  });
});
`;

// HW-003 review report — written after greet.ts is confirmed correct.
const HW003_REVIEW_MD = `# HW-003 Code Review: greet.ts

## Summary

**Reviewer:** review-agent (mock-llm tier-1)
**Reviewed file:** greet.ts
**Test command:** ~/.local/share/fnm/node-versions/v20.20.2/installation/bin/node ./node_modules/.bin/vitest run

Test results: 3 passed | 0 failed

**Overall verdict:** pass

## Findings

No findings

## HW-001 Criteria Checklist

- [x] greet.ts exists in the project root — met: file is present at project root
- [x] greet.ts exports a named function with the exact signature: export function greet(name: string): string — met: confirmed in source
- [x] The return type annotation is explicitly \`string\` (not inferred-only) — met: explicit ': string' present
- [x] greet.ts does not contain a default export — only the named \`greet\` export is present — met: no default export found
- [x] greet('World') returns exactly 'Hello, World!' — met: template literal confirms
- [x] greet('Alice') returns exactly 'Hello, Alice!' — met: same template
- [x] greet('Bob') returns exactly 'Hello, Bob!' — met: same template
- [x] greet('X').length is greater than 0 — met: 'Hello, X!' has length 9
- [x] greet('') returns 'Hello, !' (empty name is valid input, no throw) — met: template returns 'Hello, !'
- [x] greet() does not throw for any string argument — met: no throw in implementation
- [x] Calling greet() produces no console output or other observable side effects — met: pure function, no I/O
- [x] tsc --noEmit exits with code 0 (no TypeScript compilation errors) after greet.ts is added — met: strict TypeScript, explicit types
- [x] npm test passes with all 3 vitest tests in greet.test.ts green — met: 3 passed 0 failed
- [x] greet.test.ts is not modified — met: not touched by this review
- [x] package.json is not modified — met: not touched
- [x] tsconfig.json is not modified — met: not touched
- [x] main.ts is not modified — met: not touched
`;

// Story response definitions
// type: 'files'  → return write_file tool calls
// type: 'text'   → return plain text (no tool calls)
module.exports = {
  'HW-001': {
    type: 'files',
    files: [
      { path: 'greet.ts', content: GREET_TS },
    ],
  },
  'HW-002': {
    // Verification story — agent just reports; external verification runs npm test
    type: 'text',
    content: 'I have verified the test suite. All vitest tests are passing (3 passed, 0 failed). The greet() function satisfies all acceptance criteria.',
  },
  'HW-003': {
    type: 'files',
    files: [
      { path: 'review/HW-003-review.md', content: HW003_REVIEW_MD },
    ],
  },
  'HW-004': {
    type: 'files',
    files: [
      { path: 'formatDate.ts',      content: FORMAT_DATE_TS },
      { path: 'formatDate.test.ts', content: FORMAT_DATE_TEST_TS },
    ],
  },
  'HW-005': {
    type: 'files',
    files: [
      { path: 'truncate.ts',      content: TRUNCATE_TS },
      { path: 'truncate.test.ts', content: TRUNCATE_TEST_TS },
    ],
  },
  'HW-006': {
    type: 'files',
    files: [
      { path: 'slugify.ts',      content: SLUGIFY_TS },
      { path: 'slugify.test.ts', content: SLUGIFY_TEST_TS },
    ],
  },
};
