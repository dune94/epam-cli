/**
 * Live test: spawn codex as a child process and verify event flow
 * Run with: ~/.nvm/versions/node/v20.20.0/bin/node test_codex_live.js
 */
const { execa } = require('./node_modules/execa');
const start = Date.now();
const elapsed = () => ((Date.now() - start) / 1000).toFixed(2) + 's';

console.log('=== Codex spawn test ===\n');

async function testTurn(label, promptText) {
  console.log(`\n--- ${label} ---`);
  console.log(`Prompt: "${promptText}"`);
  
  return new Promise((resolve) => {
    const proc = execa('codex', [
      'exec',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--ephemeral',
      '--json',
      promptText,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      detached: true,
    });
    proc.catch(() => {});

    console.log(`PID: ${proc.pid}`);

    let buffer = '';
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      console.log(`[${elapsed()}] Killing process (pid=${proc.pid})`);
      try { process.kill(-(proc.pid), 'SIGKILL'); } catch(e) { console.log('group kill failed:', e.message); }
      try { proc.kill('SIGKILL'); } catch(e) {}
      resolve(result);
    };

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          const extra = event.item ? `[${event.item.type}] "${(event.item.text||'').slice(0,50)}"` : '';
          console.log(`  [${elapsed()}] ${event.type} ${extra}`);
          
          if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') {
            const text = event.item.text || '';
            if (text.trim()) {
              console.log(`  ✓ AGENT_MESSAGE: "${text}"`);
              // Wait 1s to see if more events come
              setTimeout(() => finish({ ok: true, text }), 1000);
            }
          }
          if (event.type === 'turn.completed') {
            finish({ ok: true, text: '(turn.completed)' });
          }
        } catch(e) {}
      }
    });

    proc.on('exit', (code) => {
      console.log(`  [${elapsed()}] process exit code=${code}`);
      if (!done) finish({ ok: false, text: 'exited' });
    });
    proc.on('error', (e) => {
      console.error(`  [${elapsed()}] ERROR:`, e.message);
      if (!done) finish({ ok: false, text: e.message });
    });

    // 20s hard timeout per turn
    const t = setTimeout(() => { console.log('  TIMEOUT 20s'); finish({ ok: false, text: 'timeout' }); }, 20000);
    t.unref();
  });
}

(async () => {
  const r1 = await testTurn('Turn 1', 'Reply with one word: ALPHA');
  console.log(`\nTurn 1 result: ${r1.ok ? 'OK' : 'FAIL'} — "${r1.text}"`);

  if (!r1.ok) { console.log('\nTurn 1 failed — aborting'); process.exit(1); }

  // Wait 1s between turns
  await new Promise(r => setTimeout(r, 1000));

  const r2 = await testTurn('Turn 2', 'Reply with one word: BETA');
  console.log(`\nTurn 2 result: ${r2.ok ? 'OK' : 'FAIL'} — "${r2.text}"`);

  await new Promise(r => setTimeout(r, 1000));

  const r3 = await testTurn('Turn 3', 'Reply with one word: GAMMA');
  console.log(`\nTurn 3 result: ${r3.ok ? 'OK' : 'FAIL'} — "${r3.text}"`);

  console.log('\n=== DONE ===');
  console.log(`T1: ${r1.ok?'✓':'✗'} T2: ${r2.ok?'✓':'✗'} T3: ${r3.ok?'✓':'✗'}`);
  process.exit(r1.ok && r2.ok && r3.ok ? 0 : 1);
})();
