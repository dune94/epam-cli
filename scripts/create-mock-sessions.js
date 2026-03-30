#!/usr/bin/env node

/**
 * Create Mock Historical Sessions
 * 
 * Generates test sessions for failover demo scenarios
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const SESSIONS_DIR = join(process.cwd(), '.epam', 'sessions');

// Ensure sessions directory exists
if (!existsSync(SESSIONS_DIR)) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Mock sessions for demo
const sessions = [
  {
    id: 'codemie-session-001',
    provider: 'codemie',
    model: 'claude-sonnet-4-5-20250929',
    description: 'Codemie session - React app development',
    messages: [
      { role: 'user', content: 'Build a React todo app with authentication' },
      { role: 'assistant', content: 'I\'ll help you build a React todo app with authentication. Let me create the project structure...' },
      { role: 'user', content: 'Add user login functionality' },
      { role: 'assistant', content: 'Adding user login functionality. I\'ll create the authentication components...' },
      { role: 'user', content: 'Now add password reset' },
    ],
  },
  {
    id: 'qwen-session-001',
    provider: 'qwen',
    model: 'qwen-max',
    description: 'Qwen session - API development',
    messages: [
      { role: 'user', content: 'Create a REST API for user management' },
      { role: 'assistant', content: 'I\'ll create a REST API with Express.js for user management...' },
      { role: 'user', content: 'Add rate limiting' },
      { role: 'assistant', content: 'Adding rate limiting using express-rate-limit middleware...' },
    ],
  },
  {
    id: 'cursor-session-001',
    provider: 'cursor',
    model: 'gemini-2.5-pro',
    description: 'Cursor session - Database schema',
    messages: [
      { role: 'user', content: 'Design a database schema for an e-commerce platform' },
      { role: 'assistant', content: 'I\'ll design a comprehensive database schema for your e-commerce platform...' },
      { role: 'user', content: 'Add inventory tracking' },
    ],
  },
  {
    id: 'copilot-session-001',
    provider: 'copilot',
    model: 'claude-sonnet-4-6',
    description: 'Copilot session - Code review',
    messages: [
      { role: 'user', content: 'Review this authentication module for security issues' },
      { role: 'assistant', content: 'I\'ll review your authentication module for security vulnerabilities...' },
      { role: 'user', content: 'Fix the identified issues' },
    ],
  },
];

// Create session files
console.log('Creating mock historical sessions...\n');

for (const session of sessions) {
  const filename = `${session.id}.jsonl`;
  const filepath = join(SESSIONS_DIR, filename);
  
  // Create JSONL content
  const lines = session.messages.map(msg => 
    JSON.stringify({
      timestamp: new Date().toISOString(),
      role: msg.role,
      content: msg.content,
      provider: session.provider,
      model: session.model,
    })
  ).join('\n');
  
  writeFileSync(filepath, lines + '\n');
  
  console.log(`✓ Created: ${filename}`);
  console.log(`  Provider: ${session.provider}/${session.model}`);
  console.log(`  Messages: ${session.messages.length}`);
  console.log(`  Description: ${session.description}`);
  console.log();
}

console.log('Mock sessions created successfully!\n');
console.log('Usage in EPAM CLI:');
console.log('  /resume <session-id>');
console.log('  /failover <provider>');
console.log();
console.log('Example:');
console.log('  /resume codemie-session-001');
console.log('  /failover qwen');
console.log();
