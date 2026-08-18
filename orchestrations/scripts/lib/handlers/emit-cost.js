#!/usr/bin/env node
/**
 * RECORD ONE CALL'S SPEND, FROM A SHELL STEP.
 *
 * ai-run.sh writes the normalized result JSON when ORCH_JSON_RESULT is set. lib/cost-emitter.js
 * turns that into a cost_snapshot on the activity log — but only JS callers could reach it, so
 * every shell-side model call was invisible to cost tracking.
 *
 *   argv[2]  the result file ai-run.sh wrote
 *   argv[3]  the agent to attribute it to
 *   env      ACTIVITY_FILE, or LOG_DIR to derive it
 *
 * Best-effort and silent on failure by design: a cost record that cannot be written must never take
 * down the step it was measuring. What is NOT silent is the absence of the plumbing, which is what
 * a test guards.
 */
'use strict';

const path = require('path');

const [, , resultFile, agent] = process.argv;
if (!resultFile || !agent) {
  process.stderr.write('[emit-cost] usage: <result-file> <agent>\n');
  process.exit(1);
}

try {
  require(path.join(__dirname, '..', 'cost-emitter.js')).emitCostSnapshot({
    resultFile,
    activityFile: process.env.ACTIVITY_FILE
      || path.join(process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs'), 'agent-activity.jsonl'),
    agent,
    storyId: process.env.EPAM_STORY_ID || '',
    phase: process.env.PHASE || '',
    model: process.env.AI_MODEL || '',
    provider: process.env.AI_PROVIDER || '',
  });
} catch { /* cost emission must never break the step it measured */ }
