/**
 * A GREENFIELD PRD MEETS NONE OF ITS OWN EARLIER RUNS (operator, 2026-10-29).
 *
 * A greenfield test starts from the PRD alone; the pipeline builds the app. The shipped knowledge files the estimation
 * step searches (orchestrations/agents/*.md — contextualize-stories.sh hands every .md there to lib/tfidf.js) carried the
 * history of earlier builds of the same PRD: four learned KB entries (KB.md, restored each run from KB.md.original) and
 * 1,803 run-log sections (AGENTS.md). Measured: the PRD's own stories got 1–3 of their 5 estimation chunks from them.
 *
 * The removal is exactly those sections and nothing else, so what brownfield runs search is otherwise unchanged: the
 * negative test compares each file with the previous release section by section.
 *
 * The PRD and its story ids are read from the repo's copy of the PRD — no project name is written here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const AGENTS = join(ROOT, 'orchestrations', 'agents');
const PRD = JSON.parse(readFileSync(join(ROOT, 'orchestrations', 'travel-app-prd.canonical.json'), 'utf8'));
const FILES = ['KB.md', 'KB.md.original', 'AGENTS.md'];
const PREVIOUS_RELEASE = 'v2.0.81';

/** The PRD's story-id prefixes ("ABC-" from "ABC-001"), read from the PRD. */
const prefixes = [...new Set(PRD.stories.map((s: { id: string }) => s.id.replace(/\d.*$/, '')))] as string[];
const mentionsPrd = new RegExp(`\\b(${prefixes.map((p) => p.replace(/[-]/g, '\\-')).join('|')})\\d`);
/** A markdown file split at its ## / ### headings, as the measured removal did. */
const sections = (text: string) => text.split(/^(?=#{2,3} )/m);

describe('the shipped knowledge files carry none of the greenfield PRD\'s earlier runs', () => {
  it('the PRD and its prefixes were read (non-vacuous)', () => {
    expect(PRD.stories.length).toBeGreaterThan(0);
    expect(prefixes.length).toBeGreaterThan(0);
  });

  it('the estimation step\'s own search, asked as it asks for each of the PRD\'s stories, returns none of their earlier runs', () => {
    for (const s of PRD.stories) {
      const query = `${s.title || ''} ${(s.description || '').slice(0, 200)} ${((s.technicalNotes || {}).requiredSkills || []).join(' ')}`;
      const out = execFileSync(process.execPath, [join(ROOT, 'orchestrations', 'scripts', 'lib', 'tfidf.js'),
        '--kb-dir', AGENTS, '--query', query, '--top', '5', '--chunk-size', '25'], { encoding: 'utf8' });
      const chunks = JSON.parse(out) as { source: string; chunk: string }[];
      expect(chunks.length, `${s.id}: the search returned chunks`).toBeGreaterThan(0);
      for (const c of chunks) expect(c.chunk, `${s.id} got a chunk of ${c.source} naming an earlier run`).not.toMatch(mentionsPrd);
    }
  });

  it('NEGATIVE: every other section is exactly as the previous release shipped it, in order (brownfield searches the same text)', () => {
    for (const f of FILES) {
      const before = execFileSync('git', ['show', `${PREVIOUS_RELEASE}:orchestrations/agents/${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
      const kept = sections(before).filter((x) => !mentionsPrd.test(x));
      expect(kept.length, `${f}: sections kept`).toBeGreaterThan(0);
      expect(kept.length, `${f}: something was removed`).toBeLessThan(sections(before).length);
      expect(readFileSync(join(AGENTS, f), 'utf8'), `${f} is the previous release minus the PRD's sections, byte for byte`).toBe(kept.join(''));
    }
  });
});
