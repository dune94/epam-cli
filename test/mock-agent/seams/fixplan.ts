/**
 * fix-plan — where the ticket's change lands in the codeline, and the minimal change there.
 *
 * As the investigating model does, from what its request hands it: the repository, the files and
 * symbols the pre-computed `explore` surfaced, and the ticket. It opens those files and looks for the
 * ticket's own quoted literals: one that IS in a file marks the line to change (a defect's broken
 * line), one that is NOT is the value the ticket asks for. Every file and symbol named came from the
 * request's tool output — none is invented, as the prompt demands. A request that surfaced nothing is
 * answered [], which is what the prompt says an honest investigation returns.
 *
 * The extraction template (a second pass over an investigation's prose) is answered with the array
 * that investigation contains, or [].
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { codeTerms, quotedLiterals } from './discovery';

type Site = Record<string, unknown>;

export function fixPlan(prompt: string): string {
  const inv = prompt.indexOf('=== INVESTIGATION ===');
  if (inv >= 0) {
    const m = /\[\s*\{[\s\S]*\}\s*\]/.exec(prompt.slice(inv));
    try { return JSON.stringify(m ? JSON.parse(m[0]) : []); } catch { return '[]'; }
  }
  const repo = (/The repository is at:\s*([^\s\\]+)/.exec(prompt) || [])[1] || '';
  const ticket = prompt.slice(Math.max(0, prompt.indexOf('Title:')), prompt.indexOf('Your CodeGraph tool') > 0 ? prompt.indexOf('Your CodeGraph tool') : undefined);
  const title = ((/Title:\s*(.+?)(?:Description:|\n)/.exec(ticket) || [])[1] || 'the ticket').trim();
  const literals = quotedLiterals(ticket);
  const surfaced = [...prompt.matchAll(/\*\*`([^`]+)`\*\*\s*—\s*([A-Za-z_][\w$]*)\(/g)].map((m) => ({ file: m[1], fn: m[2] }));
  const novel = /brokenLine` is NOT required[^\n]*must be left ""/.test(prompt);
  const sites: Site[] = [];
  for (const s of surfaced) {
    const path = join(repo, s.file);
    const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
    const old = literals.find((l) => lines.some((x) => x.includes(l)));
    const want = literals.find((l) => l !== old && !lines.some((x) => x.includes(l)));
    const line = old ? lines.find((x) => x.includes(old))!.trim() : '';
    if (!old && sites.length) continue;
    sites.push({
      file: s.file, function: s.fn,
      reason: old ? `${s.fn} returns the value the ticket says is wrong ("${old}")` : `${s.fn} is where the ticket's change attaches (${codeTerms(ticket).join(', ')})`,
      brokenLine: novel ? '' : line,
      fix: old && want ? `In ${s.fn} (${s.file}), change "${old}" to "${want}": ${line}` : `In ${s.fn} (${s.file}), make the change the ticket asks for: ${title}`,
      helper: '', changeRequired: true, requiredPackages: [], deliveryRole: 'produces', runsIn: 'n/a',
    });
    if (old) break;
  }
  return JSON.stringify(sites);
}
