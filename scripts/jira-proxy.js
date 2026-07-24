#!/usr/bin/env node

/**
 * Simple JIRA API Proxy for Demo
 * 
 * Wraps the MCP-atlassian server to provide simple HTTP endpoint
 */

const http = require('http');

// Credentials come from the environment ONLY — never a hardcoded fallback.
// A live Atlassian API token used to be inlined here as the JIRA_TOKEN default and
// was published to the remote; it has been removed and must be treated as
// compromised/rotated. Fail loudly rather than silently falling back to a secret.
const JIRA_URL = process.env.JIRA_URL || 'https://metrolinx.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_TOKEN || '';

if (!JIRA_TOKEN || !JIRA_EMAIL) {
  console.error('[jira-proxy] JIRA_EMAIL and JIRA_TOKEN must be set in the environment. ' +
                'Source your secrets file (e.g. orchestrations/jira/metrolinx.env) before starting.');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const query = data.params?.query || '';

      // Extract ticket ID from query (e.g., "AMSD-1013")
      const ticketMatch = query.match(/([A-Z]+-\d+)/i);
      
      if (!ticketMatch) {
        res.writeHead(200);
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: data.id,
          result: []
        }));
        return;
      }

      const ticketId = ticketMatch[1].toUpperCase();

      // Mock JIRA data for demo
      const mockTickets = {
        'AMSD-1013': {
          key: 'AMSD-1013',
          fields: {
            summary: 'Implement user authentication flow',
            status: { name: 'In Progress' },
            updated: new Date().toISOString(),
            description: 'Implement OAuth2 authentication for user login'
          }
        },
        'AMSD-1014': {
          key: 'AMSD-1014',
          fields: {
            summary: 'Add dashboard analytics',
            status: { name: 'To Do' },
            updated: new Date().toISOString(),
            description: 'Create analytics dashboard for user metrics'
          }
        },
        'AMSD-1015': {
          key: 'AMSD-1015',
          fields: {
            summary: 'Fix payment gateway timeout',
            status: { name: 'Done' },
            updated: new Date().toISOString(),
            description: 'Resolve timeout issues with payment processing'
          }
        }
      };

      const ticket = mockTickets[ticketId];

      if (!ticket) {
        res.writeHead(200);
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: data.id,
          result: []
        }));
        return;
      }

      // Format for MCP response
      const result = [{
        id: ticket.key || ticketId,
        title: ticket.fields?.summary || 'Unknown',
        status: ticket.fields?.status?.name || 'Unknown',
        url: `${JIRA_URL}/browse/${ticket.key || ticketId}`,
        updated: ticket.fields?.updated || new Date().toISOString(),
        summary: `${ticket.key || ticketId}: ${ticket.fields?.summary || 'No summary'} (${ticket.fields?.status?.name || 'Unknown'})`
      }];

      res.writeHead(200);
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: data.id,
        result
      }));

    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: data?.id || 1,
        error: { message: err.message }
      }));
    }
  });
});

const PORT = process.env.PROXY_PORT || 9011;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`JIRA Proxy listening on http://127.0.0.1:${PORT}`);
});
