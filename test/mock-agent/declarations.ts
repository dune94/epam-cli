/**
 * WHAT THE ENGINE DECLARES, READ AS DATA — NEVER ITS CODE.
 *
 * The mock agent moves with the pipeline because everything it knows about a seam is read, at the
 * moment of the call, from the engine's own declarations: the seam registry, the prompt templates,
 * the seam output contracts. Change a template and the seam is still recognised; change a contract
 * and the answer follows. Nothing here imports, lifts or slices pipeline code.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type Template = { id: string; seams: string[]; segments: string[] };
export type Contract = {
  kind: 'schema' | 'verdict' | 'declared' | 'artefact' | 'per-story-map' | 'none';
  requiredKeys?: string[]; knownKeys?: string[]; shapes?: unknown; tag?: string; [k: string]: unknown;
};

const PLACEHOLDER = /__[A-Z][A-Z0-9_]*__/g;

export class Declarations {
  readonly templates: Template[];
  readonly contracts: Record<string, Contract>;
  readonly registry: Record<string, { template?: string; produces?: string; toolGrant?: string; appliesTo?: string[] }>;

  constructor(readonly orchestrationsDir: string) {
    const reg = JSON.parse(readFileSync(join(orchestrationsDir, 'agents/invocation-profiles.json'), 'utf8'));
    this.registry = reg.profiles || {};
    this.contracts = JSON.parse(readFileSync(join(orchestrationsDir, 'config/seam-output-contracts.json'), 'utf8')).seams || {};
    this.templates = this.loadTemplates();
  }

  private loadTemplates(): Template[] {
    const dir = join(this.orchestrationsDir, 'prompts/templates');
    const seamOfTemplate: Record<string, string[]> = {};
    for (const [seam, p] of Object.entries(this.registry)) {
      if (p && p.template) (seamOfTemplate[p.template] ||= []).push(seam);
    }
    const out: Template[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      let t: any;
      try { t = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
      const id = t.id || f.replace(/\.json$/, '');
      // Every prose part of the template: a single `body`, or the named parts of a multi-part one.
      const texts: string[] = typeof t.body === 'string' ? [t.body]
        : Object.entries(t).filter(([k, v]) => typeof v === 'string' && !k.startsWith('$') && !k.startsWith('_')
          && !['id', 'description', 'layer', 'extractedFrom', 'version'].includes(k)).map(([, v]) => v as string);
      const segments = texts.flatMap((x) => x.split(PLACEHOLDER)).flatMap((s) => s.split('\n'))
        .map((s) => s.trim()).filter((s) => s.length >= 24);
      const seams = [...new Set([...(Array.isArray(t.seams) ? t.seams : []), ...(seamOfTemplate[id] || [])])];
      if (segments.length) out.push({ id, seams, segments });
    }
    return out;
  }

  /**
   * Which template a request was rendered from. A request may EMBED another template (a builder
   * shown the template it specialises), so among the templates the request carries, the one whose
   * fixed text encloses the others — the widest span — is the one that called.
   */
  identify(text: string, modes: string[] = []): { template: Template; score: number; coverage: number } | null {
    const found: { template: Template; score: number; coverage: number; span: number }[] = [];
    for (const t of this.templates) {
      let score = 0; let hits = 0; let lo = Infinity; let hi = -1;
      for (const s of t.segments) {
        const at = text.indexOf(s);
        if (at < 0) continue;
        score += s.length; hits += 1; lo = Math.min(lo, at); hi = Math.max(hi, at + s.length);
      }
      const coverage = hits / t.segments.length;
      if (hits && coverage >= 0.3) found.push({ template: t, score, coverage, span: hi - lo });
    }
    // Fully present beats partly present (templates share rule blocks); among templates equally
    // present, the one enclosing the others is the caller.
    found.sort((a, b) => (Math.round(b.coverage * 20) - Math.round(a.coverage * 20)) || (b.span - a.span) || (b.score - a.score));
    // A FRAGMENT embedded in another seam's prompt can span as widely as its host; a template whose
    // seam does not apply to this project's modes cannot be the caller, so the next candidate is.
    const pick = found.find((f) => this.applies(this.seamOf(f.template, modes), modes)) || found[0];
    return pick ? { template: pick.template, score: pick.score, coverage: pick.coverage } : null;
  }

  contractOf(seam: string): Contract | undefined { return this.contracts[seam]; }

  /**
   * The seam a template speaks for. A template several seams declare is the seam whose registry
   * entry names it; else the first that applies to this project's modes (registry `appliesTo`).
   */
  applies(seam: string, modes: string[]): boolean {
    const a = this.registry[seam]?.appliesTo;
    return !modes.length || !a || a.some((m) => modes.includes(m));
  }

  seamOf(t: Template, modes: string[]): string {
    const owner = t.seams.find((s) => this.registry[s]?.template === t.id);
    if (owner) return owner;
    const applies = t.seams.find((s) => { const a = this.registry[s]?.appliesTo; return !a || a.some((m) => modes.includes(m)); });
    return applies || t.seams[0] || `template:${t.id}`;
  }
}

export function orchestrationsDirOf(installOrRepo: string): string {
  const d = join(installOrRepo, 'orchestrations');
  if (!existsSync(join(d, 'agents/invocation-profiles.json'))) throw new Error(`no engine declarations under ${d}`);
  return d;
}
