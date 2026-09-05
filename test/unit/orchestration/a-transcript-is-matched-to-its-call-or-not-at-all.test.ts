/**
 * A TRANSCRIPT IS MATCHED TO ITS CALL, OR NOT AT ALL.
 *
 * The calls a model made live in the runner's own session transcript, and the cost seam — which is
 * where every call is already observed — must find the right one. It knows when the call started
 * and ended, and the transcript directory is derived from the working directory.
 *
 * PRECISE OR SILENT, NEVER A GUESS. Attributing another seam's transcript to this call would put
 * another agent's tool calls into this one's recording, and a cassette built from it would replay
 * the wrong action. That is the contamination class this repository has been bitten by twice —
 * mock3's spec pass served metrolinx's answer and declared a metrolinx file; another client's
 * documentation sat in mock3's prompts for nineteen days. So when more than one transcript could
 * belong to this call — which is exactly what parallel lanes produce — the answer is NOTHING.
 *
 * A missing recording is honest and costs a stand-in. A wrong one is undetectable and poisons the
 * replay.
 *
 * This deliberately requires no change to the invocation: the runner is spawned exactly as before.
 * `--session-id` would make the match exact and remove the ambiguity case entirely, and is the
 * upgrade this leaves room for — but it touches the paid call path, so it is not taken lightly.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOD = join(__dirname, '../../../orchestrations/scripts/lib/transcript-tool-calls.js');

/** A transcript directory holding files with controlled modification times. */
function dirWith(files: Array<{ name: string; mtime: Date; lines?: unknown[] }>) {
  const dir = mkdtempSync(join(tmpdir(), 'tx-match-'));
  for (const f of files) {
    const p = join(dir, f.name);
    writeFileSync(p, (f.lines ?? [{ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'echo hi' } }] } }])
      .map((l) => JSON.stringify(l)).join('\n') + '\n');
    utimesSync(p, f.mtime, f.mtime);
  }
  return dir;
}

const t = (iso: string) => new Date(iso);

describe('finding the transcript for one call', () => {
  const { transcriptForCall } = require(MOD);

  it('the matcher exists', () => {
    expect(typeof transcriptForCall, 'transcriptForCall is not exported').toBe('function');
  });

  const started = '2026-09-04T12:00:00.000Z';
  const ended = '2026-09-04T12:05:00.000Z';

  it('matches the ONE transcript written during the call', () => {
    const dir = dirWith([
      { name: 'before.jsonl', mtime: t('2026-09-04T11:00:00Z') },
      { name: 'mine.jsonl', mtime: t('2026-09-04T12:03:00Z') },
      { name: 'after.jsonl', mtime: t('2026-09-04T13:00:00Z') },
    ]);
    try {
      expect(transcriptForCall(dir, started, ended)).toMatch(/mine\.jsonl$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns NOTHING when two could be this call — parallel lanes must not cross-contaminate', () => {
    const dir = dirWith([
      { name: 'lane-a.jsonl', mtime: t('2026-09-04T12:01:00Z') },
      { name: 'lane-b.jsonl', mtime: t('2026-09-04T12:02:00Z') },
    ]);
    try {
      expect(transcriptForCall(dir, started, ended), [
        'two transcripts fall in this call\'s window and one was chosen anyway. Attributing another',
        'seam\'s tool calls to this recording replays the wrong action, undetectably.',
      ].join('\n')).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns nothing when none falls in the window', () => {
    const dir = dirWith([{ name: 'old.jsonl', mtime: t('2026-09-04T09:00:00Z') }]);
    try {
      expect(transcriptForCall(dir, started, ended)).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a missing directory is not an error', () => {
    expect(() => transcriptForCall('/no/such/dir', started, ended)).not.toThrow();
    expect(transcriptForCall('/no/such/dir', started, ended)).toBe('');
  });

  it('bad or absent timestamps yield nothing rather than matching everything', () => {
    const dir = dirWith([{ name: 'x.jsonl', mtime: t('2026-09-04T12:03:00Z') }]);
    try {
      expect(transcriptForCall(dir, '', '')).toBe('');
      expect(transcriptForCall(dir, 'not-a-date', 'nor-this')).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('tolerates a small clock skew at the end of the window', () => {
    // The transcript is flushed as the call finishes, so its mtime can land marginally after the
    // recorded end. A hard boundary would lose most real captures.
    const dir = dirWith([{ name: 'edge.jsonl', mtime: t('2026-09-04T12:05:02Z') }]);
    try {
      expect(transcriptForCall(dir, started, ended)).toMatch(/edge\.jsonl$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not stretch to something written long after', () => {
    const dir = dirWith([{ name: 'later.jsonl', mtime: t('2026-09-04T12:09:00Z') }]);
    try {
      expect(transcriptForCall(dir, started, ended),
        'a generous window turns "some other call" into "this call"').toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the directory the runner writes into', () => {
  const { transcriptDirFor } = require(MOD);

  it('is derived from the working directory, the way the runner derives it', () => {
    // ~/.claude/projects/<cwd with / and . replaced by ->
    const d = transcriptDirFor('/home/u/projects/ai/pipeline-tests-21', '/home/u');
    expect(d).toContain('projects');
    expect(d, 'the slug does not match the runner\'s own naming')
      .toMatch(/-home-u-projects-ai-pipeline-tests-21$/);
  });

  it('a path with dots is slugged the same way', () => {
    const d = transcriptDirFor('/home/u/codelines/next.gotransit.com', '/home/u');
    expect(d).toMatch(/-home-u-codelines-next-gotransit-com$/);
  });
});
