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
    const text = renderFixPlan(sitesFor(story));
    agentIo.publish(PRODUCER, KIND, story.id, text, env);
    if (text !== '') published += 1;
  }
  return published;
}

module.exports = { renderFixPlan, publishFixPlans, KIND, PRODUCER };

// CLI: node fix-plan.js <prd.json> <story-id>   — emits the rendered plan on stdout.
// The shell consumers call it this way; it is the same function either way, never a second copy.
if (require.main === module) {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === '--publish') {
      // The orchestrator calls this after any step that can change the plan.
      const prd = JSON.parse(require('fs').readFileSync(argv[1], 'utf8'));
      const n = publishFixPlans(prd);
      process.stderr.write(`[fix-plan] published for ${n} story(ies)\n`);
    } else {
      const [prdPath, storyId] = argv;
      const prd = JSON.parse(require('fs').readFileSync(prdPath, 'utf8'));
      const story = (prd.stories || []).find((s) => s && s.id === storyId);
      process.stdout.write(renderFixPlan(story && story.fixSiteAnalysis));
    }
  } catch (e) {
    // A rendering that cannot be produced must not look like a detective that found nothing:
    // the caller sees a non-zero status and says so, rather than silently prompting without it.
    process.stderr.write(`[fix-plan] ${(e && e.message) || e}\n`);
    process.exit(1);
  }
}
