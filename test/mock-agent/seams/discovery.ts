/**
 * codeline-selection — which repositories of the estate a ticket's work belongs to.
 *
 * As a diligent model with search tools would: take what the ticket names in code form (a symbol
 * called with parentheses, a file path, a quoted literal), look for it in each repository the
 * manifest lists, and select the repositories where it is found — quoting what was found as the
 * evidence. A ticket that names nothing found anywhere is answered "unsure", never guessed.
 * Nothing about any project, repository or stack is known here; all of it is read from the prompt
 * and the disk.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import type { World } from '../world';

const between = (text: string, from: RegExp, to: RegExp) => {
  const a = text.search(from); if (a < 0) return '';
  const rest = text.slice(a); const b = rest.slice(1).search(to);
  return b < 0 ? rest : rest.slice(0, b + 1);
};

/**
 * The quoted literals a text holds: '...' where the opening quote does not follow a letter and the
 * closing one does not precede one — an apostrophe in prose ("the project's build") is not a quote.
 */
export function quotedLiterals(text: string): string[] {
  return [...new Set([...text.matchAll(/(?<![A-Za-z0-9])'([^'\n]{2,80})'(?![A-Za-z0-9])/g)].map((m) => m[1]))];
}

/** What a ticket names in code form: symbols called with (), file paths, quoted literals. */
export function codeTerms(ticket: string): string[] {
  const out = new Set<string>();
  for (const m of ticket.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,})\(\)/g)) out.add(m[1]);
  for (const m of ticket.matchAll(/(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6})\b/g)) if (!/^https?:/.test(m[1]) && !m[1].includes('//')) out.add(m[1]);
  for (const l of quotedLiterals(ticket)) if (l.length >= 3 && l.length <= 60) out.add(l);
  return [...out];
}

/** The first file under `root` containing `term` (or the path itself, for a path term). */
function find(root: string, term: string, budget = { files: 4000 }): string | null {
  if (term.includes('/') && existsSync(join(root, term))) return term;
  const walk = (dir: string): string | null => {
    let entries: string[] = []; try { entries = readdirSync(dir); } catch { return null; }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules') continue;   // tool state and vendored code are not the repository's source
      const p = join(dir, e); let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { const r = walk(p); if (r) return r; continue; }
      if (st.size > 512_000 || (budget.files -= 1) < 0) continue;
      try { const t = readFileSync(p, 'utf8'); if (!t.includes('\u0000') && t.includes(term)) return relative(root, p); } catch { /* unreadable */ }
    }
    return null;
  };
  return walk(root);
}

/** The identifier rule the prompt states: the directory name, lowercase alphanumerics, every word kept. */
const identifier = (dir: string) => dir.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);

/**
 * A manifest path is where the discovery agent's tools look: absolute, or relative to the estate root
 * the agent works in — the run's own codelines, by directory name, as the world knows them.
 */
const onDisk = (r: { dir: string; path: string }, world?: World) =>
  isAbsolute(r.path) ? r.path : (world?.codelines().find((c) => c.name === r.dir || c.name === r.path)?.path || r.path);

export function codelineSelection(prompt: string, world?: World): string {
  const tickets = between(prompt, /JIRA TICKETS:/, /REPOSITORY MANIFEST/);
  const repos = [...between(prompt, /REPOSITORY MANIFEST/, /\n\n[A-Z]/).matchAll(/-\s*dir:\s*(\S+)\s*\n\s*path:\s*(\S+)/g)].map((m) => ({ dir: m[1], path: m[2] })).map((r) => ({ ...r, path: onDisk(r, world) }));
  const terms = codeTerms(tickets);
  const codelines = repos.flatMap((r) => {
    for (const t of terms) {
      const hit = existsSync(r.path) ? find(r.path, t) : null;
      if (hit) return [{ name: identifier(r.dir), path: r.path, reason: `the ticket's "${t}" is implemented in this repository`, evidence: hit === t ? `file ${hit}` : `${hit} contains "${t}"`, facts: [] }];
    }
    return [];
  });
  const title = (/title:\s*(.+)/.exec(tickets) || [, 'the ticket'])[1];
  return JSON.stringify({ codelines, unsure: codelines.length ? [] : [{ part: title, why: `none of ${terms.join(', ') || 'the ticket\'s terms'} was found in any listed repository` }] }, null, 2);
}
