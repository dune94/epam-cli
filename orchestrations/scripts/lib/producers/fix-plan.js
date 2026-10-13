/**
 * THE CODE-GRAPH-DETECTIVE RENDERS ITS OWN ANSWER.
 *
 * KIND: fix-plan.  PRODUCER: code-graph-detective (see invocation-profiles.json).
 *
 * Before this file, the detective's answer became prompt text in two places, and the two had
 * drifted in opposite directions:
 *
 *   claude.sh:2045           deliveryRole, runsIn, the UNVERIFIED and UNGROUNDED warnings, and
 *                            the "nothing here produces the value" alarm
 *   team-lead-review.sh:410  the changeRequired:false marker — which claude.sh never rendered
 *
 * So the writer was never told which sites were deliberately left alone, and the reviewer was
 * never told that a prescribed helper does not exist. Each copy held a fact the other had lost.
 * Nobody decided that; it is simply what two copies do — proven again on 2026-08-13, when
 * deliveryRole was added to one renderer and the other never got it, within the hour.
 *
 * WHAT BELONGS HERE, AND WHAT DOES NOT
 *
 * Here: what the detective FOUND, in the detective's own terms, including how sure it is. It is
 * the only actor that knows what its fields mean.
 *
 * Not here: what a reader should DO about it. "This is the plan of record, apply it" and "this is
 * what the implementer was working from, judge the diff against it" are the same facts under two
 * authorities, and the authority belongs to the consumer that declared the input. Bake one in and
 * this module can only ever serve one consumer, which is where it came from.
 */
'use strict';

const agentIo = require('../agent-io.js');

/** The kind this producer publishes, and who it is published as. Declared once, read from here. */
const KIND = 'fix-plan';
const PRODUCER = 'code-graph-detective';

/** false only when the producer actually SAID false. Absent is unknown, and unknown is not a defect. */
function provenFalse(v) {
  return v === false;
}

function renderSite(s) {
  const file = s && s.file ? String(s.file) : '';
  const fn = s && s.function ? String(s.function) : '';
  const reason = s && s.reason != null ? String(s.reason) : '';

  let line = `- **${file}**`;
  if (fn !== '') line += ` (\`${fn}\`)`;

  // A site the detective deliberately left alone. Without it a reader assumes an untouched file
  // is an omission — the reviewer used to be the only one told, and it is the reviewer that would
  // otherwise raise a finding about work that was correctly not done.
  if (provenFalse(s.changeRequired)) {
    line += '  [NO EDIT REQUIRED — part of the fix, correctly left unchanged]';
  }

  line += `: ${reason}`;

  if (s.deliveryRole === 'produces') {
    line += '  <== **THIS CHANGE PRODUCES THE VALUE** — it is what makes the new or corrected data'
      + ' exist. Without it, every other change here only moves a value that never changed.';
  } else if (s.deliveryRole === 'carries') {
    line += '  (carries the value — moves or re-exposes what something else produced)';
  } else if (s.deliveryRole === 'verifies') {
    line += '  (verify only — no edit expected here)';
  }

  const runsIn = s.runsIn == null ? '' : String(s.runsIn);
  if (runsIn !== '' && runsIn !== 'n/a') line += ` [runs: ${runsIn}]`;

  if (s.shared && typeof s.shared === 'object') line += `\n  - **Shared:** ${sharedFact(s.shared)}`;

  const fix = s.fix == null ? '' : String(s.fix);
  if (fix !== '') {
    line += `\n  - **Minimal fix:** ${fix}`;

    // The helper named in the fix was not found in the repository. Live 2026-07-26 an answer of
    // this shape sent a writer looking for a function that had never existed.
    if (provenFalse(s.fixVerified)) {
      line += ` ⚠️ UNVERIFIED: the helper named here (\`${s.helper || '?'}\`) was NOT found in the`
        + ' repo — treat it as a HYPOTHESIS, not fact. Confirm it exists with the CodeGraph tool'
        + ' before importing it; if it does not exist, do not invent it — solve the fix another'
        + ' minimal way.';
    }

    // The quoted broken code is not in the file, so the diagnosis is about code that does not
    // exist. Live 2026-07-26 exactly this prescribed halving a discount that is never applied,
    // because the real defect was a key mismatch elsewhere.
    if (provenFalse(s.evidenceVerified)) {
      line += ` ⛔ UNGROUNDED DIAGNOSIS: the detective quoted \`${s.brokenLine || '?'}\` as the`
        + ' broken code, but that expression is NOT in this file. The root cause below is'
        + ' therefore a GUESS about code that does not exist — live 2026-07-26 an answer of'
        + ' exactly this shape prescribed halving a discount that is in fact never applied at'
        + ' all, because the real defect was a key mismatch elsewhere. Do NOT implement it as'
        + ' written: re-derive the cause from the actual file contents first, and if the'
        + ' prescribed change has no basis in the code you read, fix what IS broken instead.';
    }
  }

  return line;
}

/** The detective's "shared" answer in its own terms: what, who provides it, and who receives it. */
function sharedFact(sh) {
  const consumers = (Array.isArray(sh.consumers) ? sh.consumers : []).map((c) => {
    const range = c.declaredRange ? ` declares ${c.declaredRange}` : '';
    const gets = c.receivesChange === true ? 'receives this change'
      : c.receivesChange === false ? 'does NOT receive this change through that range'
        : 'not known whether it receives this change';
    return `${c.codeline}${range} — ${gets}`;
  });
  let out = `package \`${sh.package}\``;
  if (sh.providedBy) out += `, provided by ${sh.providedBy}`;
  if (sh.shipsInVersion) out += `, the change ships in version ${sh.shipsInVersion}`;
  if (consumers.length) out += `; consumers: ${consumers.join('; ')}`;
  if (sh.note) out += `. ${sh.note}`;
  return out;
}

/**
 * THE STORY'S OVERALL PLAN, as every agent of every codeline reads it — one rendering, so the detective of a
 * later codeline, the spec agent, the writer and both reviewers are told the same plan (2026-10-06). The
 * codeline being worked is marked, so each sees its own part within the whole.
 */
function overallPlanText(plan, here) {
  if (!plan || !Array.isArray(plan.codelines) || !plan.codelines.length) return '';
  const lines = ['THE OVERALL PLAN for this story — written once, for every codeline it is worked in:'];
  const ordered = [...plan.codelines].sort((a, b) => (a.order == null ? 1e9 : a.order) - (b.order == null ? 1e9 : b.order));
  for (const c of ordered) {
    lines.push(`- ${c.order != null ? `${c.order}. ` : ''}${c.codeline}${c.codeline === here ? ' (THIS CODELINE)' : ''}: ${c.part}`);
  }
  for (const p of (Array.isArray(plan.packages) ? plan.packages : [])) {
    lines.push(`Package \`${p.package}\`${p.providedBy ? `, provided by ${p.providedBy}` : ''}.`);
    // THE LINE THIS PASS WORKS ON (lib/release-lines.sh sets it), so a line's agents know which branch they are on.
    const _thisLine = process.env.EPAM_RELEASE_LINE || '';
    for (const l of p.releaseLines || []) lines.push(`  release line ${l.line}: cut from ${l.base}, ships as ${l.version}${_thisLine && l.line === _thisLine ? ' (THIS RELEASE LINE — the one this pass works on)' : ''}${l.carries ? `; carries: ${l.carries}` : ''}`);
    for (const c of p.consumers || []) {
      lines.push(`  consumer ${c.codeline}${c.codeline === here ? ' (THIS CODELINE)' : ''}: declares ${c.declaredRange}, receives ${c.receivesVia}; its own change: ${c.change || 'none'}`);
      for (const u of c.usage || []) lines.push(`    uses: ${u}`);
    }
  }
  // WHO SETS THE VERSION (live run 3, 2026-10-07: told "ships as 8.12.0", the writer bumped package.json, and the lock
  // file in a later attempt). The codeline's own release practice decides — read from its history, never assumed.
  if ((Array.isArray(plan.packages) ? plan.packages : []).some((p) => (p.releaseLines || []).length)) {
    lines.push('The version a release line ships as is set the way this codeline makes its releases — its history shows how; this story\'s change is the fix.');
  }
  return lines.join('\n');
}

/**
 * @param {Array|null|undefined} sites  the detective's fixSiteAnalysis, verbatim
 * @returns {string} markdown, or '' when there is nothing to say
 */
function renderFixPlan(sites) {
  const list = Array.isArray(sites) ? sites.filter((s) => s && typeof s === 'object') : [];
  if (list.length === 0) return '';

  let out = list.map(renderSite).join('\n');

  // A plan in which every site only carries or verifies obtains nothing. Implementing it exactly
  // yields code that runs, changes nothing anyone can see, and passes every check — which is how
  // a story reaches its retry ceiling with a green diff. Only raised when the detective assigned
  // roles at all: an older answer that was never asked the question is not accused of dodging it.
  const roled = list.filter((s) => s.deliveryRole != null);
  const producers = list.filter((s) => s.deliveryRole === 'produces');
  if (producers.length === 0 && roled.length > 0) {
    out += '\n\n⚠️ NONE OF THESE PRODUCE THE VALUE. Every site above only carries or verifies it —'
      + ' they move, expose or re-render something that already exists. If this story needs a'
      + ' value that does not exist yet, NO prescribed change obtains it, and implementing this'
      + ' plan exactly will produce code that runs, changes nothing a user can see, and passes'
      + ' every check. Find what must read, fetch, query or compute the new value, change that'
      + ' too, and say so in your final message.';
  }

  return out;
}

/**
 * The sites that belong to THIS story's codeline.
 *
 * Three codelines run as parallel lanes and each has its own answer. The canonical PRD's flat list
 * is the UNION of all of them — on AMSD-2041, 13 sites where gotransit has 4, including three
 * different prescriptions for one file naming five different env vars, two of them mutually
 * exclusive designs. A writer handed three conflicting instructions for the same file picks one,
 * and nothing makes it pick its own lane's.
 *
 * run-agent-orchestration.sh already scopes each lane's PRD this way; doing it here as well means
 * publication is correct from EITHER PRD, rather than depending on which one a caller passes.
 *
 * An explicitly EMPTY entry is honoured: "this lane found nothing" is a real state and differs
 * from "this lane has not run". A codeline ABSENT from the map falls back to the flat list —
 * never to nothing, which would hand a writer an empty plan.
 */
function sitesFor(story) {
  const per = story && story.fixSiteAnalysisPerCodeline;
  const lane = story && story.codeline;
  if (lane && per && Object.prototype.hasOwnProperty.call(per, lane)) return per[lane];
  return story && story.fixSiteAnalysis;
}

/**
 * A STORY'S PLAN: its own sites, and — when the detective reported a site SHARED between this
 * story's codelines, in this lane or another — what is shared and where each sibling codeline's
 * working copy is, RELATIVE to this codeline (detective-shared-package / fix-plan-shared). A story
 * with nothing shared renders exactly renderFixPlan(sites).
 */
function renderStoryPlan(story, prd, sites) {
  const own = sites === undefined ? sitesFor(story) : sites;
  return renderFixPlan(own) + renderShared('fix-plan-shared', story, prd, own);
}

/**
 * The shared section alone, under the template a consumer declares: what the detective reported as
 * shared (this lane and its siblings) and where each sibling's working copy is, RELATIVE to this
 * codeline. '' when nothing is shared. One gathering for the writer (fix-plan-shared) and the diff
 * reviewers (review-shared), so the two can never be told different facts.
 */
function renderShared(templateId, story, prd, sites) {
  const own = sites === undefined ? sitesFor(story) : sites;
  const here = story && story.codeline;
  const lanes = (story && Array.isArray(story.codelines)) ? story.codelines.filter(Boolean) : [];
  const per = (story && story.fixSiteAnalysisPerCodeline) || {};
  const shared = [];
  for (const s of (Array.isArray(own) ? own : [])) {
    if (s && s.shared && typeof s.shared === 'object') shared.push(`- ${here || 'this codeline'}: ${s.file} — ${sharedFact(s.shared)}`);
  }
  for (const cl of lanes.filter((c) => c !== here)) {
    for (const s of (Array.isArray(per[cl]) ? per[cl] : [])) {
      if (s && s.shared && typeof s.shared === 'object') shared.push(`- ${cl}: ${s.file} — ${sharedFact(s.shared)}`);
    }
  }
  // THE STORY'S PLAN COMES FIRST, when there is one: it is what this codeline is worked from.
  const plan = story && story.overallPlan ? overallPlanText(story.overallPlan, here) : '';
  const port = releaseLinePort();
  if (shared.length === 0 && !plan) return port;

  const dirs = (prd && prd.project && Array.isArray(prd.project.outputDirs)) ? prd.project.outputDirs : [];
  const dirOf = (cl) => (dirs.find((d) => d && d.codeline === cl) || {}).path;
  const hereDir = dirOf(here) || (prd && prd.project && prd.project.outputDir);
  const path = require('path');
  const locations = lanes.filter((c) => c !== here).map((cl) => {
    const there = dirOf(cl);
    return there && hereDir ? `- ${cl}: ${path.relative(hereDir, there)}` : `- ${cl}: not recorded in this run's PRD`;
  });
  // eslint-disable-next-line global-require
  const { renderEngineTemplate } = require('../engine-prompt.js');
  return renderEngineTemplate(templateId, {
    __SHARED_SITES__: [plan, ...shared].filter(Boolean).join('\n'),
    __SIBLING_LOCATIONS__: locations.join('\n') || '- none recorded',
  }) + port;
}

/**
 * ON A RELEASE LINE, THE CHANGE IT PORTS: what the codeline's own line committed for this story, verbatim
 * (lib/release-lines.sh writes it and names it in EPAM_MAIN_LINE_CHANGE). Part of renderShared, so the line's writer
 * and its diff reviewers are given the same change to port and to compare against (AMSD-2974 run 9: both were given
 * only the plan's summary, and a back-port carrying a fraction of the change was approved). '' off a release line,
 * or when the own line committed nothing. A named change that cannot be read is an error, never an empty section.
 */
function releaseLinePort(env = process.env) {
  const file = env.EPAM_MAIN_LINE_CHANGE || '';
  const line = env.EPAM_RELEASE_LINE || '';
  if (!file || !line) return '';
  const change = require('fs').readFileSync(file, 'utf8');
  if (!change.trim()) return '';
  // eslint-disable-next-line global-require
  const { renderEngineTemplate } = require('../engine-prompt.js');
  return renderEngineTemplate('release-line-port', {
    __RELEASE_LINE__: line,
    __MAIN_LINE__: env.EPAM_MAIN_LINE_BRANCH || 'its own line',
    __MAIN_LINE_CHANGE__: change.replace(/\n$/, ''),
  });
}

/**
 * Publish every story's plan, so consumers stop reading the detective's fields.
 *
 * A story with no sites publishes NOTHING, which clears any plan published earlier. That is the
 * point rather than an optimisation: the detective re-runs, and a re-run that withdraws its
 * findings must retract the plan too. Live 2026-08-13 a re-run degraded every site on three
 * codelines and reported success — had the previous plan survived that, every consumer would have
 * gone on acting on a plan the detective had taken back.
 *
 * @returns {number} how many stories now have a published plan
 */
function publishFixPlans(prd, env) {
  const stories = (prd && Array.isArray(prd.stories)) ? prd.stories : [];
  let published = 0;
  for (const story of stories) {
    if (!story || !story.id) continue;
    const text = renderStoryPlan(story, prd);
    agentIo.publish(PRODUCER, KIND, story.id, text, env);
    if (text !== '') published += 1;
  }
  return published;
}

module.exports = {
  overallPlanText, renderFixPlan, renderStoryPlan, renderShared, releaseLinePort, publishFixPlans, sharedFact, KIND, PRODUCER };

// CLI: node fix-plan.js <prd.json> <story-id>   — emits the rendered plan on stdout.
// The shell consumers call it this way; it is the same function either way, never a second copy.
if (require.main === module) {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === '--review-shared') {
      // node fix-plan.js --review-shared <prd.json> <story-id> — the reviewers' shared section, or nothing.
      const prd = JSON.parse(require('fs').readFileSync(argv[1], 'utf8'));
      const story = (prd.stories || []).find((s) => s && s.id === argv[2]);
      process.stdout.write(story ? renderShared('review-shared', story, prd) : '');
    } else if (argv[0] === '--publish') {
      // The orchestrator calls this after any step that can change the plan.
      const prd = JSON.parse(require('fs').readFileSync(argv[1], 'utf8'));
      const n = publishFixPlans(prd);
      process.stderr.write(`[fix-plan] published for ${n} story(ies)\n`);
    } else {
      const [prdPath, storyId] = argv;
      const prd = JSON.parse(require('fs').readFileSync(prdPath, 'utf8'));
      const story = (prd.stories || []).find((s) => s && s.id === storyId);
      process.stdout.write(story ? renderStoryPlan(story, prd, story.fixSiteAnalysis) : '');
    }
  } catch (e) {
    // A rendering that cannot be produced must not look like a detective that found nothing:
    // the caller sees a non-zero status and says so, rather than silently prompting without it.
    process.stderr.write(`[fix-plan] ${(e && e.message) || e}\n`);
    process.exit(1);
  }
}
