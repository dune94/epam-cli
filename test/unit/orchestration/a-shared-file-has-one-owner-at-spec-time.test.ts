/**
 * A SHARED FILE HAS ONE OWNER, DECIDED AT SPEC TIME.
 *
 * regintel 20260919T224649Z: REGI-004 and REGI-005 both declared regintel/classifier.py. The
 * split gave classifier.py to BOTH impl children (004a, 005a); each writer rewrote classify_event
 * to its own story's criteria (async client=/sink= vs sync conn,event_row), each story's test
 * child pinned the other shape, and the codeline flip-flopped between them for 20 attempts.
 * Nothing in the spec pass ever told either story that the file was shared.
 *
 * The spec agent is now told, per story, which of its files other stories also declare (and any
 * ownership already claimed), and answers with a decision the contract can carry: consume the
 * owner's interface (consumesInterfaces) or claim the file (ownsSharedFiles). The runner applies
 * the decision — a consumed file leaves the story's files and its owner becomes a dependency —
 * and the writer of the consuming story is briefed with the interface. Same block in both spec
 * templates (greenfield and brownfield); same fields in the one contract every provider answers.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
let spec: any;
beforeAll(() => {
  process.env.SPEC_MODE_NO_MAIN = '1';
  process.env.EPAM_BROWNFIELD = '';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
});

const PRD = { stories: [
  { id: 'REGI-004', status: 'deprecated', technicalNotes: { files: ['regintel/classifier.py', 'tests/test_classifier.py'] } },
  { id: 'REGI-004a', status: 'completed', specification: { createdFrom: 'REGI-004' }, technicalNotes: { files: ['regintel/classifier.py', 'regintel/config.py'] } },
  { id: 'REGI-005', status: 'pending', technicalNotes: { files: ['regintel/escalation.py', 'regintel/classifier.py', 'tests/test_escalation.py'] } },
  { id: 'REGI-006', status: 'pending', technicalNotes: { files: ['regintel/store.py'] } },
] };

describe('the input: which of this story\'s files other stories also declare', () => {
  it('names the shared file and its other declarers with their status', () => {
    const block = spec.sharedFileBlock(PRD.stories[2], PRD);
    expect(block).toMatch(/regintel\/classifier\.py/);
    expect(block).toMatch(/REGI-004a/);
    expect(block).toMatch(/completed/);
    expect(block, 'the story\'s unshared files are not "shared"').not.toMatch(/escalation\.py/);
  });
  it('a deprecated story (a split parent still listing its combined files) is not a declarer', () => {
    expect(spec.sharedFileBlock(PRD.stories[2], PRD)).not.toMatch(/REGI-004\b(?!a)/);
  });
  it('is empty when nothing is shared', () => {
    expect(spec.sharedFileBlock(PRD.stories[3], PRD)).toBe('');
  });
  it('shows an ownership already claimed by another story', () => {
    const prd = JSON.parse(JSON.stringify(PRD));
    prd.stories[1].ownsSharedFiles = ['regintel/classifier.py'];
    expect(spec.sharedFileBlock(prd.stories[2], prd)).toMatch(/REGI-004a[^\n]*claim|claim[^\n]*REGI-004a/i);
  });
  it('the words are the template layer\'s, not the runner\'s', () => {
    const block = spec.sharedFileBlock(PRD.stories[2], PRD);
    const tpl = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/shared-file-ownership.json'), 'utf8'));
    const firstLine = String(tpl.body).split('\n').find((l: string) => l.trim() && !l.includes('__'))!.trim();
    expect(block).toContain(firstLine);
  });
});

describe('the prompt: both spec templates carry the block', () => {
  for (const f of ['spec-agent-openspec.json', 'spec-agent-openspec.brownfield.json']) {
    it(`${f} declares __SHARED_FILE_OWNERSHIP_BLOCK__`, () => {
      const tpl = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates', f), 'utf8'));
      expect(tpl.placeholders).toContain('__SHARED_FILE_OWNERSHIP_BLOCK__');
      expect(String(tpl.body)).toContain('__SHARED_FILE_OWNERSHIP_BLOCK__');
    });
  }
  it('runSpecAgent supplies it from the PRD', () => {
    expect(String(spec.runSpecAgent)).toMatch(/__SHARED_FILE_OWNERSHIP_BLOCK__: sharedFileBlock\(story, prd\)/);
  });
});

describe('the contract: the decision fields exist in both modes', () => {
  it('greenfield', () => {
    const p = spec.specAgentContract().parameters.properties;
    expect(p.consumesInterfaces).toBeTruthy();
    expect(p.ownsSharedFiles).toBeTruthy();
    expect(p.consumesInterfaces.items.properties).toMatchObject({ file: expect.anything(), ownerStoryId: expect.anything(), symbol: expect.anything(), signature: expect.anything() });
  });
  it('brownfield', () => {
    process.env.EPAM_BROWNFIELD = '1';
    try {
      const p = spec.specAgentContract().parameters.properties;
      expect(p.consumesInterfaces).toBeTruthy();
      expect(p.ownsSharedFiles).toBeTruthy();
    } finally { process.env.EPAM_BROWNFIELD = ''; }
  });
});

describe('the runner applies the decision', () => {
  function apply(payload: any) {
    const prd = JSON.parse(JSON.stringify(PRD));
    const story = prd.stories[2];
    spec.applySpecChanges(story, { acceptanceCriteria: ['a'], ...payload }, [], prd, 'core', 'R1');
    return story;
  }
  it('a consumed file leaves the story\'s files, its owner becomes a dependency, the interface is persisted', () => {
    const s = apply({ consumesInterfaces: [{ file: 'regintel/classifier.py', ownerStoryId: 'REGI-004a', symbol: 'classify_event', signature: 'async def classify_event(event, client=None, sink=None) -> ClassificationRecord' }] });
    expect(s.technicalNotes.files).not.toContain('regintel/classifier.py');
    expect(s.technicalNotes.files).toContain('regintel/escalation.py');
    expect(s.dependencies).toContain('REGI-004a');
    expect(s.consumesInterfaces[0].symbol).toBe('classify_event');
  });
  it('a claim is persisted', () => {
    expect(apply({ ownsSharedFiles: ['regintel/classifier.py'] }).ownsSharedFiles).toEqual(['regintel/classifier.py']);
    expect(apply({ ownsSharedFiles: ['regintel/classifier.py'] }).technicalNotes.files).toContain('regintel/classifier.py');
  });
  it('no decision, no change', () => {
    const s = apply({});
    expect(s.technicalNotes.files).toContain('regintel/classifier.py');
    expect(s.consumesInterfaces).toBeUndefined();
  });
});

describe('the consumer: the writer is briefed with the interface', () => {
  it('consumed_interfaces_block renders each interface with its owner, symbol and signature', () => {
    const lib = join(ROOT, 'orchestrations/scripts/lib/writer-prompt.sh');
    const story = JSON.stringify({ id: 'REGI-005a', consumesInterfaces: [{ file: 'regintel/classifier.py', ownerStoryId: 'REGI-004a', symbol: 'classify_event', signature: 'async def classify_event(event, client=None, sink=None)' }] });
    const r = spawnSync('bash', ['-c', `source ${JSON.stringify(lib)} 2>/dev/null; consumed_interfaces_block ${JSON.stringify(story)}`], { encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;
    expect(out, out).toMatch(/REGI-004a/);
    expect(out).toMatch(/classify_event/);
    expect(out).toMatch(/async def classify_event\(event, client=None, sink=None\)/);
    expect(out).toMatch(/regintel\/classifier\.py/);
  });
  it('renders nothing for a story that consumes nothing', () => {
    const lib = join(ROOT, 'orchestrations/scripts/lib/writer-prompt.sh');
    const r = spawnSync('bash', ['-c', `source ${JSON.stringify(lib)} 2>/dev/null; consumed_interfaces_block '{"id":"X"}'`], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('');
  });
  it('the block lands in the writer\'s dependency-contracts input', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/lib/writer-prompt.sh'), 'utf8');
    expect(src).toMatch(/dependency_contracts="\$\{dependency_contracts\}\$\(consumed_interfaces_block "\$story_json"\)"/);
  });
});
