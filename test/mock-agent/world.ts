/**
 * WHAT A MODEL CAN SEE WHILE IT ANSWERS — the run's codelines on disk and the project's PRD.
 *
 * A model reads the prompt and, with its tools, the repositories. The agent's answers are drawn from
 * the same two places, so a name it gives is a name the run really has: a codeline is named the way
 * the pipeline names it (its directory), a story is one the PRD declares, a file is one on disk.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, relative } from 'node:path';

export type Codeline = { name: string; path: string };
export type Story = { id: string; title?: string; status?: string; description?: string; agentRole?: string; technicalNotes?: { files?: string[] }; acceptanceCriteria?: unknown[]; [k: string]: unknown };

export class World {
  constructor(readonly codelinePaths: () => string[], readonly prdPath: () => string, readonly projectDir = '') {}

  codelines(): Codeline[] { return this.codelinePaths().map((p) => ({ name: basename(p), path: p })); }

  /** The codelines this request is about: those whose name or path the prompt carries. */
  codelinesIn(prompt: string): Codeline[] {
    const all = this.codelines();
    const hit = all.filter((c) => prompt.includes(c.path) || new RegExp(`(^|[^\\w/-])${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w/-]|$)`).test(prompt));
    return hit.length ? hit : all;
  }

  prd(): { project?: Record<string, unknown>; stories: Story[] } {
    try { return JSON.parse(readFileSync(this.prdPath(), 'utf8')); } catch { return { stories: [] }; }
  }

  stories(): Story[] { return (this.prd().stories || []).filter((s) => s.status !== 'deprecated'); }

  story(id: string): Story | undefined { return this.stories().find((s) => s.id === id); }

  /** The project's name as the PRD declares it, as a kebab-case domain. */
  domain(): string {
    const p = this.prd().project || {};
    const n = String(p.name || p.id || p.title || basename(this.prdPath()).replace(/-prd.*$|\.json$/g, ''));
    return n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  }

  /** Files a codeline holds, repository-relative, excluding VCS and vendor trees. */
  files(c: Codeline, limit = 50): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      if (out.length >= limit || !existsSync(d)) return;
      for (const e of readdirSync(d)) {
        if (out.length >= limit) return;
        if (e === '.git' || e === 'node_modules' || e.startsWith('.venv')) continue;
        const p = join(d, e);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p); else out.push(relative(c.path, p));
      }
    };
    walk(c.path);
    return out;
  }

  /** Top-level directories of a codeline: its surfaces. */
  surfaces(c: Codeline): string[] {
    if (!existsSync(c.path)) return [];
    return readdirSync(c.path).filter((e) => !e.startsWith('.') && (() => { try { return statSync(join(c.path, e)).isDirectory(); } catch { return false; } })());
  }

  /** The agents the project's roster holds on disk, by name. */
  rosterAgents(): string[] {
    try { return Object.keys(JSON.parse(readFileSync(this.rosterFile(), 'utf8')).agents || {}); } catch { return []; }
  }

  /**
   * The project's roster file, where the installer's own declaration of a project's generated
   * artefacts (generated-run-state-paths.json) says it lives — not a name written here.
   */
  rosterFile(): string {
    const install = join(this.projectDir, '..', '..', '..');
    const declared = (JSON.parse(readFileSync(join(install, 'orchestrations-installer/generated-run-state-paths.json'), 'utf8')).paths as string[])
      .map((p) => p.match(/^orchestrations\/projects\/\*\/([^/*]*roster[^/*]*)$/)).find(Boolean);
    return declared ? join(this.projectDir, declared[1]) : '';
  }

  /** Names from a candidate list that the prompt offers as a list item ("- name"). */
  offered(prompt: string, candidates: string[]): string[] {
    return candidates.filter((n) => new RegExp(`^\\s*-\\s*${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(prompt));
  }

  /** The PRD stories a prompt names, in PRD order. */
  storiesIn(prompt: string): Story[] {
    return this.stories().filter((s) => new RegExp(`(^|[^\\w-])${s.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(prompt));
  }
}
