'use strict';

/**
 * Mock LLM server — OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Returns pre-scripted SSE streaming responses for each hello-world story.
 * Zero tokens consumed. Used as Tier-1 in the 3-tier pipeline test strategy.
 *
 * Story detection: grep all message content for HW-XXX IDs or function keywords.
 * Follow-up detection: any message with role="tool" → return "done" text response.
 */

const http = require('http');
const RESPONSES = require('./responses.js');

const PORT = process.env.PORT || 4000;

// ── Story detection ────────────────────────────────────────────────────────────
// Find the EARLIEST HW-XXX mention in the content — this is the target story.
// Do NOT use a priority list: the PRD context injected into prompts lists ALL
// story IDs, so a priority-order scan always matches the wrong (higher-priority) story.
function detectStory(content) {
  // Find all HW-NNN occurrences with their positions
  const re = /\bHW-(\d{3})\b/g;
  let earliest = null;
  let earliestPos = Infinity;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (m.index < earliestPos) {
      earliestPos = m.index;
      earliest = `HW-${m[1]}`;
    }
  }
  // Map to known story IDs
  const known = ['HW-001', 'HW-002', 'HW-003', 'HW-004', 'HW-005', 'HW-006'];
  if (earliest && known.includes(earliest)) return earliest;
  return 'unknown';
}

function extractContent(msg) {
  if (!msg.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(c => (typeof c === 'string' ? c : c.text || '')).join(' ');
  }
  return '';
}

// ── SSE helpers ────────────────────────────────────────────────────────────────
function sseText(res, content) {
  const id = `mock-${Date.now()}`;
  const chunks = [
    { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-llm',
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-llm',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } },
  ];
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
}

function sseToolCalls(res, files) {
  const id = `mock-${Date.now()}`;
  // Build all tool_calls in a single delta chunk — OpenRouterProvider accumulates by index.
  const toolCalls = files.map((f, i) => ({
    index: i,
    id: `call_mock_${i}_${Date.now()}`,
    type: 'function',
    function: {
      name: 'write_file',
      arguments: JSON.stringify({ path: f.path, content: f.content }),
    },
  }));

  const headerChunk = {
    id, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: 'mock-llm',
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: null, tool_calls: toolCalls },
      finish_reason: null,
    }],
  };
  const finishChunk = {
    id, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: 'mock-llm',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
  };

  res.write(`data: ${JSON.stringify(headerChunk)}\n\n`);
  res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
  res.write('data: [DONE]\n\n');
}

// ── Request handler ────────────────────────────────────────────────────────────
function handleChatCompletions(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const messages = payload.messages || [];

    // Follow-up after tool execution → return "done" text
    const hasToolResults = messages.some(m => m.role === 'tool');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.writeHead(200);

    if (hasToolResults) {
      sseText(res, 'Implementation complete. All files written and verified successfully.');
      res.end();
      return;
    }

    // Story detection: only scan the FIRST user message (the task assignment).
    // Scanning all messages includes the full PRD context (all story IDs),
    // which causes false matches (e.g. HW-001 prompt matches HW-005/truncate).
    const firstUserMsg = messages.find(m => m.role === 'user');
    const taskContent = firstUserMsg ? extractContent(firstUserMsg).slice(0, 2000) : '';
    const storyId = detectStory(taskContent);
    const response = RESPONSES[storyId];

    // When no tools are declared in the request (--no-tools callers: CPA, spec-mode-runner,
    // ai-run.sh text queries), always return text — never tool_calls.
    // Tool-calling requests (story agents via epam run with write_file registered) will
    // have payload.tools populated.
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;

    console.log(`[mock-llm] story=${storyId} hasTools=${hasTools} msgs=${messages.length} preview=${taskContent.slice(0,80).replace(/\n/g,' ')}`);

    if (!hasTools || !response || response.type === 'text') {
      sseText(res, response ? response.content : 'Task acknowledged. No files to write.');
    } else {
      sseToolCalls(res, response.files);
    }

    res.end();
  });
}

// ── Server ─────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    handleChatCompletions(req, res);
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', model: 'mock-llm' }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: `Not found: ${req.method} ${req.url}` }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-llm] Listening on port ${PORT}`);
  console.log(`[mock-llm] Stories available: ${Object.keys(RESPONSES).join(', ')}`);
});

server.on('error', err => {
  console.error('[mock-llm] Server error:', err);
  process.exit(1);
});
