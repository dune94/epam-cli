/**
 * transcript-tool-calls.js — the calls a model MADE, recovered from the runner's own transcript.
 *
 * WHY THIS EXISTS.
 *
 * A recording of a run is only replayable if it carries what the model DID, not merely what it
 * said. Live 2026-09-04: Langfuse held 113 traces of a paid AMSD-1919 run, and a $0 replay of it
 * still could not get past the mint, because mock-expectations found eleven captures UNUSABLE —
 *
 *     roster-specialiser  (prose — never satisfied its contract)
 *     agent-mint          (ends in prose; this seam is answered by a tool call)
 *
 * roster-specialiser DELIVERS by writing roster.json. Serving the sentence it wrote afterwards
 * leaves no file behind, the contract refuses it, and the mint fails after three attempts.
 *
 * THE DATA WAS NEVER LOST — IT WAS NEVER LOOKED AT. The runner is invoked with
 * `--print --output-format json`, whose result is `{type:'result', result:'<text>', usage:{…}}`:
 * the tool calls happen inside the runner and never appear there. They ARE written, to the
 * runner's own session transcript — one JSON object per line, assistant messages carrying
 * `content: [{type:'tool_use', name, input}]`. Measured on the killed run's own directory: 28
 * tool_use blocks across 7 of 16 transcripts, including the StructuredOutput calls by which seams
 * return structured answers.
 *
 * READ-ONLY AND UNFAILABLE. This is observability: it never throws, and it returns an empty list
 * rather than a guess. A transcript that is missing, partially written (it is appended to while
 * the call is still in flight) or malformed yields nothing at all, which reads honestly as "no
 * calls recorded" rather than as a call that never happened.
 */
'use strict';

const fs = require('fs');

/**
 * Every tool call in a runner transcript, in the order the model made them.
 *
 * @param {string} file  path to the runner's session JSONL
 * @returns {Array<{name: string, input: object, id: string}>}
 */
function toolCallsInTranscript(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];                       // absent or unreadable: no calls recorded, not an error
  }

  const calls = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let row;
    // A HALF-WRITTEN LINE IS SKIPPED, NOT FATAL. The file is appended to while the call is still
    // running, so the last line is routinely a fragment. Dropping the whole transcript because of
    // it would lose every complete call before it.
    try { row = JSON.parse(s); } catch { continue; }

    const content = row && row.message && row.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use' || !block.name) continue;
      calls.push({
        name: String(block.name),
        input: block.input && typeof block.input === 'object' ? block.input : {},
        id: block.id ? String(block.id) : '',
      });
    }
  }
  return calls;
}

module.exports = { toolCallsInTranscript };
