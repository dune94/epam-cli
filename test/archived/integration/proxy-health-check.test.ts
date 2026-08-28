import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import http from 'http';

describe('EPAM-HC-004: Health Check with Proxy Backend', () => {
  let mockServer: http.Server;
  let serverUrl: string;

  beforeEach(() => {
    return new Promise<void>((resolve) => {
      mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/v1/proxy/anthropic/messages') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                content: [{ type: 'text', text: 'echo hello' }],
                usage: { inputTokens: 10, outputTokens: 5 },
                stopReason: 'end_turn',
              })
            );
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      mockServer.listen(0, 'localhost', () => {
        const addr = mockServer.address();
        if (addr && typeof addr === 'object') {
          serverUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(() => {
    return new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    });
  });

  it('should fail when EPAM_BACKEND_URL is not set', () => {
    const env = { ...process.env };
    delete env.EPAM_BACKEND_URL;

    const result = spawnSync('node', ['dist/epam.js', 'health-check-proxy'], {
      encoding: 'utf-8',
      env,
      timeout: 5000,
    });

    expect(result.status).toBe(1);
  });

  it('should handle proxy backend connection errors gracefully', () => {
    const result = spawnSync('node', ['dist/epam.js', 'health-check-proxy'], {
      encoding: 'utf-8',
      env: { ...process.env, EPAM_BACKEND_URL: 'http://localhost:1' },
      timeout: 35000,
    });

    expect(result.status).toBe(1);
  });

  it('health-check-proxy command should be available in CLI', () => {
    const result = spawnSync('node', ['dist/epam.js', 'health-check-proxy', '--help'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Health check: verify Claude CLI with proxy backend');
  });
});

