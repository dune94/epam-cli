/**
 * roster-seams.js — the two seams that derive a project's roster, as ONE piece of code.
 *
 * `produce` asks the roster specialiser for its delta and lands it where lib/project-roster.js
 * composes it; `review` asks project-roster-review to falsify the composed roster. They were
 * closures inside mint-agents-step.js; the seam harness (tools/seam-harness.js) needs to run
 * exactly them on a recorded run's inputs, so they live here and the step calls them. Nothing
 * about either seam changed in the move — the text below is the step's, verbatim.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * rosterSeams(ctx) -> { produce, review }
 * ctx: { spec, promptExec, projectConfigDir, LOG_DIR, AGENTS_DIR, REPO_PATH, codelines, stories,
 *        mintedDetail, survey, toolGrant }
 */
/**
 * THE CODELINES, WITH WHAT THE TICKETS DECLARE FOR THEM. On a brownfield tree the specialiser
 * reads the code; on a greenfield one there is no code, and the only source of a path is the
 * tickets' own declaration (technicalNotes.files and the paths their text names). Run
 * 20260916T234139Z: handed ticket TITLES only, the specialiser wrote src/client.ts for a client the
 * PRD declares at src/skyscanner/client.ts; the reviewer found the contradiction on every attempt.
 * The declared paths are DATA the tickets already carry (lib/agent-roster.js declaredPathsOf, the
 * same derivation the mint's brief check uses) — both seams receive them in the same line.
 */
function codelineContext(codelines, stories) {
  const declared = require('./agent-roster.js').declaredPathsOf(stories);
  const suffix = declared.length ? ` — paths the tickets declare: ${declared.join(', ')}` : '';
  return (Array.isArray(codelines) ? codelines : [])
    .map((c) => `- ${c.name} (${c.path})${c.dependencies && c.dependencies.length ? ` deps: ${c.dependencies.join(', ')}` : ''}${suffix}`)
    .join('\n');
}

function rosterSeams({ spec, promptExec, projectConfigDir, LOG_DIR, AGENTS_DIR, REPO_PATH, codelines, stories, prd, mintedDetail, survey, toolGrant }) {
  const { seamInvocationEnv } = require('./seam-invocation.js');
  // eslint-disable-next-line global-require
  const { renderEngineTemplate } = require('./engine-prompt.js');
  const { refusalBlock } = require('./refusal-block.js');
  const renderSpecialisation = (vals) => renderEngineTemplate('roster-specialisation', vals);

  // PRD configuration block — same derivation as spec-mode-runner.js prdConfigurationBlock.
  // Strip $-prefixed comment keys; render empty string when the PRD declares no configuration.
  const prdConfigurationBlock = (() => {
    if (!prd || !prd.configuration) return '';
    const cfg = Object.fromEntries(
      Object.entries(prd.configuration).filter(([k]) => !k.startsWith('$')),
    );
    if (!Object.keys(cfg).length) return '';
    return renderEngineTemplate('prd-configuration-block', {
      __PRD_CONFIGURATION_JSON__: JSON.stringify(cfg, null, 2),
    });
  })();

// THE AGENT WRITES THE FILE. The pipeline hands it the canonical copy and a destination,
// then judges the artefact — it does not compose personas itself, because deciding what an
// agent must know about a codeline is judgement, not substitution.
const produce = async ({ canonicalCopyPath, outPath, refusal, attempt }) => {
  process.env.EPAM_AGENT_NAME = 'roster-specialiser';
  // The SAME context the prompt builder is given, computed the same way — a derivation that
  // sees different facts than its sibling stage is two projects, not one.
  const prompt = renderSpecialisation({
    // THE VOCABULARY THE ANSWER IS JUDGED AGAINST. Read from the registry rather than written
    // out here: a hand-kept second copy of a closed list only ever drifts from the list.
    __DECLARED_SEAMS__: (() => {
      try {
        const _reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'invocation-profiles.json'), 'utf8'));
        return Object.keys(_reg.profiles || {}).sort().map((s) => `- ${s}`).join('\n');
      } catch { return ''; }
    })(),
    // THE PERSONAS THEMSELVES, NOT WHERE THEY LIE. Pointed at a folder under the install's logs,
    // the agent was handed a local path (operator, 2026-10-01: relative paths only) that a CodeMie
    // web plugin, rooted at the codelines, cannot even reach. The run's own copy, every entry.
    __CANONICAL_PERSONAS__: (() => {
      const c = JSON.parse(fs.readFileSync(canonicalCopyPath, 'utf8'));
      return Object.keys(c).filter((n) => typeof c[n] === 'string' && c[n].trim())
        .map((n) => `--- AGENT: ${n}\n${c[n].trim()}`).join('\n\n');
    })(),
    __PROJECT_CONTEXT__: [
      `Project: ${path.basename(String(projectConfigDir || ''))}`,
      `Tickets in scope: ${stories.map((t) => `${t.jiraKey || t.id}: ${t.title || ''}`).join(' | ')}`,
      mintedDetail.length
        ? `Agents this project minted: ${mintedDetail.map((mm) => `${mm.name} [${mm.kind}]`).join(', ')}`
        : 'Agents this project minted: (none this run)',
    ].join('\n'),
    // WHAT THE SURVEY OBSERVED, not merely what the PRD declares. Everything else handed to
    // this seam — paths, dependency lists, ticket titles — is a claim about the code rather
    // than an observation of it, and the specialiser writes the project-facts paragraph that
    // every persona inherits. Handed over WITH its caveat; see surveyLeadsBlock.
    __SURVEY_LEADS__: spec.surveyLeadsBlock(survey),
    __CODELINE_CONTEXT__: codelineContext(codelines, stories),
    __PRD_CONFIGURATION_BLOCK__: prdConfigurationBlock,
    // __STACK__ is deliberately ABSENT. It is a stack-fact key, and engine-prompt.js injects
    // the ones a template declares — but only when the caller has not supplied them. Passing
    // an empty string here would win, and starve the agent of the codeline's real facts.
    // RENDERED FROM THE PROMPT LAYER, not written here. See lib/refusal-block.js: this text
    // existed at three call sites in three wordings, none of them reviewable as a prompt.
    __PREVIOUS_REFUSAL__: refusalBlock(refusal, 'roster'),
  });
  // spec.runClaude, like every other seam in this file. promptExec is the RUNNER handed to
  // it, not something to call — invoking it directly threw "promptExec is not a function".
  // I invented a call shape instead of matching the one already here, which is the third bug
  // in this stage from that same habit.
  //
  // AGENTS_DIR, not LOG_DIR: seamInvocationEnv reads the invocation registry from the
  // directory it is given, and handed the log folder it found none and resolved no ladder.
  const seamEnv = {
    // ATTEMPT N RUNS RUNG N-1. buildProjectRoster has always handed `attempt` to this producer
    // and it was destructured away, so all three attempts re-ran the same model: the refusal
    // was fed back to the one model that had just produced it. Fifth site of that same shape.
    ...seamInvocationEnv('roster-specialiser', AGENTS_DIR,
      { rung: Math.max(0, (Number(attempt) || 1) - 1) }),
    EPAM_AGENT_NAME: 'roster-specialiser',
  };
  // The tool CHANNEL and the tool LIST travel together: granting one without the other gives
  // an agent that quietly has nothing, and this one's whole job is to read the codeline and
  // write a file.
  if (seamEnv.EPAM_ALLOWED_TOOLS) seamEnv.AI_GATE_ALLOW_TOOLS = '1';
  const ask = (text, log) => spec.runClaude(promptExec, text, path.join(LOG_DIR, log), seamEnv, { costAgent: 'roster-specialiser' });
  // THE ROSTER IN TURNS ON A SET THAT CUTS LONG ANSWERS. A runner that declares `limits` returns at
  // most one turn's worth of text and reports the cut answer as a success — live 2026-10-01 (AMSD-2974,
  // codemie-web) the whole delta in one answer was cut three times and the mint refused the run. So one
  // turn names the agents and one turn per agent writes its entry; the engine merges them. A set with
  // no declared budget is asked once, as before.
  const budget = require('./project-prompt-builder.js').answerBudgetChars();
  let reply;
  if (Number.isFinite(budget)) {
    const { extractDeltaJson } = require('./project-roster.js');
    const namesReply = String(await ask(prompt + renderEngineTemplate('roster-specialisation-plan', {}), 'roster-specialiser.log') || '');
    let names = [];
    try {
      const m = namesReply.match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : null;
      names = Array.isArray(parsed && parsed.agents) ? parsed.agents.filter((n) => typeof n === 'string' && n.trim()) : [];
    } catch { names = []; }
    const agents = {};
    for (const name of names) {
      const part = String(await ask(prompt + renderEngineTemplate('roster-specialisation-one',
        { __AGENT__: name, __BUDGET_CHARS__: String(budget) }), `roster-specialiser-${name}.log`) || '');
      const d = extractDeltaJson(part);
      if (d && d.agents && d.agents[name]) agents[name] = d.agents[name];
    }
    // WHOLE OR NOTHING: an agent the specialiser named but whose entry did not parse leaves no roster,
    // so the attempt is refused and retried — never a roster quietly missing an agent it chose.
    reply = names.length && Object.keys(agents).length === names.length ? JSON.stringify({ agents }) : '';
  } else {
    reply = await ask(prompt, 'roster-specialiser.log');
  }
  // THE ENGINE PERFORMS THE WRITE. The delta is the seam's ANSWER — the same delivery the
  // prompt-builder seam uses — so the agent needs no write tool, and a rehearsal that answers
  // from a recording or a contract stand-in delivers exactly what a live model does. Delivered
  // by tool call, the seam was unrehearsable (a stand-in cannot write a file) and, live, three
  // paid attempts on 2026-09-13 ended with "the agent wrote no roster". A file the agent wrote
  // itself (the Claude Code arm may) is still accepted; the answer is written only when it did
  // not. lib/project-roster.js composes the roster from whatever lands at outPath.
  if (!fs.existsSync(outPath)) {
    const { extractDeltaJson } = require('./project-roster.js');
    const delta = extractDeltaJson(String(reply || ''));
    if (delta) fs.writeFileSync(outPath, JSON.stringify(delta, null, 2));
  }
};

// REVIEWED AGAINST BOTH. With only the roster a reviewer can judge plausibility; falsifying
// "is this ancestor close" and "was inherited structure quietly changed" needs the source.
const review = async ({ rosterPath, canonicalPath: copyPath }) => {
  // The SEAM's own name. This announced 'roster-review' — a different seam, with a different
  // template and a different job (certifying newly minted agents). The two would have
  // resolved different ladders and filed their cost and KB under the wrong agent, which is
  // the drift this file already warns about where roster-review is invoked properly.
  process.env.EPAM_AGENT_NAME = 'project-roster-review';
  try {
    return await spec.reviewProjectRoster({
      promptExec, rosterPath, canonicalPath: copyPath,
      codelines, tickets: stories, logDir: LOG_DIR, repoPath: REPO_PATH, toolGrant,
    });
  } catch (err) {
    // A review that cannot run must not read as "no defects".
    process.stderr.write(`[mint-step] roster review FAILED: ${err && err.message}\n`);
    return { verdict: 'review_failed', reason: String(err && err.message) };
  }
};

  return { produce, review };
}

module.exports = { rosterSeams, codelineContext };
