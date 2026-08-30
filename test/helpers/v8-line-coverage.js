/**
 * LINE COVERAGE OF A CHILD PROCESS, FROM THE COVERAGE V8 ITSELF WROTE.
 *
 * vitest's coverage sees only the test process. A RECEIVER test spawns the script under test, so
 * every line that matters executes somewhere vitest cannot look — which is precisely why a library
 * can sit fully "covered" while nothing calls it. NODE_V8_COVERAGE makes the child report its own
 * execution; this converts those byte ranges into covered lines.
 *
 * V8 reports ranges with an execution count. A range with count 0 is code that was compiled and not
 * run; ranges nest, so the innermost range wins. Lines with no range at all were never compiled —
 * counted as uncovered, because "never reached" is the thing being measured.
 */
const fs = require('fs');
const path = require('path');

/** Lines that can execute — blank lines and pure comments are not code. */
function codeLines(src) {
  const out = new Set();
  let inBlock = false;
  src.split('\n').forEach((raw, i) => {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; return; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return; }
    if (!t || t.startsWith('//') || t.startsWith('*')) return;
    out.add(i + 1);
  });
  return out;
}

/** offset -> line, 1-based. */
function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0; let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

/**
 * coverageFor(covDir, files) -> { [file]: {covered, total, pct, uncovered:[lines]} }
 * `files` are absolute paths; everything else in the coverage output is ignored.
 */
function coverageFor(covDir, files) {
  const wanted = new Map(files.map((f) => [path.resolve(f), fs.readFileSync(f, 'utf8')]));
  const hits = new Map([...wanted.keys()].map((f) => [f, new Map()]));

  for (const name of fs.readdirSync(covDir)) {
    if (!name.endsWith('.json')) continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(covDir, name), 'utf8')); } catch { continue; }
    for (const script of doc.result || []) {
      if (!script.url || !script.url.startsWith('file:')) continue;
      const file = path.resolve(new URL(script.url).pathname);
      if (!wanted.has(file)) continue;
      const src = wanted.get(file);
      const toLine = lineIndex(src);
      const seen = hits.get(file);
      // Outermost first, so a nested count-0 range overwrites the enclosing count.
      const ranges = (script.functions || []).flatMap((fn) => fn.ranges || [])
        .sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
      // Within ONE script, ranges nest and the innermost wins, so a later (smaller) range
      // overwrites. ACROSS processes it is the opposite: a run that never loaded the module
      // reports count 0 for every line, and letting that overwrite an earlier hit erases real
      // execution. So each process is folded on its own, then merged by taking the maximum.
      const thisScript = new Map();
      for (const r of ranges) {
        const from = toLine(r.startOffset);
        const to = toLine(Math.max(r.startOffset, r.endOffset - 1));
        for (let ln = from; ln <= to; ln += 1) thisScript.set(ln, r.count);
      }
      for (const [ln, count] of thisScript) {
        seen.set(ln, Math.max(seen.get(ln) || 0, count));
      }
    }
  }

  const report = {};
  for (const [file, src] of wanted) {
    const lines = codeLines(src);
    const seen = hits.get(file);
    const uncovered = [...lines].filter((ln) => !(seen.get(ln) > 0)).sort((a, b) => a - b);
    const total = lines.size;
    const covered = total - uncovered.length;
    report[file] = { covered, total, pct: total ? (covered / total) * 100 : 100, uncovered };
  }
  return report;
}

module.exports = { coverageFor, codeLines };
