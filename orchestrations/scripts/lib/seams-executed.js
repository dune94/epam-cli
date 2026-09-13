#!/usr/bin/env node
/**
 * WHICH REGISTRY SEAMS A RUN EXECUTED — from the run's own records, resolved through the registry.
 *
 * Three records name the agents a run invoked, none of them by registry seam name alone: the cost
 * ledger (phase-cost.jsonl, agent_name — the writer appears under its minted ROLE), the activity
 * log (agent-activity.jsonl, agent — sub-agents such as the spec pass's two halves appear under
 * their own names) and Langfuse (trace names `<EPAM_AGENT_NAME> · <story>`). Every name is put
 * through resolveSeam — the same resolution every runner call uses — so a minted role resolves to
 * the seam it enters by, and nothing here maps a name by hand.
 *
 *   node seams-executed.js <install root> [run id]     → JSON { executed: [...], unresolved: [...] }
 *
 * Langfuse is read when LANGFUSE_BASE_URL and keys are in the environment; a run id narrows it to
 * that session. Absent, the two files alone are the record.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const root = process.argv[2];
const runId = process.argv[3] || '';
if (!root) { process.stderr.write('usage: seams-executed.js <install root> [run id]\n'); process.exit(2); }
const si = require(path.join(root, 'orchestrations/scripts/lib/seam-invocation.js'));
const registry = path.join(root, 'orchestrations/agents/invocation-profiles.json');
const logs = path.join(root, 'orchestrations/logs');

const names = new Set();
const bare = (v) => String(v || '').split(' · ')[0].split(':')[0].trim();
function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name === 'phase-cost.jsonl' || e.name === 'agent-activity.jsonl') out.push(p);
  }
  return out;
}
for (const f of walk(logs)) {
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    try { const j = JSON.parse(l); const n = j.agent_name || j.agent; if (n) names.add(bare(n)); } catch { /* not a record */ }
  }
}

function langfuse() {
  const base = process.env.LANGFUSE_BASE_URL, pk = process.env.LANGFUSE_PUBLIC_KEY, sk = process.env.LANGFUSE_SECRET_KEY;
  if (!base || !pk || !sk) return Promise.resolve([]);
  const auth = 'Basic ' + Buffer.from(`${pk}:${sk}`).toString('base64');
  const get = (u) => new Promise((resolve) => {
    const url = new URL(u, base); const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, { headers: { authorization: auth } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
  });
  return (async () => {
    const out = [];
    for (let page = 1; page <= 50; page += 1) {
      const q = `/api/public/traces?limit=100&page=${page}${runId ? `&sessionId=${encodeURIComponent(runId)}` : ''}`;
      const j = await get(q); const data = (j && j.data) || [];
      for (const t of data) if (t && t.name) out.push(bare(t.name));
      if (data.length < 100) break;
    }
    return out;
  })();
}

langfuse().then((fromLangfuse) => {
  for (const n of fromLangfuse) names.add(n);
  const executed = new Set(); const unresolved = [];
  for (const n of names) {
    if (!n) continue;
    let s = '';
    try { s = si.resolveSeam(n, registry) || ''; } catch { s = ''; }
    if (s) executed.add(s); else unresolved.push(n);
  }
  process.stdout.write(JSON.stringify({ executed: [...executed].sort(), unresolved: unresolved.sort() }) + '\n');
});
