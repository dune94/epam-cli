The file epam-cli-guide.html is a locked template in the epam-cli project. You may ONLY change text/data within existing elements. You must NOT add, remove, or rearrange any HTML tags, CSS classes, or structural elements. If a section doesn't apply, leave the element empty — do not remove it. Regenerate the epam-cli-guide.html in the demo project. This is to be ignored outside of a demo project.

Layout (Top down, left to right):
1. Header / Navigation: Sticky top bar plus right-side quick links to in-page anchors.
2. Overview / Quick Start: Introductory sections explaining purpose and first-run command flow.
3. Authentication: Device flow and BYOK guidance with command snippets.
4. CLI Commands: Command catalog for core features including estimate, orchestrate, phase, and related commands.
5. In-REPL Slash Commands: Complete table of all 17 slash commands with aliases. Standard commands: /help, /clear (/c), /context, /model (/m), /compact, /resume (/r), /rewind (/undo), /permissions, /cost, /chain, /exit (/quit /q). Novel commands (★): /plan (/planning), /agent (/agents), /skills (/tools), /provider (/providers /prov), /user (/whoami /users), /stash.
6. Novel Slash Commands ★ (detailed): Each novel command has a box.box-novel description and a pre block.
   - /cost: live cost breakdown with budget status display
   - /chain: failover chain status, /chain set, /chain reset
   - /rewind: last turn removal with confirmation
   - /plan [show|create|branch]: structured plan mode
   - /agent [switch|show|add|remove|reset]: named agent persona management; orchestration agents visible but read-only
   - /skills [enable|disable|show]: live tool toggle with safety tier display
   - /provider [name | auth | logout]: unified provider switch/auth/logout; supports name/model syntax
   - /user [list|add|switch|remove]: multi-account identity; live credential swap
   - /stash [save|list|pop|merge|drop]: private context stash to ~/.epam/stash/
7. Configuration Files: Settings file locations and key fields.
8. Environment Variables: Runtime/env override catalog — includes EPAM_ORCHESTRATION_PROVIDER and EPAM_CLI (new provider layer vars).
9. Tools & Approval: Approval and tool execution policy details.
10. Provider Failover Chain ★: Configuration and failover policy details for chain routing.
