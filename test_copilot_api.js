const resolveOAuth = () => {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = process.env.GH_CONFIG_DIR || path.join(process.env.HOME, '.config', 'gh');
    const content = fs.readFileSync(path.join(dir, 'hosts.yml'), 'utf-8');
    const m = content.match(/oauth_token:\s+(\S+)/);
    if (m) return m[1];
  } catch {}
  return null;
};

(async () => {
  const token = resolveOAuth();
  if (!token) { console.log('No OAuth token found'); return; }
  console.log('Token prefix:', token.slice(0, 4) + '..., length:', token.length);

  // Test 1: Try OAuth token directly against Copilot API (no token exchange)
  console.log('\n--- Test 1: Direct OAuth token to Copilot API ---');
  const res1 = await fetch('https://api.githubcopilot.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      'Copilot-Integration-Id': 'vscode-chat',
      'Editor-Version': 'vscode/1.96.0',
      'Editor-Plugin-Version': 'copilot-chat/0.24.0',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'say hi' }],
      max_tokens: 10,
    }),
  });
  console.log('Status:', res1.status, await res1.text().then(t => t.slice(0, 300)));

  // Test 2: Try with `token` prefix auth (like GitHub API uses)
  console.log('\n--- Test 2: token prefix auth ---');
  const res2 = await fetch('https://api.githubcopilot.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'token ' + token,
      'Copilot-Integration-Id': 'vscode-chat',
      'Editor-Version': 'vscode/1.96.0',
      'Editor-Plugin-Version': 'copilot-chat/0.24.0',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'say hi' }],
      max_tokens: 10,
    }),
  });
  console.log('Status:', res2.status, await res2.text().then(t => t.slice(0, 300)));

  // Test 3: Check if GitHub Models API (models.github.ai) supports Claude
  console.log('\n--- Test 3: GitHub Models API with Claude ---');
  const res3 = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'say hi' }],
      max_tokens: 10,
    }),
  });
  console.log('Status:', res3.status, await res3.text().then(t => t.slice(0, 300)));

  // Test 4: Try the /models listing on GitHub Models API
  console.log('\n--- Test 4: GitHub Models catalog ---');
  const res4 = await fetch('https://models.github.ai/catalog/models', {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  if (res4.ok) {
    const models = await res4.json();
    const claude = (Array.isArray(models) ? models : models.models || [])
      .filter(m => {
        const name = (m.name || m.id || m.model || '').toLowerCase();
        return name.includes('claude') || name.includes('anthropic');
      });
    console.log('Claude models found:', JSON.stringify(claude.map(m => m.name || m.id || m.model), null, 2));
  } else {
    console.log('Catalog status:', res4.status);
    // Try alternate endpoint
    const res4b = await fetch('https://api.github.com/marketplace_listing/models', {
      headers: { 'Authorization': 'token ' + token, 'Accept': 'application/json' },
    });
    console.log('Alt catalog status:', res4b.status, await res4b.text().then(t => t.slice(0, 300)));
  }

  // Test 5: Check user copilot status
  console.log('\n--- Test 5: Copilot subscription status ---');
  const res5 = await fetch('https://api.github.com/copilot/user', {
    headers: { 'Authorization': 'token ' + token, 'Accept': 'application/json' },
  });
  console.log('Copilot user status:', res5.status, await res5.text().then(t => t.slice(0, 300)));
})();
