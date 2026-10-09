/**
 * THE MOCK DISCOVERS THE CODELINE A PROSE TICKET NAMES.
 *
 * Fresh rehearsal of AMSD-2974, 2026-10-09: the ticket is prose — "[GO/UP/MX] Toast Notification (Pop-Up)
 * Accessibility Enhancement" — with no symbol(), no path and no quoted literal. The mock searched only those code-form
 * terms, found nothing, answered "unsure" three times and the run died at ingest. Every live run's model found the
 * toast component the title names. A diligent model with search tools reads what the title names; so does the mock:
 * code-form terms first, then the title's capitalised words joined as one identifier, then each alone. Generic — no
 * project, repository or stack is known here.
 *
 * EXECUTED: the engine's own prompt (lib/codeline-discovery.js buildDiscoveryPrompt) answered by the mock's seam.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codelineSelection } from './seams/discovery';

const ROOT = join(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildDiscoveryPrompt } = require(join(ROOT, 'orchestrations/scripts/lib/codeline-discovery.js'));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function estate(files: Record<string, Record<string, string>>) {
  const d = mkdtempSync(join(tmpdir(), 'mock-disc-')); dirs.push(d);
  for (const [repo, fs] of Object.entries(files)) for (const [p, t] of Object.entries(fs)) {
    mkdirSync(join(d, repo, p, '..'), { recursive: true }); writeFileSync(join(d, repo, p), t);
  }
  return { root: d, manifest: Object.keys(files).map((name) => ({ name, path: join(d, name) })) };
}
const ask = (title: string, description: string, e: ReturnType<typeof estate>) =>
  JSON.parse(codelineSelection(buildDiscoveryPrompt([{ jiraKey: 'T-1', title, description }], e.manifest)));

const PROSE = { title: '[GO/UP] Toast Notification (Pop-Up) Accessibility Enhancement', description: 'Screen readers do not announce the pop-up messages. Make them accessible.' };

describe('a prose ticket', () => {
  it('selects the repositories holding what the title names, with the evidence', () => {
    const e = estate({
      shared: { 'src/ToastNotification/ToastNotification.tsx': 'export const ToastNotification = () => null;\n' },
      site: { 'src/pages/home.tsx': "import { ToastNotification } from 'shared';\n" },
      unrelated: { 'src/fares.ts': 'export const fare = 1;\n' },
    });
    const r = ask(PROSE.title, PROSE.description, e);
    expect(r.codelines.map((c: { name: string }) => c.name).sort()).toEqual(['shared', 'site']);
    expect(r.codelines[0].evidence).toMatch(/ToastNotification/);
    expect(r.unsure).toEqual([]);
  });

  it('a title naming nothing any repository holds is still "unsure", never guessed', () => {
    const e = estate({ unrelated: { 'src/fares.ts': 'export const fare = 1;\n' } });
    const r = ask(PROSE.title, PROSE.description, e);
    expect(r.codelines).toEqual([]);
    expect(r.unsure).toHaveLength(1);
  });
});

describe('code-form terms still come first', () => {
  it('a symbol() the ticket names selects only where it is, even when the title words are everywhere', () => {
    const e = estate({
      a: { 'x.ts': 'function getGreeting() {} // Toast Notification\n' },
      b: { 'y.ts': '// Toast Notification lives here too\n' },
    });
    const r = ask('Toast Notification greeting is wrong', 'getGreeting() returns the wrong text', e);
    expect(r.codelines.map((c: { name: string }) => c.name)).toEqual(['a']);
  });
});
