import type { Tool, ToolResult } from '../types.js';

export class FetchUrlTool implements Tool {
  readonly name = 'fetch_url';
  readonly description = 'Fetch the content of a URL and return it as text.';
  readonly permission = 'safe' as const;

  readonly definition = {
    name: this.name,
    description: this.description,
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        method: {
          type: 'string',
          enum: ['GET', 'POST'],
          description: 'HTTP method (default: GET)',
        },
        body: { type: 'string', description: 'Request body (for POST)' },
        headers: {
          type: 'object',
          description: 'Additional headers as key-value pairs',
        },
      },
      required: ['url'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const url = input.url as string;
    const method = (input.method as string) ?? 'GET';
    const body = input.body as string | undefined;
    const headers = (input.headers as Record<string, string>) ?? {};

    try {
      const response = await fetch(url, {
        method,
        headers: { 'User-Agent': 'epam-cli/0.1.0', ...headers },
        body: body && method !== 'GET' ? body : undefined,
        signal: AbortSignal.timeout(30000),
      });

      const text = await response.text();
      const truncated = text.length > 50000 ? text.slice(0, 50000) + '\n... (truncated)' : text;

      return {
        toolUseId: '',
        content: `HTTP ${response.status}\n\n${truncated}`,
        isError: !response.ok,
      };
    } catch (err) {
      return {
        toolUseId: '',
        content: `Error fetching URL: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
