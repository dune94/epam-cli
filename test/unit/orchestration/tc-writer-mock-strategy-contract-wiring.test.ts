/**
 * mockStrategy — deterministic contract wiring (2026-07-05).
 *
 * Root cause: testCriteria.mockStrategy was pure LLM-authored prose ("write a
 * single sentence describing exactly how to mock dependencies"), never checked
 * against the real source. This was the direct upstream cause of a live defect
 * (SKY-003 sandbox test): the model confused Jest's vi.requireActual with
 * Vitest's vi.importActual inside a vi.mock() factory — a mechanical mistake
 * a deterministic mock skeleton would have prevented outright.
 *
 * Fix: generate_story_contract() (claude.sh) already writes an exact,
 * regex-derived mock-factory skeleton to .contracts/<dep-id>.md for every
 * completed story with exported classes/interfaces. post-impl-tc-writer.sh's
 * apply step now splices that skeleton into testCriteria.mockStrategy whenever
 * the test story's implementation peer (or itself, for non-split stories) has
 * a generated contract — overriding the LLM's freeform sentence with source-
 * derived fact. Mirrors generate_story_contract()'s own design: this script
 * has no stack-specific knowledge either; it just copies whatever the contract
 * file's fenced block says.
 *
 * A second, orthogonal bug is guarded here too: the apply step lives inside an
 * UNQUOTED `<< PYEOF` heredoc (required for bash `$PRD_FILE`/`$PHASE`/`$TC_EXIT`
 * interpolation). A literal triple-backtick anywhere in that embedded Python
 * source would be parsed by bash as command substitution BEFORE python3 ever
 * sees it, aborting with "bad substitution: no closing \"`\"". The fence
 * marker must be built via chr(96)*3, never typed literally.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const TC_WRITER_SH = join(REPO_ROOT, 'orchestrations/scripts/post-impl-tc-writer.sh');
const tcWriterSrc = readFileSync(TC_WRITER_SH, 'utf8');

function extractApplyBlock(): string {
  const start = tcWriterSrc.indexOf('python3 << PYEOF', tcWriterSrc.indexOf('# ── Validate and apply TCs'));
  if (start === -1) throw new Error('Could not find apply block start');
  const end = tcWriterSrc.indexOf('\nPYEOF', start);
  if (end === -1) throw new Error('Could not find apply block end');
  // Body only, between the heredoc marker line and the closing PYEOF line.
  const firstNewline = tcWriterSrc.indexOf('\n', start);
  return tcWriterSrc.slice(firstNewline + 1, end);
}

describe('post-impl-tc-writer.sh — apply block: static structure', () => {
  const body = extractApplyBlock();

  it('the apply block never contains a literal triple-backtick (would break the unquoted heredoc)', () => {
    expect(body).not.toContain('```');
  });

  it('builds the fence marker via chr(96)*3 instead', () => {
    expect(body).toMatch(/chr\(96\)\s*\*\s*3/);
  });

  it('splices a found contract skeleton into tc[\'mockStrategy\']', () => {
    expect(body).toMatch(/tc\['mockStrategy'\]\s*=\s*skeleton/);
  });

  it('looks up peer story ids AND the story\'s own id (non-split topology) when searching for a contract', () => {
    expect(body).toMatch(/peer_ids_for\(sid\)\s*\+\s*\[sid\]/);
  });

  it('only overrides mockStrategy when a skeleton was actually found (falls back to the LLM-authored value otherwise)', () => {
    const idx = body.indexOf('skeleton = find_contract_mock_skeleton');
    const block = body.slice(idx, idx + 150);
    expect(block).toMatch(/if skeleton:/);
  });
});

describe('post-impl-tc-writer.sh — apply block: REAL execution', () => {
  function runApply(opts: {
    tcData: Record<string, any>;
    phaseIds: string[];
    stories: any[];
    contracts?: Record<string, string>; // storyId -> full .md content
  }): any {
    const dir = mkdtempSync(join(tmpdir(), 'tc-mockstrategy-'));
    try {
      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({
          implementationOrder: { core: opts.phaseIds },
          stories: opts.stories,
        }),
      );
      const tcPath = join(dir, 'tc-core.json');
      writeFileSync(tcPath, JSON.stringify(opts.tcData));

      if (opts.contracts) {
        mkdirSync(join(dir, '.contracts'), { recursive: true });
        for (const [sid, content] of Object.entries(opts.contracts)) {
          writeFileSync(join(dir, '.contracts', `${sid}.md`), content);
        }
      }

      // Simulate exactly what bash does to an UNQUOTED heredoc: literal
      // substitution of $VAR occurrences before the text reaches python3.
      let block = extractApplyBlock();
      block = block
        .replace(/\$PRD_FILE/g, prdPath)
        .replace(/\$TC_OUT_FILE/g, tcPath)
        .replace(/\$PHASE/g, 'core')
        .replace(/\$TC_EXIT/g, '0')
        .replace(/\$OUTPUT_DIR/g, dir);

      const scriptPath = join(dir, 'apply.py');
      writeFileSync(scriptPath, block);
      execFileSync('python3', [scriptPath], { encoding: 'utf8' });

      return JSON.parse(readFileSync(prdPath, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const CONTRACT_MD = `# Contract: SKY-002

Auto-generated from actual source (deterministic — not model-transcribed).

\`\`\`typescript
export class SkyscannerClient {
  constructor(apiKey: string);
  async searchFlights(params: { from: string; to: string }): Promise<any[]>;
}
\`\`\`

Mock factory skeleton — every exported method MUST appear here (every method name is real; fill in real return values):
\`\`\`typescript
vi.mock('<import-path-to-SkyscannerClient>', () => ({
  SkyscannerClient: vi.fn().mockImplementation(() => ({
    searchFlights: vi.fn().mockResolvedValue(undefined),
  })),
}));
\`\`\``;

  it('overrides the LLM-authored mockStrategy with the deterministic contract skeleton when a peer contract exists', () => {
    const result = runApply({
      phaseIds: ['SKY-002', 'SKY-003'],
      stories: [
        { id: 'SKY-002', technicalNotes: { files: ['src/skyscanner/client.ts'] } },
        { id: 'SKY-003', technicalNotes: { files: ['src/skyscanner/client.test.ts'] } },
      ],
      tcData: {
        'SKY-003': {
          verifiedAt: '2026-07-05T00:00:00Z',
          facts: ['some fact'],
          mockStrategy: 'use vi.requireActual to spread the real module (WRONG — this is the live bug)',
          bannedPatterns: [],
        },
      },
      contracts: { 'SKY-002': CONTRACT_MD },
    });
    const sky003 = result.stories.find((s: any) => s.id === 'SKY-003');
    expect(sky003.testCriteria.mockStrategy).toContain('vi.mock(');
    expect(sky003.testCriteria.mockStrategy).toContain('searchFlights: vi.fn().mockResolvedValue(undefined)');
    expect(sky003.testCriteria.mockStrategy).not.toContain('WRONG');
  });

  it('leaves the LLM-authored mockStrategy untouched when no contract exists for any peer', () => {
    const result = runApply({
      phaseIds: ['SKY-010', 'SKY-011'],
      stories: [
        { id: 'SKY-010', technicalNotes: { files: ['src/other/thing.ts'] } },
        { id: 'SKY-011', technicalNotes: { files: ['src/other/thing.test.ts'] } },
      ],
      tcData: {
        'SKY-011': {
          verifiedAt: '2026-07-05T00:00:00Z',
          facts: ['some fact'],
          mockStrategy: 'freeform LLM sentence, no contract available',
          bannedPatterns: [],
        },
      },
    });
    const sky011 = result.stories.find((s: any) => s.id === 'SKY-011');
    expect(sky011.testCriteria.mockStrategy).toBe('freeform LLM sentence, no contract available');
  });

  it('finds the contract under the test story\'s OWN id when impl+test files live in the same story (non-split topology)', () => {
    const result = runApply({
      phaseIds: ['SKY-020'],
      stories: [
        { id: 'SKY-020', technicalNotes: { files: ['src/thing.ts', 'src/thing.test.ts'] } },
      ],
      tcData: {
        'SKY-020': {
          verifiedAt: '2026-07-05T00:00:00Z',
          facts: ['some fact'],
          mockStrategy: 'old freeform sentence',
          bannedPatterns: [],
        },
      },
      contracts: { 'SKY-020': CONTRACT_MD },
    });
    const story = result.stories.find((s: any) => s.id === 'SKY-020');
    expect(story.testCriteria.mockStrategy).toContain('vi.mock(');
  });

  it('regression guard: the embedded Python does not crash under bash\'s unquoted-heredoc backtick substitution — the real .md content that trips it (literal triple-backtick fences) round-trips correctly', () => {
    // This is the exact failure mode: if the script's source used a literal
    // ``` instead of chr(96)*3, bash itself would fail with "bad substitution"
    // before python3 ever ran. Proving the extracted block runs clean end-to-end
    // (as this whole describe block does) is the regression guard; this test
    // additionally asserts the fenced content the script scanned is intact.
    const result = runApply({
      phaseIds: ['SKY-002', 'SKY-003'],
      stories: [
        { id: 'SKY-002', technicalNotes: { files: ['src/skyscanner/client.ts'] } },
        { id: 'SKY-003', technicalNotes: { files: ['src/skyscanner/client.test.ts'] } },
      ],
      tcData: {
        'SKY-003': {
          verifiedAt: '2026-07-05T00:00:00Z',
          facts: ['some fact'],
          mockStrategy: 'placeholder',
          bannedPatterns: [],
        },
      },
      contracts: { 'SKY-002': CONTRACT_MD },
    });
    const sky003 = result.stories.find((s: any) => s.id === 'SKY-003');
    expect(sky003.testCriteria.mockStrategy).toContain('SkyscannerClient: vi.fn().mockImplementation');
  });
});
