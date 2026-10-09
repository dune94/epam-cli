'use strict';
/**
 * THE TWO AGENT CALLS PROJECT-PROMPT PROVISIONING MAKES — the generator and its reviewer.
 *
 * They were closures inside mint-agents-step.js, so the only way to exercise prompt generation with real agents was
 * the whole Agents Phase. Run 3 of AMSD-2974 (2026-10-09) died there after 5 rejected codeline-discovery prompts; a
 * fix to that loop needs a harness that runs THIS code for one prompt, on live tokens, and the mint step must run the
 * same code. One definition, two callers (test/integration/live/prompt-generation/run.sh).
 *
 * @returns {{ runText: Function, reviewPrompt: Function|undefined }} as buildProjectPrompts takes them
 */
const path = require('path');
const fs = require('fs');

function promptBuildCalls({
  engineRoot, logDir, runClaude, promptExec, projectConfigDir,
  codelineContext, stories, mintedDetail, toolGrant, reviewEnabled,
}) {
  const { seamInvocationEnv } = require('./seam-invocation.js');
  const { makePromptReviewer, makePromptRenderer } = require('./prompt-review.js');
  const promptsLib = require('./prompt-library.js');
  const agentsDir = path.join(engineRoot, 'orchestrations', 'agents');
  let generatorModel = '';

  const runText = (prompt, meta) => {
    const rung = Math.max(0, (Number((meta && meta.attempt) || 1) || 1) - 1);
    const seamEnv = seamInvocationEnv('prompt-builder', agentsDir, { rung });
    if (seamEnv.EPAM_ALLOWED_TOOLS) seamEnv.AI_GATE_ALLOW_TOOLS = '1';
    generatorModel = seamEnv.EPAM_MODEL || '';
    seamEnv.EPAM_AGENT_NAME = 'prompt-builder';
    return runClaude(
      promptExec, prompt,
      path.join(logDir, `prompt-build-${(meta && meta.id) || 'unknown'}.log`),
      seamEnv, { costAgent: 'prompt-builder' });
  };

  // THE ADJUDICATOR — one disputed claim, settled in the repositories by another agent on another rung.
  const adjudicate = async ({ id, claim, finding }) => {
    const vals = { __CLAIM__: claim, __FINDING__: finding || '(the reviewer gave no finding)', __CODELINE_BLOCK__: codelineContext || '', __TOOL_LINE__: toolGrant || '' };
    let prompt;
    try { prompt = promptsLib.buildPrompt('prompt-claim-adjudication', projectConfigDir, vals); } catch (e) {
      // A project provisioned before this seam existed has no copy; the template is what bootstrap would copy.
      const ep = require('./engine-prompt.js');
      const tpl = JSON.parse(fs.readFileSync(ep.templatePathFor('prompt-claim-adjudication'), 'utf8'));
      prompt = ep.substituteOnce(tpl.body, Object.keys(vals), vals);
    }
    const seamEnv = seamInvocationEnv('prompt-claim-adjudicator', agentsDir);
    if (seamEnv.EPAM_ALLOWED_TOOLS) seamEnv.AI_GATE_ALLOW_TOOLS = '1';
    seamEnv.EPAM_AGENT_NAME = 'prompt-claim-adjudicator';
    const out = await runClaude(promptExec, prompt, path.join(logDir, `prompt-adjudication-${id}.log`), seamEnv, { costAgent: 'prompt-claim-adjudicator' });
    const m = String(out || '').match(/<ADJUDICATION>([\s\S]*?)<\/ADJUDICATION>/);
    if (!m) return null;
    try {
      const r = JSON.parse(m[1].trim().replace(/^```(?:json)?/i, '').replace(/```$/, ''));
      return { holds: r.holds === true, evidence: String(r.evidence || '') };
    } catch { return null; }
  };

  const reviewPrompt = reviewEnabled ? makePromptReviewer({
    render: makePromptRenderer(promptsLib),
    invoke: (prompt, logPath) => {
      const seamEnv = seamInvocationEnv('prompt-review', agentsDir);
      if (seamEnv.EPAM_ALLOWED_TOOLS) seamEnv.AI_GATE_ALLOW_TOOLS = '1';
      seamEnv.EPAM_AGENT_NAME = 'prompt-review';
      // THE REVIEWER RUNS ON THE GENERATOR'S RUNG — a prompt is judged by the model that wrote it.
      if (!generatorModel) {
        generatorModel = seamInvocationEnv('prompt-builder', agentsDir, { rung: 0 }).EPAM_MODEL || '';
      }
      if (!generatorModel) {
        throw new Error(
          '[prompt-review] the generator resolved no model, so there is no rung to review on. '
          + 'Refusing to judge a prompt from a model that did not write it.');
      }
      seamEnv.EPAM_MODEL = generatorModel;
      return runClaude(promptExec, prompt, logPath, seamEnv, { costAgent: 'prompt-review' });
    },
    values: ({ id, template, generated }) => ({
      __ROSTER_BLOCK__: (Array.isArray(mintedDetail) && mintedDetail.length
        ? mintedDetail.map((m) => `- ${m.name}${m.kind ? ` [${m.kind}]` : ''}`).join('\n')
        : '- (this project minted no agents of its own)'),
      __PROMPT_ID__: id,
      __TEMPLATE_BODY__: require('./project-prompt-builder.js').templateBodyText(template),
      __GENERATED_BODY__: (generated && generated.body) || '',
      __CODELINE_BLOCK__: codelineContext,
      __TICKET_BLOCK__: (Array.isArray(stories) ? stories : [])
        .map((t) => `- ${t.id || ''}: ${t.title || ''}`).join('\n'),
      __TOOL_LINE__: toolGrant || '',
    }),
    logPathFor: (id) => path.join(logDir, `prompt-review-${id}.log`),
    recordVerdict: (rec) => fs.appendFileSync(path.join(logDir, 'prompt-review-verdicts.jsonl'), `${JSON.stringify(rec)}\n`),
    adjudicate,
    projectConfigDir,
  }) : undefined;

  return { runText, reviewPrompt, adjudicate };
}

module.exports = { promptBuildCalls };
