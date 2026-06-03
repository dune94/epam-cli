# EPAM CLI Tool Registry

Tools extend what the EPAM CLI agent can do. Built-in tools ship with the package. External plugins are npm packages that implement the `ToolPlugin` interface and are listed in `.epam/settings.json`.

---

## Built-in tools

| Name | Permission | Description |
|---|---|---|
| `read_file` | safe | Read a file from the filesystem |
| `write_file` | review | Write content to a file |
| `bash` | dangerous | Execute a shell command |
| `list_files` | safe | List files in a directory |
| `search` | safe | Search for text patterns in files |
| `fetch_url` | safe | Fetch the content of a URL |

**Permission levels:**
- `safe` — always allowed, no approval prompt
- `review` — shown to user before execution
- `dangerous` — requires explicit approval or `EPAM_DANGEROUS_SKIP_APPROVAL=1`

---

## Loading external plugins

Add plugin package names or relative paths to `.epam/settings.json`:

```json
{
  "provider": "epam",
  "defaultModel": "claude-sonnet-4-5-20250929",
  "tools": [
    "@myorg/epam-tool-github",
    "./local-tools/my-custom-tool.js"
  ]
}
```

Plugins load at startup. Load failures emit a warning and are skipped — built-in tools always load.

---

## Writing a plugin

Install the type definitions:

```bash
npm install --save-dev epam-cli
```

Create your tool module:

```ts
// my-tool.ts
import type { ToolPlugin } from 'epam-cli/plugin';

const githubIssueTool: ToolPlugin = {
  pluginApiVersion: '1.0.0',
  name: 'github_create_issue',
  description: 'Create a GitHub issue in the specified repository.',
  permission: 'review',

  definition: {
    name: 'github_create_issue',
    description: 'Create a GitHub issue.',
    inputSchema: {
      type: 'object',
      properties: {
        repo:  { type: 'string', description: 'owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body:  { type: 'string', description: 'Issue body (markdown)' },
      },
      required: ['repo', 'title'],
    },
  },

  async execute(input) {
    // ... call GitHub API ...
    return { toolUseId: '', content: 'Issue #42 created.', isError: false };
  },
};

export default githubIssueTool;
// Or export multiple tools:
// export const tools = [githubIssueTool, anotherTool];
```

---

## Plugin API versioning

The current API version is **1.0.0**. The `pluginApiVersion` field in your plugin declares which version it targets.

- **Patch/minor bumps** (1.x.y): backwards-compatible additions. Existing plugins continue to work.
- **Major bumps** (2.x.x): breaking changes. The runtime emits a compatibility warning but still loads the plugin.

Omitting `pluginApiVersion` triggers a warning and defaults to 1.0.0.

---

## Publishing a plugin

1. Name your package with the prefix `epam-tool-` so it's discoverable: e.g. `epam-tool-github`, `epam-tool-jira`.
2. Set `"main"` in `package.json` to your built entry point.
3. Export `default` (single tool) or `tools` (array) from your entry point.
4. Publish to npm: `npm publish --access public`.
