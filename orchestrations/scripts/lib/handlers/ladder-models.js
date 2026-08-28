#!/usr/bin/env node
/**
 * THE MODELS THIS RUN'S LADDER DECLARES, AS A JSON ARRAY, OPENING MODEL FIRST.
 *
 * One reader for a question asked in several places: what may a story legitimately be assigned?
 * The answer is the project's own resolved ladder — never a list kept in engine code, so a project
 * that declares other models needs no change here.
 */
try {
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const { resolveLlmSettings } = require('../llm-settings-resolve.js');
  const st = resolveLlmSettings() || {};
  const order = Array.isArray(st.ladderTierOrder) ? st.ladderTierOrder : Object.keys(st.ladders || {});
  const out = [];
  const seen = new Set();
  const add = (m) => { if (m && !seen.has(m)) { seen.add(m); out.push(m); } };
  for (const tier of order) {
    const t = (st.ladders || {})[tier];
    if (!t) continue;
    add(t.startModel);
    for (const hop of (t.modelLadder || [])) { add(hop && hop.from); add(hop && hop.to); }
  }
  process.stdout.write(JSON.stringify(out));
} catch {
  process.stdout.write('');
}
