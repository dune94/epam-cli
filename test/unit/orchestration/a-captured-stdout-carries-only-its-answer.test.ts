/**
 * WHEN A FUNCTION'S STDOUT IS CAPTURED, ITS STDOUT IS A CONTRACT.
 *
 * `X="$(f)"` makes everything f prints part of X. A diagnostic printed there does not go to a log:
 * it goes into the value, and then wherever that value goes.
 *
 * resolve_primary_provider did exactly that on 2026-08-30. Its own comment said "STDERR DIRECTLY";
 * the >&2 was never written. The notice joined the return value, travelled into the captured reply
 * of every agent, and metrolinx died on:
 *
 *     ROSTER_REVIEW[1]: expected an object, got object
 *
 * because the reviewer's JSON was followed by two [provider] lines. Three specialiser attempts,
 * all corrupted identically. The mint's earlier failure on the same ticket is the same class.
 *
 * 208 shell functions in this tree have their stdout captured somewhere. Writing a test per
 * function would leave the next one uncovered; this asserts the property over all of them, so a
 * function added tomorrow is guarded without anyone remembering.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPTS = path.join(__dirname, '../../../orchestrations/scripts');

function shellFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...shellFiles(p));
    else if (e.name.endsWith('.sh')) out.push(p);
  }
  return out;
}

type Fn = { name: string; file: string; line: number; body: string[] };

function functionsIn(file: string): Fn[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const fns: Fn[] = [];
  lines.forEach((l, i) => {
    const m = /^([a-z_][a-z0-9_]*)\(\)\s*\{/.exec(l);
    if (!m) return;
    let end = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trimEnd() === '}') { end = j; break; }
    }
    fns.push({ name: m[1], file, line: i + 1, body: lines.slice(i, end + 1) });
  });
  return fns;
}

const files = shellFiles(SCRIPTS);
const allText = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const everyFn = files.flatMap(functionsIn);
// Captured means its stdout is somebody's value. That is what makes stdout a contract.
const captured = everyFn.filter((f) => allText.includes(`$(${f.name}`));

describe('a captured stdout carries only its answer', () => {
  it('there are captured-stdout functions to check — otherwise this proves nothing', () => {
    expect(captured.length).toBeGreaterThan(50);
  });

  it('no captured-stdout function prints a bracketed diagnostic to stdout', () => {
    const offenders: string[] = [];
    for (const fn of captured) {
      fn.body.forEach((raw, i) => {
        const l = raw.trim();
        if (!/^(printf|echo)\b/.test(l)) return;
        if (l.includes('>&2')) return;                 // correctly routed
        if (!/\[[a-z][a-z-]*\]/.test(l)) return;       // not a diagnostic
        // A here-doc or a line building JSON is not a diagnostic; a bracketed tag plus prose is.
        offenders.push(`${path.relative(SCRIPTS, fn.file)}:${fn.line + i}  ${fn.name}()  ${l.slice(0, 80)}`);
      });
    }
    expect(offenders, `these print a diagnostic into a captured return value:\n${offenders.join('\n')}`)
      .toEqual([]);
  });
});
