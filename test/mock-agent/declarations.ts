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

export type Template = { id: string; seams: string[]; segments: string[]; text: string };
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
      const segs = (xs: string[]) => xs.flatMap((x) => x.split(PLACEHOLDER)).flatMap((s) => s.split('\n'))
        .map((s) => s.trim()).filter((s) => s.length >= 24);
      const seams = [...new Set([...(Array.isArray(t.seams) ? t.seams : []), ...(seamOfTemplate[id] || [])])];
      const segments = segs(texts);
      if (segments.length) out.push({ id, seams, segments, text: texts.join('\n') });
      // A MULTI-SECTION TEMPLATE (`bodies`) renders ONE section per call, so each section is its own
      // candidate — whole-template coverage would never reach the threshold. Without this the
      // agent-failure-analyst and spec-story-block prompts were unrecognisable, and the template a
      // prompt QUOTED (the failed agent's own prompt) was taken for the caller (£0 brownfield, 2026-09-30).
      if (t.bodies && typeof t.bodies === 'object') {
        for (const v of Object.values<unknown>(t.bodies)) {
          if (typeof v !== 'string') continue;
          const sg = segs([v]);
          if (sg.length) out.push({ id, seams, segments: sg, text: v });
        }
      }
    }
    return out;
  }

  /**
   * Which template a request was rendered from. A request may EMBED another template (a builder
   * shown the template it specialises), so among the templates the request carries, the one whose
   * fixed text encloses the others — the widest span — is the one that called.
   */
  identify(text: string, modes: string[] = []): { template: Template; score: number; coverage: number } | null {
    const found: { template: Template; score: number; coverage: number; span: number; lo: number }[] = [];
    for (const t of this.templates) {
      let score = 0; let hits = 0; let lo = Infinity; let hi = -1;
      for (const s of t.segments) {
        const at = text.indexOf(s);
        if (at < 0) continue;
        score += s.length; hits += 1; lo = Math.min(lo, at); hi = Math.max(hi, at + s.length);
      }
      const coverage = hits / t.segments.length;
      if (hits && coverage >= 0.3) found.push({ template: t, score, coverage, span: hi - lo, lo });
    }
    // Fully present beats partly present (templates share rule blocks); among templates equally
    // present, the one that STARTS FIRST is the caller: what a prompt quotes — a template a builder
    // specialises, the failed prompt an analyst diagnoses — comes after the caller's own opening.
    // Widest span decided this before, and an analyst quoting a long failed prompt was taken for the
    // agent it was diagnosing (£0 brownfield, 2026-09-30).
    // A SEAM'S OWN TEMPLATE (the registry names it as the seam's template) beats a FRAGMENT several
    // prompts include — a shared evidence block may open a gate's prompt and would otherwise start first.
    const owns = (t: Template) => Object.values(this.registry).some((p) => p && p.template === t.id) ? 1 : 0;
    // THE SEAM MOST OF THE PROMPT SPEAKS FOR, among fragments fully present: a prompt composed of several fragments (the
    // detective's prescription, its plan block, its shared block) also carries a small fragment another seam declares
    // (the story-kind hint), which starts earlier — and the detective was answered as the story writer (2026-10-06).
    // Every template of the seam the prompt carries votes, not only the fully present ones: the guard-vocabulary prompt
    // carries its own template in part, a guard-vocabulary fragment and a shared spec-authoring fragment in full — the
    // shared fragment started first and the call was answered as ac-elaboration (rehearsal 2026-10-08).
    const votes = (t: Template) => found.filter((f) => f.template.seams.some((s) => t.seams.includes(s))).length;
    found.sort((a, b) => (Math.round(b.coverage * 20) - Math.round(a.coverage * 20)) || (owns(b.template) - owns(a.template)) || (votes(b.template) - votes(a.template)) || (a.lo - b.lo) || (b.span - a.span) || (b.score - a.score));
    // A FRAGMENT embedded in another seam's prompt can span as widely as its host; a template whose
    // seam does not apply to this project's modes cannot be the caller, so the next candidate is.
    const pick = found.find((f) => this.applies(this.seamOf(f.template, modes), modes)) || found[0];
    return pick ? { template: pick.template, score: pick.score, coverage: pick.coverage } : null;
  }

  contractOf(seam: string): Contract | undefined { return this.contracts[seam]; }

  templateText(id: string): string { return this.templates.find((t) => t.id === id)?.text || ''; }

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
