// THE CPA PRE-PASS DIED ON exit 126 BECAUSE A jq ARGUMENT EXCEEDED MAX_ARG_STRLEN.
//
// Live metrolinx AMSD-2041, 2026-08-18:
//   contextualize-stories.sh: line 756: jq: Argument list too long
//   [WARNING] Step 2: CPA script exited with code 126 (non-critical — continuing)
//
// 126 is bash reporting that exec() itself failed, not that jq ran and disagreed. The story fell
// back to the formula baseline and the LLM iteration estimate was never produced.
//
// The limit is NOT ARG_MAX (2MB on this host). Linux caps any SINGLE argument at MAX_ARG_STRLEN =
// 32 * PAGE_SIZE = 128KB. inference_input passed story, kbChunks, codebaseSignals, manifest and
// systemPrompt as individual --argjson/--arg values; with 33 fetched ticket documents the kbChunks
// value alone cleared 128KB, so no amount of total headroom could have saved it. mock3 never hit
// this because its payloads are tiny — it needs a real client ticket with linked documentation.
//
// The fix is the one already used elsewhere for this exact defect: pass large values through FILES
// (--slurpfile for JSON, --rawfile for text), never through argv.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Comfortably past MAX_ARG_STRLEN (128KB) — the same shape the live payload had.
function bigJson(): string {
  return JSON.stringify({ chunks: Array.from({ length: 400 }, (_, i) => ({ id: i, text: 'x'.repeat(1200) })) });
}

describe('a large jq payload survives the exec boundary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpa-jq-'));
  const payload = bigJson();

  it('the payload is genuinely past the single-argument limit, or this test proves nothing', () => {
    expect(payload.length).toBeGreaterThan(128 * 1024);
  });

  it('THE DEFECT: passing it on argv fails to exec — this is the live 126', () => {
    const r = spawnSync('jq', ['-n', '--argjson', 'kb', payload, '$kb.chunks | length'], { encoding: 'utf8' });
    const failed = r.status !== 0 || /Argument list too long|E2BIG/i.test(String(r.error?.message || r.stderr || ''));
    expect(failed, 'argv form unexpectedly succeeded; MAX_ARG_STRLEN assumption is wrong here').toBe(true);
  });

  it('THE FIX: --slurpfile carries the same payload through a file', () => {
    const f = join(dir, 'kb.json');
    writeFileSync(f, payload);
    const r = spawnSync('jq', ['-n', '--slurpfile', 'kb', f, '$kb[0].chunks | length'], { encoding: 'utf8' });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout.trim()).toBe('400');
  });

  it('THE FIX: --rawfile carries a large TEXT value (the systemPrompt case)', () => {
    const f = join(dir, 'prompt.txt');
    const text = 'y'.repeat(200 * 1024);
    writeFileSync(f, text);
    const r = spawnSync('jq', ['-n', '--rawfile', 'p', f, '$p | length'], { encoding: 'utf8' });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(Number(r.stdout.trim())).toBe(text.length);
  });

  it('the composed object keeps every field, so the fix is not a behaviour change', () => {
    const kb = join(dir, 'kb2.json'); writeFileSync(kb, payload);
    const sp = join(dir, 'sp.txt');   writeFileSync(sp, 'SYSTEM');
    const r = spawnSync('jq', ['-n',
      '--slurpfile', 'kb', kb,
      '--rawfile', 'systemPrompt', sp,
      '--argjson', 'story', '{"id":"S-1"}',
      '{story: $story, kbChunks: $kb[0], systemPrompt: $systemPrompt} | [.story.id, (.kbChunks.chunks|length), .systemPrompt] | @csv',
    ], { encoding: 'utf8' });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout.trim()).toBe('"\\"S-1\\",400,\\"SYSTEM\\""');
  });

  it('cleanup', () => { rmSync(dir, { recursive: true, force: true }); expect(true).toBe(true); });
});
