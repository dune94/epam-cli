/**
 * THE OVERALL PLAN, as the detective writes it (detective-overall-plan) — from what its request hands it.
 *
 * The prompt lists the story's codelines (with where each is) and, as package facts read by the engine, who
 * provides which package at which version, its releases, and the range each consumer declares. A model reads
 * those and plans: the provider's own line, plus — for every consumer whose range does not take the provider's
 * version — the newest release that range does take, as the base of a line the change ships on as its next patch.
 * Every consumer receives a version its own range takes; no range moves. Nothing here names a project.
 *
 * A request that is given a plan (detective-overall-plan-given) is not asked for one, and gets none.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const semver = require('semver');

export function overallPlan(prompt: string): string {
  if (!/THE OVERALL PLAN\. This story is worked in the codelines below/.test(prompt)) return '';
  const block = prompt.slice(prompt.indexOf('THE OVERALL PLAN.'), prompt.indexOf('Establish, by reading the code'));
  const codelines = [...block.matchAll(/^- ([A-Za-z0-9_.-]+)(?: — [^\n]*)?$/gm)].map((m) => m[1]);
  const providers = [...prompt.matchAll(/^- (\S+) provides (\S+), version (\S+)\n(?:\s+its releases \(git tags, newest first\): ([^\n]+))?/gm)]
    .map((m) => ({ codeline: m[1], pkg: m[2], version: m[3], releases: (m[4] || '').split(',').map((t) => t.trim()).filter(Boolean) }));
  const declares = [...prompt.matchAll(/^- (\S+) declares (\S+) (\S+)$/gm)].map((m) => ({ codeline: m[1], pkg: m[2], range: m[3] }));
  const packages = providers.map((p) => {
    const ownLine = `${semver.major(semver.coerce(p.version))}.x`;
    const lines = new Map<string, { line: string; base: string; version: string; onCodelineBase: boolean }>();
    const newestOn = (major: number) => p.releases.find((t) => semver.valid(semver.coerce(t)) && semver.major(semver.coerce(t)) === major);
    const ownBase = newestOn(semver.major(semver.coerce(p.version))) || p.version;
    lines.set(ownLine, { line: ownLine, base: ownBase, version: semver.inc(semver.coerce(ownBase), 'patch'), onCodelineBase: true });
    const consumers = declares.filter((d) => d.pkg === p.pkg).map((d) => {
      let line = ownLine;
      if (!semver.satisfies(lines.get(ownLine)!.version, d.range)) {
        const base = p.releases.find((t) => semver.valid(semver.coerce(t)) && semver.satisfies(semver.coerce(t), d.range));
        if (base) {
          line = `${semver.major(semver.coerce(base))}.x`;
          if (!lines.has(line)) lines.set(line, { line, base, version: semver.inc(semver.coerce(base), 'patch'), onCodelineBase: false });
        }
      }
      return { codeline: d.codeline, declaredRange: d.range, receivesVia: lines.get(line)!.version, usage: [], change: 'none' };
    });
    return { package: p.pkg, providedBy: p.codeline, releaseLines: [...lines.values()], consumers };
  });
  const parts = codelines.map((cl, i) => ({
    codeline: cl,
    part: packages.some((p) => p.providedBy === cl) ? 'make the change, and ship it on each release line below' : 'none',
    order: packages.some((p) => p.providedBy === cl) ? 1 : 2 + i,
  }));
  return `<OVERALL_PLAN>\n${JSON.stringify({ codelines: parts, packages })}\n</OVERALL_PLAN>\n`;
}
