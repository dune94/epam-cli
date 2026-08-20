// THE TC WRITER WAS TOLD TO WRITE A FILE AND GIVEN NO TOOL THAT CAN WRITE.
//
// The prompt said: "Write your JSON to __TC_OUT_FILE__ — Use WriteFile to write the complete JSON
// object to that path." Its registered grant is `read-only`, which resolves to twelve tools, none
// of which write. The agent said so verbatim in the run of 2026-08-20:
//
//   "I cannot write this to `/home/.../orchestrations/scripts/../logs/tc-core.json` because no
//    file-writing tool i[s available]"
//
// What happened next is the pattern that runs through every defect this week:
//
//   TC_WRITER_DONE  [tc-writer] Applied TCs to 0 stories: []
//   [tc-writer] Gate PASSED — all test stories have verified TCs
//
// It applied nothing and reported success. And the file it read was `tc-core.json` dated JULY 31,
// containing `MOCK-HW-1-test` from an unrelated mock run — a stale artefact standing in for this
// run's output, which is why "0 stories" and not an error.
//
// THE FIX IS NOT A WRITE TOOL. The engine already has the better pattern and states the reason in
// the skill-assessment prompt: "You do NOT write any file... hand-rolling scripts to edit a
// 136,000-character JSON file is what made every previous attempt run out of iterations." The
// agent RETURNS the JSON; the engine writes it. The agent stays read-only and no write path into
// orchestrations/logs/ exists at all.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const EXTRACT = join(ROOT, 'orchestrations/scripts/lib/handlers/tc-extract-output.py');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/tc-writer.json');
const PRODUCER = join(ROOT, 'orchestrations/scripts/post-impl-tc-writer.sh');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const dir = () => { const d = mkdtempSync(join(tmpdir(), 'tc-extract-')); made.push(d); return d; };

/** Run the extractor: agent output on stdin, destination as argv[1]. */
function extract(agentOutput: string, dest: string): { status: number; stderr: string } {
  const r = spawnSync('python3', [EXTRACT, dest], { input: agentOutput, encoding: 'utf8' });
  return { status: r.status ?? -1, stderr: r.stderr || '' };
}

const VALID = {
  'TICKET-1': {
    verifiedAt: '2026-08-20T00:00:00Z',
    sourceFiles: ['src/thing.ts'],
    facts: ['getThing returns the published entry unless a preview signal is active'],
    mockStrategy: 'jest.mock("services/thing") with a factory',
    bannedPatterns: ['vi.mock'],
  },
};

describe('the engine writes the file, from what the agent returned', () => {
  it('an extractor exists', () => {
    expect(existsSync(EXTRACT), 'nothing turns the agent answer into the file the applier reads').toBe(true);
  });

  it('extracts the JSON object from a normal agent answer', () => {
    const d = dir(); const out = join(d, 'tc-core.json');
    const r = extract(`Here are the criteria I derived.\n\n${JSON.stringify(VALID)}\n\nTC_WRITER_DONE\n`, out);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(VALID);
  });

  it('handles a fenced code block, which models emit constantly', () => {
    const d = dir(); const out = join(d, 'tc-core.json');
    const r = extract('```json\n' + JSON.stringify(VALID) + '\n```\nTC_WRITER_DONE\n', out);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(VALID);
  });
});

describe('absence is never success', () => {
  it('an answer with no JSON writes NOTHING and exits non-zero', () => {
    const d = dir(); const out = join(d, 'tc-core.json');
    const r = extract('I could not determine the test criteria for this story.\n', out);
    expect(r.status, 'a missing answer was treated as an answer').not.toBe(0);
    expect(existsSync(out), 'it wrote a file from nothing').toBe(false);
  });

  it('says why on stderr rather than failing mutely', () => {
    const d = dir(); const out = join(d, 'tc-core.json');
    expect(extract('no json here', out).stderr).toMatch(/no JSON|could not/i);
  });

  it('malformed JSON is refused, not half-written', () => {
    const d = dir(); const out = join(d, 'tc-core.json');
    const r = extract('{"TICKET-1": {"facts": [ }\nTC_WRITER_DONE', out);
    expect(r.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it('a STALE destination from an earlier run is removed, never inherited', () => {
    // The live failure: tc-core.json dated 31 July, holding MOCK-HW-1-test from a mock run, was
    // read as this run's output — so the applier reported "0 stories" instead of an error.
    const d = dir(); const out = join(d, 'tc-core.json');
    writeFileSync(out, JSON.stringify({ 'MOCK-HW-1-test': { facts: ['from another project'] } }));
    const r = extract('the agent produced no JSON this time', out);
    expect(r.status).not.toBe(0);
    expect(existsSync(out), 'last run\'s file survived and would be applied as this run\'s answer')
      .toBe(false);
  });
});

describe('the agent is no longer asked to do the impossible', () => {
  const body = (): string => {
    const j = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    return String(j.body ?? Object.values(j.bodies ?? {}).join('\n'));
  };

  it('the prompt does not tell it to use a write tool', () => {
    expect(body()).not.toMatch(/WriteFile/);
  });

  it('it asks for the JSON as the answer instead', () => {
    expect(body().toLowerCase()).toMatch(/return|respond with|your (final )?answer/);
  });

  it('and the seam stays read-only', () => {
    const p = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
    expect(p.profiles['tc-writer'].toolGrant).toBe('read-only');
  });

  it('the producer runs the extractor over the captured output', () => {
    expect(readFileSync(PRODUCER, 'utf8')).toMatch(/tc-extract-output\.py/);
  });
});

describe('a story that needed criteria and got none is a failure, not a no-op', () => {
  // With the extractor fixed, the missing file is now HONEST — but the applier still said
  // "Agent succeeded but wrote no TC file — treating as no-op" and exited 0, so the gate reported
  // "PASSED — all test stories have verified TCs" over a story with none. Absence read as success,
  // one layer down from where it was fixed.
  const APPLY = join(ROOT, 'orchestrations/scripts/lib/handlers/tc-apply-to-prd.py');

  function fixture(): { prd: string; out: string; tc: string } {
    const d = dir();
    const prd = join(d, 'prd.json');
    writeFileSync(prd, JSON.stringify({
      implementationOrder: { core: ['TICKET-1'] },
      stories: [{ id: 'TICKET-1', technicalNotes: { files: ['src/thing.ts'] },
                  verificationCriteria: ['published content renders unchanged'],
                  acceptanceCriteria: [] }],
    }, null, 2));
    return { prd, out: d, tc: join(d, 'tc-core.json') };
  }

  const apply = (f: { prd: string; out: string; tc: string }) =>
    spawnSync('python3', [APPLY, f.tc, f.out, f.prd, '0', 'core', 'TICKET-1'], { encoding: 'utf8' });

  it('fails when the targeted story still has no criteria', () => {
    const f = fixture();                       // no tc file at all — the extractor refused
    const r = apply(f);
    expect(r.status, 'a story that needed test criteria got none and the step passed')
      .not.toBe(0);
  });

  it('says which story, so the failure is actionable', () => {
    const f = fixture();
    expect(apply(f).stdout + apply(f).stderr).toMatch(/TICKET-1/);
  });

  it('still succeeds when the criteria did land', () => {
    const f = fixture();
    writeFileSync(f.tc, JSON.stringify({
      'TICKET-1': { verifiedAt: 'now', sourceFiles: ['src/thing.ts'],
                    facts: ['a checkable fact'], mockStrategy: 'jest.mock(...)', bannedPatterns: [] },
    }));
    expect(apply(f).status).toBe(0);
  });
});
