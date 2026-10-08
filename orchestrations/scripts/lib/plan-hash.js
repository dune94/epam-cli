'use strict';
/**
 * planHash(plan) — the story's plan, identified: md5 of its JSON with keys sorted at every level; '' when there is
 * none. What a spec was built under (story.specification.planHash) is compared with the plan the story has now.
 */
const crypto = require('crypto');

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function planHash(plan) {
  if (!plan || typeof plan !== 'object') return '';
  return crypto.createHash('md5').update(stable(plan)).digest('hex');
}

module.exports = { planHash };
