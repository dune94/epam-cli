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
const STORY_PATTERNS = [
  { id: 'HW-006', re: /HW-006|slugify/i },
  { id: 'HW-005', re: /HW-005|truncate/i },
  { id: 'HW-004', re: /HW-004|formatDate|format.*date/i },
  { id: 'HW-003', re: /HW-003|code.?review.*greet|review.*greet\.ts/i },
  { id: 'HW-002', re: /HW-002|verify.*tests.*pass|all tests.*pass/i },
  { id: 'HW-001', re: /HW-001|greet\(|implement.*greet|greet\.ts/i },
];

function detectStory(allContent) {
  for (const { id, re } of STORY_PATTERNS) {
    if (re.test(allContent)) return id;
  }
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
  // Build all tool_calls in a single delta chunk — QwenProvider accumulates by index.
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

    const allContent = messages.map(extractContent).join('\n');
    const storyId = detectStory(allContent);
    const response = RESPONSES[storyId];

    console.log(`[mock-llm] story=${storyId} hasToolResults=${hasToolResults} messages=${messages.length}`);

    if (!response || response.type === 'text') {
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
