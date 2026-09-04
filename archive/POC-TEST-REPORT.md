# EPAM CLI POC Test Report

Date: 2026-03-01

## Scope

This report captures a user-perspective proof of concept of the current `epam-cli` feature set using the active application code and `orchestrations/prd.json`.

Environment used:

- Local workspace build from `/home/bjerome/projects/ai/epam-cli`
- Mock EPAM backend at `http://127.0.0.1:8080`
- No real EPAM SSO backend integration
- No live Anthropic/OpenAI provider account login integration

## Executive Summary

The POC demonstrates that EPAM CLI is operational as a governed AI delivery CLI, not just a prompt wrapper.

Validated strengths:

- EPAM-style login and `doctor` flow via mock backend
- EPAM proxy execution path for `run` and interactive `chat`
- planning and orchestration controls, including approval-gated phase execution
- decision memory and profile management
- reporting, cost summaries, and session history
- provider credential storage fallback for Linux environments without a usable desktop secret store

Important fixes completed during the POC:

- `doctor` now detects a real configuration problem instead of failing generically
- EPAM provider routing now resolves to a valid upstream proxy target
- burn-up report average token math no longer returns `NaN`
- `keys` now works when `keytar` exists but DBus/secret-service is unavailable
- pricing was added for `claude-sonnet-4-5-20250929`
- completed-phase runs now fail clearly instead of appearing inconsistent with estimation output

Remaining low-priority issues were added to the PRD backlog:

- `EPAM-049` Disable dead default MCP example server
- `EPAM-050` Remove misleading provider-slot warning at REPL init

Generated coverage rollup:

- [quality-summary.json](/home/bjerome/projects/ai/epam-cli/orchestrations/logs/quality-summary.json)

## Feature Results

| Feature | Status | Notes | Evidence |
|---|---|---|---|
| `doctor` default config | Pass | Correctly identified placeholder backend as the real blocker | [doctor-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/doctor-output.txt) |
| `doctor` with mock backend | Pass | Backend URL, auth, connectivity, and provider readiness all passed | [doctor-mock-backend-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/doctor-mock-backend-output.txt) |
| `login` | Pass | Device activation completed against mock EPAM backend | [login-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/login-output.txt) |
| activation page | Pass | Browser activation page rendered and accepted approval | [login-activate-page.png](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/login-activate-page.png) |
| `whoami` | Pass | Authenticated identity resolved correctly | [whoami-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/whoami-output.txt) |
| `models` | Pass | EPAM allow-list and default model rendered correctly | [models-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/models-output.txt) |
| `init` | Pass | Idempotent behavior confirmed | [init-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/init-output.txt) |
| `context show` missing file | Pass | Surfaced real onboarding gap before `context init` | [context-show-missing-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/context-show-missing-output.txt) |
| `context init` + `context show` | Pass | Context seed file created and displayed | [context-init-show-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/context-init-show-output.txt) |
| `estimate --phase mvp_cli_control --skip-cpa` | Pass | Produced usable phase estimate | [estimate-mvp-cli-control-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/estimate-mvp-cli-control-output.txt) |
| `orchestrate --dry-run --skip-cpa` | Pass | Planning-only preview behaved correctly | [orchestrate-dry-run-skip-cpa-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/orchestrate-dry-run-skip-cpa-output.txt) |
| `orchestrate --dry-run` | Pass | AI-assisted forecasting during dry run confirmed intentional | [orchestrate-dry-run-bug-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/orchestrate-dry-run-bug-output.txt) |
| `history` | Pass | Recent sessions listed correctly | [history-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/history-output.txt) |
| `report --format md` | Pass after fix | `Avg Tokens/Turn` no longer outputs `NaN` | [report-output-fixed.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/report-output-fixed.txt) |
| `run -p anthropic --json --no-tools` | Pass | Mock backend anthropic route responded successfully | [run-anthropic-mock-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/run-anthropic-mock-output.txt) |
| `run --json --no-tools` with `provider=epam` | Pass after fix | EPAM provider route now resolves correctly | [run-epam-provider-success-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/run-epam-provider-success-output.txt) |
| `decision` add/search | Pass | Architectural decisions persisted and searched correctly | [decision-search-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/decision-search-output.txt) |
| `profile` save/list/load | Pass | Local profile lifecycle validated | [profile-save-load-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/profile-save-load-output.txt) |
| `chat` REPL smoke | Pass | `/help`, `/context`, prompt/response, `/cost`, `/exit` all worked | [chat-repl-smoke-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/chat-repl-smoke-output.txt) |
| `phase run --require-approval` without approval | Pass | Correctly blocked | [phase-run-provider-auth-require-approval-fail.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/phase-run-provider-auth-require-approval-fail.txt) |
| `phase approve --phase provider_auth` | Pass | Approval written to audit log | [phase-approve-provider-auth-output.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/phase-approve-provider-auth-output.txt) |
| `phase run --phase provider_auth --dry-run --skip-cpa --require-approval` | Pass | Full governed dry-run executed successfully | [phase-run-provider-auth-require-approval-pass.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/phase-run-provider-auth-require-approval-pass.txt) |
| `phase run` on completed phase | Pass after fix | Now fails clearly with `runnableStoryCount: 0` | [phase-run-completed-phase.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/phase-run-completed-phase.txt) |
| `keys` lifecycle | Pass after fix | `list`, `set`, `get`, `remove`, `list` all worked via fallback storage | [keys-list-fixed.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/keys-list-fixed.txt), [keys-set-fixed.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/keys-set-fixed.txt), [keys-get-fixed.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/keys-get-fixed.txt), [keys-remove-fixed.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/keys-remove-fixed.txt), [keys-list-after-remove.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/keys-list-after-remove.txt) |
| `chat /cost` after pricing fix | Pass | Correct pricing now shown for default EPAM model | [chat-cost-fixed.txt](/home/bjerome/projects/ai/epam-cli/test-evidence/poc/chat-cost-fixed.txt) |

## Key Findings

### 1. EPAM CLI already demonstrates governed delivery control

The strongest validated differentiator is not just prompt execution. It is the combination of:

- authentication and backend control plane
- approval-gated phase execution
- planning and dry-run orchestration
- decision and profile memory
- cost and report visibility

### 2. The product surfaced real operator issues under normal usage

The POC found issues that matter in actual delivery use:

- placeholder backend misconfiguration handling
- invalid EPAM proxy routing path
- report aggregation math edge case
- broken `keys` behavior on Linux secret-service environments
- pricing gap for the default configured model
- ambiguous phase behavior on completed phases

Those were all resolved during the POC except for the two low-priority runtime warnings now tracked in backlog.

### 3. The mock EPAM backend was sufficient for proving the control plane

Even without real EPAM SSO integration, the mock backend was enough to validate:

- device login flow
- backend health and auth checks
- EPAM proxy execution
- operator UX for stakeholder demos

## Code Areas Changed During POC

- [doctor.ts](/home/bjerome/projects/ai/epam-cli/src/cli/commands/doctor.ts)
- [ProviderCredentialStore.ts](/home/bjerome/projects/ai/epam-cli/src/auth/ProviderCredentialStore.ts)
- [KeychainKeyStore.ts](/home/bjerome/projects/ai/epam-cli/src/billing/KeychainKeyStore.ts)
- [ConfigResolver.ts](/home/bjerome/projects/ai/epam-cli/src/config/ConfigResolver.ts)
- [SessionStore.ts](/home/bjerome/projects/ai/epam-cli/src/context/SessionStore.ts)
- [orchestrate.ts](/home/bjerome/projects/ai/epam-cli/src/cli/commands/orchestrate.ts)
- [pricing.ts](/home/bjerome/projects/ai/epam-cli/src/billing/pricing.ts)
- [phase.ts](/home/bjerome/projects/ai/epam-cli/src/cli/commands/phase.ts)
- [server.js](/home/bjerome/projects/ai/epam-cli/infra/backend-stub/server.js)
- [docker-compose.epam-cli.yml](/home/bjerome/projects/ai/epam-cli/docker-compose.epam-cli.yml)
- [ProviderCredentialStore.test.ts](/home/bjerome/projects/ai/epam-cli/test/unit/auth/ProviderCredentialStore.test.ts)

## PRD Follow-up

Low-priority backlog items added:

- `EPAM-049` Disable dead default MCP example server
- `EPAM-050` Remove misleading provider-slot warning at REPL init

Normalized coverage and traceability source:

- [quality-summary.json](/home/bjerome/projects/ai/epam-cli/orchestrations/logs/quality-summary.json)

Current rollup snapshot:

- total stories: `60`
- POC passed: `12`
- POC partial: `3`
- POC failed: `2`
- not tested: `43`

PRD reference:

- [prd.json](/home/bjerome/projects/ai/epam-cli/orchestrations/prd.json)

## Conclusion

This POC shows that EPAM CLI is already credible as an internal governed AI delivery platform. It has enough working surface area to support demos, technical evaluation, and continued product hardening. The remaining issues are now narrower and mostly operator-experience refinements rather than fundamental architectural blockers.
