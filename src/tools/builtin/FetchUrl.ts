import type { Tool, ToolResult } from '../types.js';


/**
 * Reduce an HTML document to the text a reader would see.
 *
 * Deliberately dependency-free and conservative: drop the elements whose contents are never
 * prose (script, style, and friends), turn block boundaries into newlines so structure
 * survives, strip remaining tags, then decode the handful of entities documentation
 * actually uses. Anything cleverer needs a parser, and a parser is not worth a dependency
 * for this.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

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

      const raw = await response.text();
      const contentType = response.headers.get('content-type') ?? '';

      // HTML -> TEXT, BEFORE any cap.
      //
      // This tool's contract is to return a URL's content "as text", and it returned raw
      // markup. On a real documentation page the prose is a small fraction of the bytes:
      // script, style, navigation and inlined data consume the rest. Capping the RAW html
      // therefore spends the budget on markup and cuts the page off — a live fetch of a
      // vendor doc returned exactly the cap plus the truncation marker, so the page was
      // clipped, and documentation puts API detail partway down.
      //
      // That is load-bearing: agents read vendor docs here to establish the real contract
      // of an API a story depends on, and are required to QUOTE rather than paraphrase.
      // A truncated page cannot support a verbatim quote.
      //
      // Only text/html is transformed; JSON and plain text are returned untouched so a
      // machine-readable response is never mangled.
      const text = /\bhtml\b/i.test(contentType) ? htmlToText(raw) : raw;

      // Configurable: how much a model should be handed is a property of the run, not a
      // constant. Truncation is always ANNOUNCED — a silently clipped page reads as a
      // complete one.
      const cap = Number(process.env.EPAM_FETCH_MAX_CHARS || '50000');
      const truncated = text.length > cap
        ? text.slice(0, cap) + `\n... (truncated at ${cap} characters — the page continues)`
        : text;

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
