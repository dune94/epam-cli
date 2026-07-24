/**
 * applyToolAllowlist — a STRUCTURAL tool restriction (not a prompt-level one).
 *
 * Live failure it closes (2026-07-23, AMSD-1820): the read-only code-graph-detective,
 * run with all tools enabled, "answered" by calling write_file and its real output
 * (the JSON fix site) was lost. Prompt wording could not prevent it. With an
 * allowlist the excluded tools are never handed to the model, so the failure is
 * structurally impossible. Read-only agents (detective → `bash`; review-agent →
 * `bash,read_file,list_files,search`) can no longer reach write_file.
 */
import { describe, it, expect } from 'vitest';
import { createTools, applyToolAllowlist } from '../../../src/tools/createTools.js';

const ALL = createTools();
const names = (ts: { name: string }[]) => ts.map(t => t.name).sort();

describe('applyToolAllowlist', () => {
  it('returns all tools unchanged when the allowlist is empty/unset (backward compatible)', () => {
    expect(names(applyToolAllowlist(ALL, undefined))).toEqual(names(ALL));
    expect(names(applyToolAllowlist(ALL, null))).toEqual(names(ALL));
    expect(names(applyToolAllowlist(ALL, ''))).toEqual(names(ALL));
    expect(names(applyToolAllowlist(ALL, '   '))).toEqual(names(ALL));
  });

  it('restricts the detective to bash only — write_file is structurally excluded', () => {
    const restricted = applyToolAllowlist(ALL, 'bash');
    expect(names(restricted)).toEqual(['bash']);
    expect(restricted.some(t => t.name === 'write_file')).toBe(false);
  });

  it('restricts a read-only reviewer to read tools, excluding write_file', () => {
    const restricted = applyToolAllowlist(ALL, 'bash,read_file,list_files,search');
    expect(restricted.some(t => t.name === 'write_file')).toBe(false);
    expect(names(restricted)).toEqual(['bash', 'list_files', 'read_file', 'search']);
  });

  it('matches friendly names case- and separator-insensitively (Bash==bash, ReadFile==read_file)', () => {
    expect(names(applyToolAllowlist(ALL, 'Bash, ReadFile'))).toEqual(['bash', 'read_file']);
    expect(names(applyToolAllowlist(ALL, 'WriteFile'))).toEqual(['write_file']);
    // colon separator also accepted
    expect(names(applyToolAllowlist(ALL, 'bash:search'))).toEqual(['bash', 'search']);
  });

  it('ignores unknown tool names without throwing', () => {
    expect(names(applyToolAllowlist(ALL, 'bash,does_not_exist'))).toEqual(['bash']);
    expect(applyToolAllowlist(ALL, 'nonsense_only')).toEqual([]);
  });
});
