/**
 * WHAT THE PROMPT GENERATOR IS ALLOWED TO KNOW ABOUT A CODELINE.
 *
 * project-prompt-generation.json tells the generator: "Do not name a file, symbol, package or
 * command that does not appear in the context you were given." The context it was given was a
 * config path, ticket titles, and a codeline name with its dependency list. No files, no symbols,
 * no structure — so the only compliant output was one naming nothing, and the model resolved the
 * contradiction the other way. Live 2026-09-01, metrolinx AMSD-1919: the generated team-lead-review
 * prompt asserted "Form components are typically in the `src/components/Checkout/` directory". No
 * such directory. prompt-review grepped it, rejected three attempts, and the mint died.
 *
 * The facts already existed. codeline-facts.json carries verified statements WITH the source that
 * establishes each, claude.sh injects it into the writer at invocation, and the estate survey
 * reports the surfaces it actually found by looking. The generator was the one consumer receiving
 * none of it.
 *
 * TWO GUARANTEES:
 *
 *   1. EVERY PATH THIS EMITS EXISTS. A context that can carry an unverified path is worse than one
 *      that carries none: the generator inherits the fabrication and it arrives looking
 *      authoritative. Surfaces are checked against the codeline on disk before they are named.
 *
 *   2. WHEN THERE IS NOTHING, IT SAYS SO. A generator told "no verified structure is known" can
 *      comply by naming nothing. One told nothing at all has to guess, which is what happened.
 *
 * This does NOT make prompts project-specific by baking facts into them permanently — it supplies
 * the generator the same verified material the writer already receives at invocation, so that what
 * it does write can be true.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Verified facts for one codeline, from the file the pipeline writes. */
function factsFor(name, factsFile) {
  if (!factsFile) return [];
  let doc;
  try { doc = JSON.parse(fs.readFileSync(factsFile, 'utf8')); } catch { return []; }
  const entry = doc && doc[name];
  const facts = entry && Array.isArray(entry.facts) ? entry.facts : [];
  return facts
    .map((f) => ({
      text: String((f && f.text) || f || '').trim(),
      source: String((f && f.source) || '').trim(),
    }))
    .filter((f) => f.text);
}

/**
 * Surfaces the survey reported, keeping only those that exist under the codeline root.
 *
 * The survey looks, so its surfaces are normally real — but "normally" is how an invented path
 * reaches a prompt wearing a verified badge. Checked here, once, against disk.
 */
function verifiedSurfaces(codelineRoot, surfaces) {
  if (!codelineRoot || !Array.isArray(surfaces)) return [];
  return surfaces
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .filter((s) => {
      try { return fs.existsSync(path.join(codelineRoot, s)); } catch { return false; }
    });
}

/**
 * buildCodelineContext({ codelines, factsFile, surveyed }) -> string
 *
 * codelines  [{ name, path, dependencies }]
 * factsFile  path to codeline-facts.json, or null
 * surveyed   [{ codeline, surfaces }] from the estate survey
 */
function buildCodelineContext({ codelines, factsFile, surveyed } = {}) {
  const rows = Array.isArray(codelines) ? codelines : [];
  const surveyFor = (name) => {
    const hit = (Array.isArray(surveyed) ? surveyed : []).find((s) => s && s.codeline === name);
    return hit ? hit.surfaces : [];
  };

  const blocks = rows.map((c) => {
    const name = (c && c.name) || String(c);
    const root = (c && c.path) || '';
    const deps = (c && Array.isArray(c.dependencies)) ? c.dependencies : [];
    const lines = [`- ${name} (${root})${deps.length ? ` deps: ${deps.join(', ')}` : ''}`];

    const surfaces = verifiedSurfaces(root, surveyFor(name));
    if (surfaces.length) {
      lines.push('  Surfaces the survey found in this codeline (verified to exist):');
      surfaces.forEach((s) => lines.push(`    - ${s}`));
    }

    const facts = factsFor(name, factsFile);
    if (facts.length) {
      lines.push('  Established facts about this codeline, each with the source that proves it:');
      facts.forEach((f) => lines.push(`    - ${f.text}${f.source ? `  [source: ${f.source}]` : ''}`));
    }

    if (!surfaces.length && !facts.length) {
      // The sentence that stops the guessing. Saying nothing here is what produced
      // "Form components are typically in src/components/Checkout/".
      lines.push('  No verified structure or facts are known for this codeline. Name no file, '
        + 'directory or symbol within it — there is nothing here to name one from.');
    }
    return lines.join('\n');
  });

  return blocks.join('\n');
}

module.exports = { buildCodelineContext, verifiedSurfaces, factsFor };
