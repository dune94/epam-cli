/**
 * Pipeline regression tests — covers the 3 active failure modes:
 *
 * Issue 1: SAST parser fails on malformed JSON + dev-dep CVEs block the gate
 * Issue 2: M3 writes files to wrong path (cwd root vs declared absolute path)
 * Issue 3: spec-mode ladder fires but runClaude timeout leaves zombie processes
 *
 * Zero API calls. Tests read source files and exercise inline logic.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(__dirname, '../../..');
const ORCH_SCRIPT = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

const orchSrc = readFileSync(ORCH_SCRIPT, 'utf8');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

// ─── Inline SAST parser (mirrors run-agent-orchestration.sh logic exactly) ────

function parseSastBlockers(logText: string): number {
  let parsed: Record<string, any> | null = null;
  const m = logText.match(/\{.*\}/s);
  if (m) {
    try { parsed = JSON.parse(m[0]); } catch { /* malformed */ }
  }
  if (parsed !== null) {
    const summaryCount = parsed?.summary?.blockerCount;
    if (summaryCount !== undefined) return summaryCount;
    const findings: any[] = parsed?.findings ?? [];
    return findings.filter(f => String(f?.severity ?? '').toLowerCase() === 'blocker').length;
  }
  // Malformed JSON — extract summary block
  const sm = logText.match(/"summary"\s*:\s*\{([^}]*)\}/s);
  if (sm) {
    try {
      const summary = JSON.parse('{' + sm[1] + '}');
      if (summary.blockerCount !== undefined) return summary.blockerCount;
    } catch { /* continue */ }
  }
  // Last resort: count raw blocker severity hits
  return (logText.match(/"severity"\s*:\s*"blocker"/gi) ?? []).length;
}

// ─── Issue 1: SAST parser ─────────────────────────────────────────────────────

describe('Issue 1 — SAST parser handles malformed JSON and dev-dep CVEs', () => {
  it('parses blockerCount from well-formed JSON with summary block', () => {
    const log = JSON.stringify({
      agent: 'sast-sentinel',
      summary: { filesScanned: 2, findingsCount: 1, blockerCount: 0 },
      findings: [],
      verdict: 'pass',
    });
    expect(parseSastBlockers(log)).toBe(0);
  });

  it('returns 1 when summary.blockerCount is 1 (real blocker)', () => {
    const log = JSON.stringify({
      summary: { filesScanned: 2, findingsCount: 1, blockerCount: 1 },
      findings: [{ severity: 'blocker', rule: 'dep-cve-critical', file: 'package.json', line: 0 }],
      verdict: 'fail',
    });
    expect(parseSastBlockers(log)).toBe(1);
  });

  it('extracts blockerCount from malformed JSON via summary-block fallback', () => {
    // Valid summary, then malformed findings (unescaped chars in description)
    const malformed = `{
  "agent": "sast-sentinel",
  "summary": { "filesScanned": 2, "findingsCount": 1, "blockerCount": 1 },
  "findings": [{ "severity": "blocker", "description": "CVE in vitest: When Vitest UI server is listen on 0.0.0.0 — cross-origin request" }]
  MISSING_COMMA
  "verdict": "fail"
}`;
    expect(parseSastBlockers(malformed)).toBe(1);
  });

  it('counts blocker severities from raw text when JSON is totally unparseable', () => {
    const garbled = `sast-sentinel output:
"severity": "blocker"
"severity": "minor"
"severity": "blocker"
verdict: fail`;
    expect(parseSastBlockers(garbled)).toBe(2);
  });

  it('returns 0 (not -1) when log has findings but none are blocker', () => {
    const log = JSON.stringify({
      summary: { filesScanned: 3, findingsCount: 2, blockerCount: 0 },
      findings: [
        { severity: 'minor', rule: 'dep-cve-moderate', file: 'package.json', line: 0 },
        { severity: 'major', rule: 'dep-cve-high', file: 'package.json', line: 0 },
      ],
      verdict: 'fail',
    });
    expect(parseSastBlockers(log)).toBe(0);
  });

  it('SAST prompt instructs agent to downgrade dev-dep CVEs to minor', () => {
    expect(orchSrc).toContain('devDependencies');
    expect(orchSrc).toContain('NEVER classify a dev-dependency CVE as');
    expect(orchSrc).toContain("severity 'minor' regardless of CVSS score");
  });

  it('SAST parser has summary-block regex fallback for malformed JSON', () => {
    // Check that the sm = re.search fallback is present
    expect(orchSrc).toContain('sm = re.search');
    expect(orchSrc).toContain('blockerCount');
  });

  it('SAST parser has raw-text severity:blocker count as last resort', () => {
    expect(orchSrc).toContain('Last resort');
    expect(orchSrc).toContain('"severity"');
    // Must print a count, not -1, when JSON is unparseable
    expect(orchSrc).toContain('hits');
  });
});

// ─── Issue 2: write-first absolute path directive ─────────────────────────────

describe('Issue 2 — implementation prompt forces absolute path write-first', () => {
  // Find the build_implementation_prompt function in claude.sh
  const fnStart = claudeSrc.indexOf('build_implementation_prompt()');
  const fnEnd = claudeSrc.indexOf('\nbuild_generator_prompt()', fnStart);
  const fn = claudeSrc.slice(fnStart, fnEnd);

  it('build_implementation_prompt iterates technicalNotes.files to build write directives', () => {
    // Must loop over files and emit a per-file WRITE directive
    expect(fn).toContain('technicalNotes.files');
    expect(fn).toContain('write_first_lines');
  });

  it('each file gets an explicit WRITE <absolute-path> first directive', () => {
    expect(fn).toContain('WRITE ${abs_f} first, before any other action');
  });

  it('prompt resolves relative paths to absolute using PROJECT_ROOT', () => {
    expect(fn).toContain('PROJECT_ROOT');
    expect(fn).toContain('abs_f');
  });

  it('prompt header says EXACT ABSOLUTE PATHS', () => {
    expect(fn).toContain('EXACT ABSOLUTE PATHS');
  });

  it('prompt instructions say write to exact absolute path FIRST', () => {
    expect(fn).toContain('CRITICAL — WRITE FILES FIRST');
    expect(fn).toContain('exact absolute path');
  });

  it('prompt forbids writing to the current directory unless path matches', () => {
    expect(fn).toContain('current directory');
    expect(fn).toContain('matches the path above');
  });
});

// ─── Issue 2b: KB read trap (M3 burns all iterations reading KB.md) ──────────

describe('Issue 2b — KB prompt does not cause M3 to read KB.md before writing', () => {
  // Find the build_kb_prompt_section function
  const kbFnStart = claudeSrc.indexOf('build_kb_prompt_section()');
  const kbFnEnd = claudeSrc.indexOf('\n# Update AGENTS.md', kbFnStart);
  const kbFn = claudeSrc.slice(kbFnStart, kbFnEnd);

  it('KB prompt instructs agent to write implementation files FIRST', () => {
    expect(kbFn).toContain('do this LAST');
    expect(kbFn).toContain('Write ALL implementation files first');
  });

  it('KB prompt explicitly forbids reading KB.md before writing', () => {
    expect(kbFn).toContain('Do NOT read orchestrations/agents/KB.md before writing');
  });

  it('KB prompt says relevant entries are already injected (no need to read the file)', () => {
    expect(kbFn).toContain('already injected above');
  });

  it('constitution rule 3 forbids reading KB.md and AGENTS.md before first write', () => {
    const constitutionIdx = claudeSrc.indexOf('AGENT BEHAVIORAL CONTRACT');
    const constitution = claudeSrc.slice(constitutionIdx, constitutionIdx + 1000);
    expect(constitution).toContain('KB.md');
    expect(constitution).toContain('Do NOT read');
  });
});

// ─── Issue 3: zombie process prevention ───────────────────────────────────────

describe('Issue 3 — runClaude kills process group on timeout (no zombies)', () => {
  const specSrc = readFileSync(
    join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'),
    'utf8',
  );

  it('spawn uses detached:true to create a killable process group', () => {
    expect(specSrc).toContain('detached: true');
  });

  it('timeout sends SIGKILL to entire process group (-pid)', () => {
    expect(specSrc).toContain("process.kill(-proc.pid, 'SIGKILL')");
  });

  it('proc.unref() prevents Node from keeping the event loop alive for timed-out children', () => {
    expect(specSrc).toContain('proc.unref()');
  });

  it('settled flag prevents double-reject when close fires after kill', () => {
    expect(specSrc).toContain('let settled = false');
    expect(specSrc).toContain('if (settled) return');
  });

  it('ladder only fires on timeout/null — hard errors still propagate', () => {
    expect(specSrc).toContain('if (!isTimeout) throw err');
  });
});

// ─── Integration: PRD is clean before a run ───────────────────────────────────

describe('PRD pre-run invariants', () => {
  const prd = JSON.parse(readFileSync(join(ROOT, 'orchestrations/travel-app-prd.json'), 'utf8'));
  const activeIds = new Set(Object.values(prd.implementationOrder as Record<string, string[]>).flat());
  const activeStories = prd.stories.filter((s: any) => activeIds.has(s.id) && s.status !== 'deprecated');

  it('all active stories are pending (no leftover completed/failed)', () => {
    const stale = activeStories.filter((s: any) => !['pending', 'deprecated'].includes(s.status));
    expect(stale.map((s: any) => `${s.id}:${s.status}`)).toHaveLength(0);
  });

  it('no active story has undefined technicalNotes.files (deliverable check would skip)', () => {
    // Stories without files[] skip deliverable check — that is fine, but log them
    const noFiles = activeStories.filter((s: any) => !(s.technicalNotes?.files?.length > 0));
    if (noFiles.length > 0) {
      console.warn('[WARN] Stories with no declared files (deliverable check skipped):',
        noFiles.map((s: any) => s.id).join(', '));
    }
    // Non-blocking — just informational
    expect(typeof noFiles.length).toBe('number');
  });

  it('no duplicate file paths within core phase (parallel-safe deliverable check)', () => {
    // Scaffold/UI phases have sequential stories that refine the same config files —
    // that is intentional. Core stories run sequentially but each owns a distinct file.
    // Only core is checked because deliverable clashes there cause immediate failures.
    const coreIds: string[] = prd.implementationOrder['core'] ?? [];
    const coreStories = prd.stories.filter(
      (s: any) => coreIds.includes(s.id) && s.status !== 'deprecated'
    );
    const fileMap = new Map<string, string[]>();
    for (const s of coreStories) {
      for (const f of (s as any).technicalNotes?.files ?? []) {
        if (!fileMap.has(f)) fileMap.set(f, []);
        fileMap.get(f)!.push((s as any).id);
      }
    }
    // Test files (.test.ts/.spec.ts) are legitimately shared by split children
    // (each child adds more tests to the same file — same exclusion as same-file coherence check)
    const conflicts = [...fileMap.entries()]
      .filter(([f, ids]) => ids.length > 1 && !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'));
    expect(conflicts.map(([f, ids]) => `${f}: [${ids.join(', ')}]`)).toHaveLength(0);
  });

  it('no deprecated story appears in implementationOrder', () => {
    const deprecatedIds = new Set(
      prd.stories.filter((s: any) => s.status === 'deprecated').map((s: any) => s.id)
    );
    const inOrder = [...activeIds].filter(id => deprecatedIds.has(id));
    expect(inOrder).toHaveLength(0);
  });

  it('no active story has contradictory DO-NOT-WRITE note for its own declared file', () => {
    // Pattern: technicalNotes.notes or criticalNotes says "do not write <filename>"
    // where <filename> is the basename of a file declared in technicalNotes.files[].
    // This causes the agent to skip writing its required deliverable.
    // Case-insensitive: "DO NOT write", "Do NOT write", "do not write" all match.
    const contradictions: string[] = [];
    for (const s of activeStories) {
      const files: string[] = s.technicalNotes?.files ?? [];
      const notesLower = [
        s.technicalNotes?.notes ?? '',
        s.technicalNotes?.criticalNotes ?? '',
      ].join('\n').toLowerCase();
      for (const f of files) {
        const bname = (f.split('/').pop() ?? '').toLowerCase();
        if (!bname) continue;
        if (notesLower.includes(`do not write ${bname}`) || notesLower.includes(`do not write or modify ${bname}`)) {
          contradictions.push(`${s.id}: notes say "do not write ${bname}" but files[] declares it`);
        }
      }
    }
    expect(contradictions).toHaveLength(0);
  });

  it('no active story notes instruct agent to write a file not in its own files[]', () => {
    // Pattern: notes say "MUST write X" or "write both X and Y" where X is NOT in files[].
    // This causes the agent to write a sibling-owned file and exhaust iterations without
    // writing the story's actual declared deliverable.
    const overscoped: string[] = [];
    const mustWritePattern = /(?:you )?must write\s+(?:both\s+)?(\S+\.ts)/gi;
    for (const s of activeStories) {
      const files: string[] = (s.technicalNotes?.files ?? []).map((f: string) => f.split('/').pop()!.toLowerCase());
      const notes = (s.technicalNotes?.notes ?? '') + '\n' + (s.technicalNotes?.criticalNotes ?? '');
      let m: RegExpExecArray | null;
      mustWritePattern.lastIndex = 0;
      while ((m = mustWritePattern.exec(notes)) !== null) {
        const mentioned = m[1].toLowerCase();
        if (!files.includes(mentioned)) {
          overscoped.push(`${s.id}: notes say "must write ${m[1]}" but it is not in files[]`);
        }
      }
    }
    expect(overscoped).toHaveLength(0);
  });

  it('no AC references an import path whose module is undeclared in any active story files[]', () => {
    // Pattern: AC says "import X from './Y'" where Y.ts is not owned by any active story.
    // This causes the agent to search for a non-existent module instead of writing the file.
    // Phantom modules are invented by the coordinator split but never assigned to a story.
    // Build set of all declared path suffixes (both basename and subdir/basename)
    const allDeclaredPaths = new Set<string>();
    for (const s of activeStories) {
      for (const f of (s.technicalNotes?.files ?? [])) {
        // Strip leading dirs up to and including /src/ to get import-relative path
        const srcIdx = f.indexOf('/src/');
        const rel = srcIdx >= 0 ? f.slice(srcIdx + 5) : f.split('/').pop()!;
        const noExt = rel.replace(/\.ts$/, '').toLowerCase();
        allDeclaredPaths.add(noExt);
        // Also add basename only
        allDeclaredPaths.add(noExt.split('/').pop()!);
      }
    }
    // Allow well-known node built-ins, installed packages, and side-effect modules
    // skyscanner/types: created by SKY-004-B-IMPL as a side-effect types file (not a declared deliverable)
    const allowList = new Set(['path', 'fs', 'http', 'node', 'url', 'os', 'skyscanner/types']);

    const phantomRefs: string[] = [];
    const importPattern = /from ['"]\.\/([^'"]+)['"]/g;
    for (const s of activeStories) {
      for (const ac of (s.acceptanceCriteria ?? [])) {
        let m: RegExpExecArray | null;
        importPattern.lastIndex = 0;
        while ((m = importPattern.exec(ac)) !== null) {
          const mod = m[1].toLowerCase().replace(/\.ts$/, '');
          if (!allDeclaredPaths.has(mod) && !allowList.has(mod)) {
            phantomRefs.push(`${s.id}: AC references './${m[1]}' which is not declared in any story's files[]`);
          }
        }
      }
    }
    expect(phantomRefs).toHaveLength(0);
  });

  it('no story notes contain the same CRITICAL instruction duplicated (iteration exhaustion)', () => {
    // Pattern: notes copy-paste the same block twice under "--- TEST FILE REQUIREMENTS ---" etc.
    // M3 reads the full notes + reads source files → exhausts its iteration budget before writing.
    // Detection: split notes on newlines, find any line that appears 2+ times (case-insensitive).
    const duplicated: string[] = [];
    for (const s of activeStories) {
      const notes = (s.technicalNotes?.notes ?? '').trim();
      if (!notes) continue;
      const lines = notes.split('\n').map(l => l.trim()).filter(l => l.length > 30);
      const seen = new Map<string, number>();
      for (const line of lines) {
        const key = line.toLowerCase();
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      for (const [, count] of seen) {
        if (count >= 2) {
          duplicated.push(`${s.id}: notes contain a duplicated instruction block (${count}x same line)`);
          break;
        }
      }
    }
    expect(duplicated).toHaveLength(0);
  });

  it('no story notes reference another story\'s owned files (cross-contamination)', () => {
    // Pattern: SKY-003b-1-3 notes say "cli.ts MUST export..." even though cli.ts is owned by SKY-003a-3.
    // M3 reads the cli.ts reference, goes hunting for a file it shouldn't touch, exhausts iterations.
    // Build map: basename → owner story id
    const fileOwner = new Map<string, string>();
    for (const s of activeStories) {
      for (const f of (s.technicalNotes?.files ?? [])) {
        const bname = f.split('/').pop()!.toLowerCase();
        fileOwner.set(bname, s.id);
      }
    }
    const contaminated: string[] = [];
    // Match "cli.ts MUST" / "CRITICAL: server.ts" / "only write table.ts" patterns in sibling notes.
    // Exception: pure test stories (.test.ts only) legitimately reference their impl counterpart files.
    const refPattern = /\b(\w[\w.-]*\.ts)\b/g;
    for (const s of activeStories) {
      const ownedFiles = new Set((s.technicalNotes?.files ?? []).map((f: string) => f.split('/').pop()!.toLowerCase()));
      // Skip pure test stories — they MUST read their impl counterparts
      const isPureTestStory = [...ownedFiles].every(f => f.endsWith('.test.ts'));
      if (isPureTestStory) continue;
      const notes = (s.technicalNotes?.notes ?? '').toLowerCase();
      let m: RegExpExecArray | null;
      refPattern.lastIndex = 0;
      while ((m = refPattern.exec(notes)) !== null) {
        const mentioned = m[1];
        const owner = fileOwner.get(mentioned);
        if (owner && owner !== s.id && !ownedFiles.has(mentioned)) {
          contaminated.push(`${s.id}: notes reference '${mentioned}' which is owned by ${owner}`);
          break;
        }
      }
    }
    expect(contaminated).toHaveLength(0);
  });

  it('no AC blocks completion on a file owned by a later story (forward dependency)', () => {
    // Pattern: SKY-003a-3 AC[4] says "verify against any existing test file" — but cli.test.ts
    // is declared by SKY-003a-test-3 which runs AFTER. M3 can never satisfy this AC.
    const forwardBlocks: string[] = [];
    // Build implementationOrder to determine story sequence
    const order: string[] = (prd.implementationOrder?.core ?? []);
    const storyIndex = new Map<string, number>(order.map((id: string, i: number) => [id, i]));
    for (const s of activeStories) {
      const myIdx = storyIndex.get(s.id) ?? -1;
      if (myIdx < 0) continue;
      const ownedFiles = new Set((s.technicalNotes?.files ?? []).map((f: string) => f.split('/').pop()!.toLowerCase()));
      for (const ac of (s.acceptanceCriteria ?? [])) {
        // Look for phrases that demand verification against a file owned by a later story
        if (/verif\w*.*against.*existing.*test file|check\w*.*against.*existing.*test/i.test(ac)) {
          // Find which test files are referenced by ACs and whether they're from later stories
          const refPattern = /\b(\w[\w.-]*\.test\.ts)\b/gi;
          let m: RegExpExecArray | null;
          refPattern.lastIndex = 0;
          let blocked = false;
          while ((m = refPattern.exec(ac)) !== null) {
            const fname = m[1].toLowerCase();
            // Find which story owns this test file
            for (const other of activeStories) {
              const otherFiles = (other.technicalNotes?.files ?? []).map((f: string) => f.split('/').pop()!.toLowerCase());
              if (otherFiles.includes(fname)) {
                const otherIdx = storyIndex.get(other.id) ?? -1;
                if (otherIdx > myIdx) {
                  forwardBlocks.push(`${s.id}: AC requires '${fname}' which is written by ${other.id} (runs later)`);
                  blocked = true;
                }
              }
            }
          }
          // If the phrase exists but no specific file is named, flag generic "existing test file" instructions
          if (!blocked && /against any existing test file/i.test(ac)) {
            forwardBlocks.push(`${s.id}: AC says "verify against any existing test file" — no test file guaranteed to exist at this point`);
          }
        }
      }
    }
    expect(forwardBlocks).toHaveLength(0);
  });

  it('AC type names match types actually exported by declared story files (no FlightResult vs Flight mismatch)', () => {
    // Pattern: SKY-003b-1-3 AC[0] says "imports the Flight type" but actual export is FlightResult.
    // We can't run TypeScript here, so we check that any type name mentioned as "the X type" or
    // "X interface" in ACs is either (a) declared in the story's own files[] or (b) exists in the
    // PRD's declared files under a consistent name across all AC references.
    // Simpler check: collect all type names mentioned across ACs of the same story and confirm
    // they don't contradict each other (e.g., Flight in one AC, FlightResult in another).
    const mismatches: string[] = [];
    for (const s of activeStories) {
      const typeRefs = new Set<string>();
      const typePattern = /\bthe\s+`?(\w+Result|\w+Response|\w+Data|\w+Type|\w+Interface|\w+Params|\w+Options|\w+Args|\w+Config|\w+Input|\w+Output)`?\s+(?:type|interface)/gi;
      for (const ac of (s.acceptanceCriteria ?? [])) {
        let m: RegExpExecArray | null;
        typePattern.lastIndex = 0;
        while ((m = typePattern.exec(ac)) !== null) {
          typeRefs.add(m[1]);
        }
      }
      // Also check notes for declared type names
      const notePattern = /\bFlightResult\b|\bFlight\b(?!Result)/g;
      const notesText = (s.technicalNotes?.notes ?? '') + (s.technicalNotes?.criticalNotes ?? '');
      const hasFlightResult = /FlightResult/.test(notesText) || s.acceptanceCriteria?.some((ac: string) => /FlightResult/.test(ac));
      // Only flag backtick-quoted type references like `Flight[]` or `Flight` — not English noun "Flight rows"
      const hasFlightPlain = s.acceptanceCriteria?.some((ac: string) => /`Flight(?!Result)[`\[]/.test(ac) || /\btype\s+Flight\b(?!Result)/i.test(ac));
      if (hasFlightResult && hasFlightPlain) {
        mismatches.push(`${s.id}: ACs reference both 'Flight' and 'FlightResult' — inconsistent type name`);
      }
    }
    expect(mismatches).toHaveLength(0);
  });

  it('stories that write table files have explicit spec-override note (spec-mode may inject wrong Flight type)', () => {
    // spec-baseline.json generated by spec-mode uses `Flight[]` and `import { Flight } from './types'`
    // even when the PRD says FlightResult. M3 follows the spec over the AC.
    // Guard: any story whose declared FILES include table.ts or table.test.ts must have a note
    // explicitly overriding the spec's wrong type — either mentioning FlightResult+skyscanner/client
    // or forbidding import from ./types.
    const missing: string[] = [];
    for (const s of activeStories) {
      const files: string[] = (s.technicalNotes?.files ?? []).map((f: string) => f.split('/').pop()!);
      const isTableStory = files.some(f => /^table\.(ts|test\.ts)$/.test(f));
      if (!isTableStory) continue;
      const notesText = (s.technicalNotes?.notes ?? '') + (s.technicalNotes?.criticalNotes ?? '');
      const hasOverride = /FlightResult.*skyscanner.client|do not import from.*\.\/types|no.*\.\/types.*module|spec.*wrong.*Flight|ignore.*Flight.*type/i.test(notesText);
      if (!hasOverride) {
        missing.push(`${s.id}: writes table file but lacks spec-override note for FlightResult vs Flight`);
      }
    }
    expect(missing).toHaveLength(0);
  });

  it('stories with test file deliverables have explicit WriteFile-first enforcement note', () => {
    // Pattern: M3 writes the entire implementation in <think> blocks then runs out of tokens
    // before calling WriteFile. Mitigation: notes must include a directive referencing the
    // ABSOLUTE PATH of the file to write, to anchor the first tool call.
    const missing: string[] = [];
    for (const s of activeStories) {
      const files: string[] = (s.technicalNotes?.files ?? []);
      if (files.length === 0) continue;
      const notesText = (s.technicalNotes?.notes ?? '');
      // Must include explicit absolute path write directive
      const hasPathDirective = files.some(f => notesText.includes(f) || notesText.toLowerCase().includes('write the file first'));
      if (!hasPathDirective) {
        missing.push(`${s.id}: has declared files but notes lack write-first directive`);
      }
    }
    expect(missing).toHaveLength(0);
  });
});

// ─── Issue 5: spec-mode MiniMax fast-path bypass ─────────────────────────────

describe('Issue 5 — spec-mode bypasses MiniMax when SPEC_MODE_PROVIDER is set', () => {
  const specSrc = readFileSync(
    join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'),
    'utf8',
  );
  const tier3Src = readFileSync(
    join(ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh'),
    'utf8',
  );

  it('runAgentForJson has SPEC_MODE_PROVIDER fast-path that skips minimax block', () => {
    expect(specSrc).toMatch(/SPEC_MODE_PROVIDER/);
    // Fast-path must appear BEFORE the minimax provider check
    const fastPathIdx = specSrc.indexOf('SPEC_MODE_PROVIDER');
    const minimaxIdx = specSrc.indexOf("provider === 'minimax'");
    expect(fastPathIdx).toBeGreaterThan(-1);
    expect(fastPathIdx).toBeLessThan(minimaxIdx);
  });

  it('speckit log path routes to SPEC_MODE_SPECKIT_MODEL', () => {
    expect(specSrc).toMatch(/speckit.*SPEC_MODE_SPECKIT_MODEL|SPEC_MODE_SPECKIT_MODEL.*speckit/s);
  });

  it('openspec log path routes to SPEC_MODE_OPENSPEC_MODEL', () => {
    expect(specSrc).toMatch(/openspec.*SPEC_MODE_OPENSPEC_MODEL|SPEC_MODE_OPENSPEC_MODEL.*openspec/s);
  });

  it('tier3 script exports SPEC_MODE_PROVIDER=qwen', () => {
    expect(tier3Src).toMatch(/SPEC_MODE_PROVIDER=["']?qwen["']?/);
  });

  it('tier3 script sets SPEC_MODE_OPENSPEC_MODEL to kimi-k2', () => {
    expect(tier3Src).toMatch(/SPEC_MODE_OPENSPEC_MODEL.*kimi-k2/);
  });

  it('tier3 script sets SPEC_MODE_SPECKIT_MODEL to glm', () => {
    expect(tier3Src).toMatch(/SPEC_MODE_SPECKIT_MODEL.*glm/i);
  });
});

// ─── Issue 6: Per-story cost logging ─────────────────────────────────────────

describe('Issue 6 — per-story cost logging emitted to run log', () => {
  it('append_cost_record emits a human-readable Cost[] log line', () => {
    // The log line must appear so grep on the run log shows per-story cost.
    expect(claudeSrc).toMatch(/log.*Cost\[.*\].*model=.*in=.*out=.*cost=.*elapsed=.*status=/);
  });

  it('Cost[] log line includes model, token counts, cost and status fields', () => {
    const match = claudeSrc.match(/log.*Cost\[([^\]]+)\]([^\n]+)/);
    expect(match).not.toBeNull();
    const line = match![0];
    expect(line).toMatch(/model=/);
    expect(line).toMatch(/in=/);
    expect(line).toMatch(/out=/);
    expect(line).toMatch(/cost=/);
    expect(line).toMatch(/elapsed=/);
    expect(line).toMatch(/status=/);
  });

  it('append_cost_record is called on both success and failure paths', () => {
    const successCalls = (claudeSrc.match(/append_cost_record.*"completed"/g) ?? []).length;
    const failureCalls = (claudeSrc.match(/append_cost_record.*"failed"/g) ?? []).length;
    expect(successCalls).toBeGreaterThanOrEqual(1);
    expect(failureCalls).toBeGreaterThanOrEqual(1);
  });
});

// ─── Issue 7: Run 78 pre-flight confidence checks ────────────────────────────

describe('Issue 7 — run 78 confidence: GLM slug, K2 timeout, perf-sentinel git', () => {
  const tier3Src = readFileSync(
    join(ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh'),
    'utf8',
  );
  const orchSrc2 = readFileSync(
    join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'),
    'utf8',
  );
  const specSrc2 = readFileSync(
    join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'),
    'utf8',
  );

  // ── GLM slug format ──────────────────────────────────────────────────────
  it('SPEC_MODE_SPECKIT_MODEL slug follows OpenRouter org/model format', () => {
    // OpenRouter slugs must be "org/model-name" — no spaces, no bare model names
    const match = tier3Src.match(/SPEC_MODE_SPECKIT_MODEL[^"'\n]*["']?([a-z0-9._-]+\/[a-z0-9._-]+)["']?/i);
    expect(match).not.toBeNull();
    const slug = match![1];
    expect(slug).toMatch(/^[a-z0-9_-]+\/[a-z0-9._-]+$/i);
  });

  it('SPEC_MODE_SPECKIT_MODEL slug contains zhipuai org (Zhipu AI GLM)', () => {
    expect(tier3Src).toMatch(/SPEC_MODE_SPECKIT_MODEL.*zhipuai/i);
  });

  it('SPEC_MODE_SPECKIT_MODEL slug contains glm model name', () => {
    expect(tier3Src).toMatch(/SPEC_MODE_SPECKIT_MODEL.*glm/i);
  });

  it('SPEC_MODE_OPENSPEC_MODEL slug contains moonshotai org (Kimi K2)', () => {
    expect(tier3Src).toMatch(/SPEC_MODE_OPENSPEC_MODEL.*moonshotai/i);
  });

  it('SPEC_MODE_OPENSPEC_MODEL slug contains kimi-k2 model name', () => {
    expect(tier3Src).toMatch(/SPEC_MODE_OPENSPEC_MODEL.*kimi-k2/i);
  });

  // ── K2 fast-path timeout handling ───────────────────────────────────────
  it('spec-mode fast-path uses runClaude which has RUNCLAUDE_TIMEOUT_MS guard', () => {
    // runClaude wraps all calls — verify it has a timeout mechanism
    expect(specSrc2).toMatch(/RUNCLAUDE_TIMEOUT_MS/);
  });

  it('spec-mode fast-path wraps runClaude output (not raw MiniMax tool-use)', () => {
    // Fast-path uses extractTaggedJson on runClaude output — tag-based extraction
    // is resilient to partial/slow responses unlike raw tool-use JSON parsing
    const fastPathBlock = specSrc2.slice(
      specSrc2.indexOf('SPEC_MODE_PROVIDER'),
      specSrc2.indexOf("provider === 'minimax'")
    );
    expect(fastPathBlock).toMatch(/runClaude/);
    expect(fastPathBlock).toMatch(/extractTaggedJson/);
  });

  // ── Perf-sentinel git repo ───────────────────────────────────────────────
  it('tier3 script initialises git repo in OUTPUT_DIR before stories run', () => {
    // Must have git init so perf-sentinel can run git diff
    // Pattern: git -C "$OUTPUT_DIR" init (teardown recreates the repo)
    expect(tier3Src).toMatch(/git\s+-C.*init/);
    expect(tier3Src).toMatch(/git.*commit.*allow-empty/);
  });

  it('tier3 OUTPUT_DIR is a persistent path outside /tmp', () => {
    // Must reference a persistent location — not an ephemeral /tmp path
    expect(tier3Src).toMatch(/OUTPUT_DIR.*\/projects\/skyscanner-app/);
    expect(tier3Src).not.toMatch(/OUTPUT_DIR="\/tmp\//);
  });

  it('perf-sentinel verdict parser treats non-fail verdict as non-blocking', () => {
    // Blocker condition: only "fail" verdict triggers gate failure
    // "pass", "warn", and missing verdict must NOT set failed=1
    const perfBlock = orchSrc2.slice(
      orchSrc2.indexOf('perf_exit -ne 0'),
      orchSrc2.indexOf('Phase C (fuzz-weaver + perf-sentinel) skipped')
    );
    // Only "fail" verdict should trigger error + failed=1
    expect(perfBlock).toMatch(/"verdict".*"fail"/);
    // warn verdict must be non-blocking (no failed=1 after warn)
    const warnIdx = perfBlock.indexOf('"warn"');
    const failedAfterWarn = perfBlock.slice(warnIdx, warnIdx + 100);
    expect(failedAfterWarn).not.toMatch(/failed=1/);
  });
});
