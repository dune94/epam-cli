/**
 * agent-activity.html — self-healing badge cross-referenced against
 * healing-events.jsonl, not just a fixed error-message phrase list.
 *
 * Root cause this fixes (found live, 2026-07-15): isSelfHealingError()'s
 * SELF_HEALING_PATTERNS only recognized 4 hardcoded phrases (built for a
 * different failure class — speckit/openspec agent errors). SKY-003-test's
 * real tsc-verify/FailureAnalyst error cards ("widespread syntax
 * corruption", "garbled code generation") matched none of them and
 * rendered as plain red "ERROR", even though healing-events.jsonl recorded
 * 4 genuine target=skill healing responses for that exact story across its
 * attempts — the dashboard's aggregate summary (build-info.json's
 * selfHealing.healing block) already counted this correctly; only this
 * page's per-event badge missed it. Fixed by cross-referencing each
 * error's story_id against healing-events.jsonl directly: any entry with a
 * 'target' key (a real healing response — skill/tool/kb/none — as opposed
 * to a bare HEALING_BROKEN detection marker, which has no 'target' key)
 * for that story marks every one of its error cards as self-healing,
 * regardless of message wording.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const DASHBOARD_HTML = join(__dirname, '../../../orchestrations/dashboards/agent-activity.html');
const html = readFileSync(DASHBOARD_HTML, 'utf8');

function extractScript(): string {
  const start = html.indexOf('<script>\n');
  const end = html.indexOf('</script>', start);
  if (start === -1 || end === -1) throw new Error('Could not find inline <script> block');
  return html.slice(start + '<script>'.length, end);
}

const scriptSrc = extractScript();

// Runs the real dashboard script in a sandboxed VM with a stubbed `fetch`
// and DOM (just enough for the script's top-level statements not to throw —
// the functions under test, fetchSelfHealStoryIds/isSelfHealingError, don't
// touch the DOM at all). Returns the sandbox's exposed globals so tests can
// call the real functions directly, not a reimplementation.
function loadSandbox(jsonlByPath: Record<string, string>) {
  const sandbox: any = {
    console,
    Date,
    Math,
    Set,
    Map,
    Promise,
    JSON,
    fetch: async (url: string) => {
      const path = url.split('?')[0];
      const text = jsonlByPath[path];
      if (text === undefined) return { ok: false };
      return { ok: true, text: async () => text };
    },
    document: {
      getElementById: () => ({
        addEventListener: () => {},
        textContent: '',
        innerHTML: '',
        value: '',
      }),
    },
    setInterval: () => {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // Strip the two calls the module makes at top level that we don't want to
  // execute during load (initial refresh() + setInterval) — everything else
  // (function/const declarations) is pure top-level declarations, safe to
  // run as-is. Cut the script off right after the isSelfHealingError
  // function definition plus the pieces we need (fetchJsonl/parseJsonl,
  // fetchSelfHealStoryIds) — before refresh()/setInterval calls at the
  // bottom, which reference DOM elements this stub doesn't fully implement.
  const cutoffMarker = '    function isSelfHealingError(evt) {';
  const cutoffIdx = scriptSrc.indexOf(cutoffMarker);
  const nextFnIdx = scriptSrc.indexOf('\n    function ', cutoffIdx + cutoffMarker.length);
  const runnable = scriptSrc.slice(0, nextFnIdx === -1 ? undefined : nextFnIdx);
  vm.runInContext(runnable, sandbox);
  return sandbox;
}

// `let`/`const` declared at a vm context's top level (via runInContext) live
// in that context's persistent global lexical environment — visible across
// multiple runInContext calls in the SAME context, but NOT settable via a
// plain property assignment on the sandbox object (unlike `var`). Must
// mutate through another runInContext call, not `sandbox.selfHealStoryIds =`.
function setSelfHealStoryIds(sandbox: vm.Context, ids: string[]) {
  vm.runInContext(`selfHealStoryIds = new Set(${JSON.stringify(ids)});`, sandbox);
}

describe('agent-activity.html — fetchSelfHealStoryIds (REAL execution)', () => {
  it('REPRODUCES the exact live shape: collects story_id from target-bearing entries, excludes bare HEALING_BROKEN markers', async () => {
    const healingJsonl = [
      JSON.stringify({ ts: '2026-07-15T03:01:55Z', story_id: 'SKY-003-test', retry: 1, target: 'none', diagnosis: 'x' }),
      JSON.stringify({ ts: '2026-07-15T03:02:58Z', story_id: 'SKY-003-test', event: 'HEALING_BROKEN', repeated_diagnosis: 'x', count: 2 }),
      JSON.stringify({ ts: '2026-07-15T03:18:55Z', story_id: 'SKY-003-test', retry: 4, target: 'skill', diagnosis: 'widespread syntax corruption', profile_updated: true }),
      JSON.stringify({ ts: '2026-07-15T03:00:00Z', story_id: 'SKY-002-b', retry: 0, target: 'kb', diagnosis: 'y' }),
    ].join('\n');
    const sandbox = loadSandbox({ 'logs/healing-events.jsonl': healingJsonl });
    const ids: Set<string> = await sandbox.fetchSelfHealStoryIds();
    expect(ids.has('SKY-003-test')).toBe(true);
    expect(ids.has('SKY-002-b')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('returns an empty set when healing-events.jsonl does not exist (404)', async () => {
    const sandbox = loadSandbox({});
    const ids: Set<string> = await sandbox.fetchSelfHealStoryIds();
    expect(ids.size).toBe(0);
  });

  it('a story with ONLY a HEALING_BROKEN marker (no real healing response) is not included', async () => {
    const healingJsonl = JSON.stringify({ ts: '2026-07-15T03:00:00Z', story_id: 'SKY-NEVER-HEALED', event: 'HEALING_BROKEN', repeated_diagnosis: 'z', count: 8 });
    const sandbox = loadSandbox({ 'logs/healing-events.jsonl': healingJsonl });
    const ids: Set<string> = await sandbox.fetchSelfHealStoryIds();
    expect(ids.has('SKY-NEVER-HEALED')).toBe(false);
  });
});

describe('agent-activity.html — isSelfHealingError (REAL execution)', () => {
  it('REPRODUCES the exact live defect and proves the fix: "widespread syntax corruption" (matches none of the fixed phrases) is recognized as self-healing via story_id cross-reference', () => {
    const sandbox = loadSandbox({});
    setSelfHealStoryIds(sandbox, ['SKY-003-test']);
    const evt = { type: 'error', agent: 'test-engineer', story_id: 'SKY-003-test', detail: { message: 'Widespread syntax corruption in cli.test.ts — 30+ errors across the file' } };
    expect(sandbox.isSelfHealingError(evt)).toBe(true);
  });

  it('an error for a story with NO healing-events entry is NOT self-healing (real error, not silently downgraded)', () => {
    const sandbox = loadSandbox({});
    setSelfHealStoryIds(sandbox, ['SKY-003-test']);
    const evt = { type: 'error', agent: 'test-engineer', story_id: 'SKY-999-never-healed', detail: { message: 'Some genuinely fatal, unrecovered error' } };
    expect(sandbox.isSelfHealingError(evt)).toBe(false);
  });

  it('still recognizes the original 4 fixed phrases (no regression)', () => {
    const sandbox = loadSandbox({});
    setSelfHealStoryIds(sandbox, []);
    for (const msg of ['no parsable output', 'MANDATE violation detected', 'forced retry triggered', 'prompt runner timed out after 120000ms']) {
      expect(sandbox.isSelfHealingError({ type: 'error', agent: 'x', story_id: '', detail: { message: msg } })).toBe(true);
    }
  });

  it('still recognizes speckit/openspec agent errors regardless of message (no regression)', () => {
    const sandbox = loadSandbox({});
    setSelfHealStoryIds(sandbox, []);
    expect(sandbox.isSelfHealingError({ type: 'error', agent: 'speckit', story_id: '', detail: { message: 'anything' } })).toBe(true);
    expect(sandbox.isSelfHealingError({ type: 'error', agent: 'openspec', story_id: '', detail: { message: 'anything' } })).toBe(true);
  });

  it('non-error event types are never flagged as self-healing', () => {
    const sandbox = loadSandbox({});
    setSelfHealStoryIds(sandbox, ['SKY-003-test']);
    expect(sandbox.isSelfHealingError({ type: 'info', agent: 'x', story_id: 'SKY-003-test', detail: { message: 'anything' } })).toBe(false);
  });

  it('an event with no story_id and no matching pattern/agent is not self-healing', () => {
    const sandbox = loadSandbox({});
    setSelfHealStoryIds(sandbox, ['SKY-003-test']);
    expect(sandbox.isSelfHealingError({ type: 'error', agent: 'x', story_id: '', detail: { message: 'a real unrelated error' } })).toBe(false);
  });
});

describe('agent-activity.html — refresh() wiring (static)', () => {
  it('refresh() fetches self-heal story IDs alongside events and assigns selfHealStoryIds before applying filters', () => {
    const idx = scriptSrc.indexOf('async function refresh() {');
    const end = scriptSrc.indexOf('\n    }', idx);
    const block = scriptSrc.slice(idx, end);
    expect(block).toMatch(/fetchSelfHealStoryIds\(\)/);
    expect(block).toMatch(/selfHealStoryIds = healIds/);
    const assignIdx = block.indexOf('selfHealStoryIds = healIds');
    const applyIdx = block.indexOf('applyFilters()');
    expect(applyIdx).toBeGreaterThan(assignIdx);
  });
});
