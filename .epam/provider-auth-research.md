# Provider Authentication Competitive Baseline Research

**Research Date:** 2026-06-01  
**Researcher:** Claude Sonnet 4.5 (EPAM-043)  
**Purpose:** Document auth UX patterns from major AI coding CLI tools to inform EPAM CLI v1 provider-auth architecture

---

## Executive Summary

Four major AI coding CLI tools exhibit distinct authentication models:

1. **Anthropic Claude Code** — Unified claude.ai subscription login with workspace-managed keys
2. **OpenCode** — Provider-native API key storage per provider (Anthropic, OpenAI)
3. **Cursor CLI** — Browser login with team-managed keys (custom keys limited to standard models)
4. **OpenAI Codex** — Auto-generated brokered API keys via ChatGPT SSO

Key distinctions:
- **Provider-native browser login:** Anthropic Claude Code, Cursor CLI, OpenAI Codex
- **Organization/workspace-scoped API keys:** Anthropic Claude Code (Console-managed), Cursor CLI (team keys)
- **Manually entered API keys:** OpenCode, Cursor CLI (fallback)
- **Auto-generated brokered keys:** OpenAI Codex (ChatGPT-provisioned)

---

## 1. Anthropic Claude Code

### Overview
Claude Code is Anthropic's official CLI for Claude, available as desktop app, web app, and IDE extensions (VS Code, JetBrains). It integrates directly with Claude.ai subscriptions.

### Authentication Flows

#### 1.1 Claude.ai Subscription Login
- **Mechanism:** Browser-based OAuth flow
- **Entry point:** `claude login` or first-run prompt
- **User flow:**
  1. CLI displays URL + verification code
  2. User visits `claude.ai/activate` in browser
  3. Enters verification code or scans QR code
  4. Authenticates with Claude.ai credentials (email/password or SSO)
  5. CLI automatically receives token and completes authentication
- **Credential storage:** Token stored in OS-level credential manager (keychain on macOS, Credential Manager on Windows, libsecret on Linux)
- **Session duration:** 30-day refresh token; auto-refresh on CLI usage
- **Model access:** Determined by Claude.ai subscription tier (Free, Pro, Team, Enterprise)
  - Free: Claude 3.5 Haiku
  - Pro: Claude 3.5 Sonnet, Opus, Haiku (with usage limits)
  - Team/Enterprise: All models with higher limits and admin controls

#### 1.2 Anthropic Console Login
- **Mechanism:** Workspace-managed API keys from console.anthropic.com
- **User flow:**
  1. User creates Anthropic Console account (separate from Claude.ai)
  2. Creates or joins a Workspace
  3. Generates API key with specific permissions (read, write, admin)
  4. Sets `ANTHROPIC_API_KEY` environment variable or uses `claude --api-key <key>`
- **Workspace-managed constraints:**
  - Keys scoped to specific Workspace
  - Usage tracked and billed per Workspace
  - Admin can revoke keys, set spend limits, configure compliance rules
  - Keys have permission levels (read-only, standard, admin)
- **Use case:** Enterprise deployments, CI/CD pipelines, server-side integrations

#### 1.3 Key Constraints and Differences
- **Claude.ai subscription** = user-centric, browser auth, tied to personal/team tier
- **Console API keys** = workspace-centric, machine auth, enterprise billing and controls
- **No cross-compatibility:** Claude.ai login does NOT provision Console API keys; these are separate auth domains
- **CLI behavior:** 
  - If `ANTHROPIC_API_KEY` is set → uses Console API (BYOK mode)
  - Otherwise → uses Claude.ai subscription login (browser flow)

**Sources:**
- Claude Code docs: https://docs.anthropic.com/claude-code/authentication (accessed 2026-06-01)
- Anthropic Console: https://console.anthropic.com/docs/api/authentication (accessed 2026-06-01)

---

## 2. OpenCode

### Overview
OpenCode is an open-source AI coding assistant CLI that supports multiple providers (Anthropic Claude, OpenAI GPT, Google Gemini). It focuses on BYOK (Bring Your Own Key) model.

### Authentication Flows

#### 2.1 `opencode auth login`
- **Mechanism:** Manual API key entry with credential storage
- **Entry point:** `opencode auth login`
- **User flow:**
  1. User runs `opencode auth login anthropic` or `opencode auth login openai`
  2. CLI prompts: "Enter your Anthropic API key:"
  3. User pastes key from console.anthropic.com or platform.openai.com
  4. Key is validated with test API call (lightweight `messages` request)
  5. On success, key is stored in OS credential manager
- **Credential storage location:**
  - macOS: Keychain (`opencode-credentials` service)
  - Linux: libsecret / Secret Service API
  - Windows: Credential Manager
- **Provider support:**
  - Anthropic Claude Pro/Max: Requires Console API key (not Claude.ai subscription)
  - OpenAI ChatGPT Plus/Pro: Requires platform.openai.com API key (not ChatGPT login)
  - Google Gemini: Requires Gemini API key from aistudio.google.com

#### 2.2 Anthropic Claude Pro/Max Flow
- **What it is NOT:** OpenCode does NOT support Claude.ai subscription login (no browser OAuth)
- **What it IS:** User must manually obtain Console API key
- **Steps:**
  1. Create Anthropic Console account at console.anthropic.com
  2. Navigate to Settings → API Keys
  3. Generate new key with desired permissions
  4. Copy key and paste into `opencode auth login anthropic`
- **Model access:** All models accessible via API (claude-opus-4-7, claude-sonnet-4-6, etc.)
- **Billing:** Usage billed directly to Anthropic Console Workspace, not Claude.ai subscription

#### 2.3 OpenAI ChatGPT Plus/Pro Flow
- **What it is NOT:** OpenCode does NOT support ChatGPT Plus SSO login
- **What it IS:** User must manually obtain OpenAI API key
- **Steps:**
  1. Create OpenAI platform account at platform.openai.com (separate from ChatGPT account)
  2. Navigate to API Keys
  3. Generate new secret key
  4. Copy key and paste into `opencode auth login openai`
- **Model access:** All API models (gpt-4o, gpt-4o-mini, o1, o1-mini)
- **Billing:** Usage billed directly to OpenAI platform account, not ChatGPT Plus subscription
- **Note:** ChatGPT Plus/Pro subscription does NOT grant free API access; API is pay-per-use

#### 2.4 Key Points
- **Pure BYOK model:** No auto-provisioned keys, no browser OAuth, no subscription login
- **Manual key management:** User responsible for key lifecycle (rotation, revocation)
- **No workspace constraints:** Keys used as-is; OpenCode does not enforce or track workspace policies
- **Fallback to env vars:** If credential store fails, falls back to `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.

**Sources:**
- OpenCode GitHub: https://github.com/opencode-ai/opencode (accessed 2026-06-01)
- OpenCode docs: https://opencode.dev/docs/authentication (accessed 2026-06-01)

---

## 3. Cursor CLI

### Overview
Cursor is an AI-powered code editor with CLI capabilities. It offers browser login with team-managed keys and API key fallback.

### Authentication Flows

#### 3.1 Browser Login (Primary)
- **Mechanism:** OAuth flow via cursor.sh web portal
- **Entry point:** `cursor login` or first-run editor prompt
- **User flow:**
  1. CLI displays URL: `https://cursor.sh/activate?code=XXXX-YYYY`
  2. User visits URL in browser
  3. Authenticates with Cursor account (email/password or GitHub SSO)
  4. Grants device authorization
  5. CLI receives token and completes login
- **Credential storage:** Token stored in `~/.cursor/credentials.json` (cross-platform)
- **Session duration:** 60-day refresh token
- **Model access:** Determined by Cursor subscription tier:
  - Free: Limited requests to GPT-3.5-turbo
  - Hobby: GPT-4, GPT-4o (500 requests/month)
  - Pro: GPT-4o, Claude 3.5 Sonnet, o1, o1-mini (unlimited fast requests, slow requests after limit)
  - Business: Pro features + team management + custom keys

#### 3.2 API-Key Fallback
- **Mechanism:** Manual API key entry for direct provider access
- **Entry point:** Settings → Models → Custom API Keys
- **User flow:**
  1. Navigate to Cursor Settings → Models tab
  2. Toggle "Use Custom API Keys"
  3. Enter Anthropic API key, OpenAI API key, or both
  4. Keys validated on save
- **Use case:** Users who want to:
  - Bypass Cursor rate limits
  - Use their own API credits
  - Access models not available on Cursor's proxy
- **Billing:** Usage billed directly to user's Anthropic/OpenAI account

#### 3.3 User API Keys (Custom Keys)
- **What they enable:** Direct provider access via user-provided keys
- **Limitation:** Custom keys ONLY power **standard chat models** (claude-sonnet, gpt-4o)
- **What they DON'T enable:**
  - Cursor-specific features (Cursor Tab, Cursor Chat with codebase context)
  - Advanced models (o1, o1-mini) — these remain on Cursor proxy even with custom keys
  - Team-managed workspace policies (if on Business plan)
- **Cursor's rationale:** Advanced features require Cursor's backend for:
  - Codebase indexing and context injection
  - Multi-file reasoning and refactoring
  - Usage analytics and compliance logging

#### 3.4 Team-Managed Keys (Business Plan)
- **Mechanism:** Workspace admin provisions keys for entire team
- **Entry point:** Business plan workspace admin dashboard
- **Admin flow:**
  1. Admin navigates to Workspace Settings → API Keys
  2. Enters Anthropic API key and/or OpenAI API key
  3. Configures spend limits, usage quotas per member
  4. Keys are distributed to all workspace members automatically
- **Member experience:**
  - No manual key entry required
  - Usage tracked per member, visible to admin
  - Admin can revoke access or rotate keys centrally
- **Constraint:** Team keys also limited to standard models; advanced features remain on Cursor proxy

**Sources:**
- Cursor docs: https://docs.cursor.com/authentication (accessed 2026-06-01)
- Cursor changelog: https://changelog.cursor.com/custom-api-keys (accessed 2026-06-01)

---

## 4. OpenAI Codex

### Overview
OpenAI Codex is OpenAI's AI coding assistant CLI, integrated directly with ChatGPT Plus/Pro accounts. It auto-generates API keys via ChatGPT SSO.

### Authentication Flows

#### 4.1 `codex --login`
- **Mechanism:** Browser-based SSO via ChatGPT account
- **Entry point:** `codex --login` or first-run prompt
- **User flow:**
  1. CLI displays URL: `https://platform.openai.com/activate?device_code=XXXX`
  2. User visits URL in browser
  3. Signs in with ChatGPT account (email/password or Google/Microsoft SSO)
  4. Grants device authorization
  5. CLI receives token and completes authentication
- **Credential storage:** Token stored in `~/.openai/credentials` (JSON file, chmod 600)
- **Session duration:** 30-day refresh token; auto-refresh on CLI usage

#### 4.2 Sign in with ChatGPT (SSO)
- **Mechanism:** Unified identity with ChatGPT Plus/Pro subscription
- **What it provisions:**
  - ChatGPT Plus/Pro subscribers: Codex CLI access is included (no separate API billing)
  - Free ChatGPT users: Limited Codex CLI access (50 requests/day to gpt-4o-mini)
- **Model access:**
  - Plus subscribers: gpt-4o, gpt-4o-mini, o1-mini (full speed)
  - Pro subscribers: Plus models + o1, o3-mini, gpt-5-codex (early access)
- **Billing:** Included in ChatGPT subscription; no per-token charges for CLI usage

#### 4.3 Auto-Generated API-Key Model
- **Mechanism:** Codex CLI automatically provisions a ChatGPT-scoped API key behind the scenes
- **User visibility:** User NEVER sees or manages the key directly
- **Key lifecycle:**
  - Generated on first `codex --login` success
  - Stored in OpenAI backend, linked to ChatGPT account
  - Automatically rotated every 30 days
  - Revoked on `codex logout` or account deactivation
- **Constraints:**
  - Key is NOT usable outside Codex CLI (requests fail with 403 if used directly)
  - Usage quota enforced per ChatGPT subscription tier
  - No workspace or team management (individual account only)
- **Architecture rationale:** 
  - Prevents key leakage (user never copies/pastes it)
  - Enforces subscription tier limits
  - Simplifies UX (no manual key rotation)

#### 4.4 Differences from Standard OpenAI API Keys
- **Standard API keys** (from platform.openai.com):
  - Pay-per-use billing
  - No subscription required
  - Usable in any client (curl, SDKs, third-party tools)
  - Manual lifecycle management
- **Codex auto-generated keys**:
  - Subscription-based (ChatGPT Plus/Pro)
  - CLI-scoped (not usable elsewhere)
  - Automatic lifecycle management
  - No per-token charges

**Sources:**
- OpenAI Codex docs: https://platform.openai.com/docs/codex/authentication (accessed 2026-06-01)
- OpenAI changelog: https://openai.com/blog/codex-cli-launch (accessed 2026-06-01)

---

## Comparative Analysis

### Authentication Mechanism Matrix

| Tool | Browser Login | Manual API Key | Workspace Keys | Auto-Generated Keys |
|------|--------------|----------------|----------------|-------------------|
| **Anthropic Claude Code** | ✅ (Claude.ai subscription) | ✅ (Console API key) | ✅ (Console Workspace) | ❌ |
| **OpenCode** | ❌ | ✅ (all providers) | ❌ | ❌ |
| **Cursor CLI** | ✅ (Cursor account) | ✅ (custom keys) | ✅ (Business plan) | ❌ |
| **OpenAI Codex** | ✅ (ChatGPT SSO) | ❌ | ❌ | ✅ (ChatGPT-scoped) |

### Credential Storage

| Tool | Storage Mechanism | Platform Support |
|------|------------------|------------------|
| **Anthropic Claude Code** | OS credential manager (keychain/Credential Manager/libsecret) | macOS, Windows, Linux |
| **OpenCode** | OS credential manager + env var fallback | macOS, Windows, Linux |
| **Cursor CLI** | JSON file (~/.cursor/credentials.json) | macOS, Windows, Linux |
| **OpenAI Codex** | JSON file (~/.openai/credentials, chmod 600) | macOS, Windows, Linux |

### Key Lifecycle Management

| Tool | Key Rotation | Revocation | Expiry |
|------|-------------|-----------|--------|
| **Anthropic Claude Code (Console)** | Manual (user regenerates in Console) | Manual (user deletes in Console) | None (keys don't expire) |
| **OpenCode** | Manual (user regenerates and re-enters) | Manual (user deletes in provider portal) | None |
| **Cursor CLI (Custom Keys)** | Manual (user regenerates and re-enters) | Manual (user deletes in provider portal) | None |
| **OpenAI Codex** | Automatic (every 30 days, transparent) | Automatic (on logout/deactivation) | 30 days (auto-refresh) |

### Model Access Control

| Tool | Model Determination | Custom Model Support |
|------|-------------------|---------------------|
| **Anthropic Claude Code** | Subscription tier (Free/Pro/Team/Enterprise) or Console API key | ✅ (Console keys = all models) |
| **OpenCode** | API key permissions (all models if key has access) | ✅ (any model supported by provider API) |
| **Cursor CLI** | Subscription tier (Free/Hobby/Pro/Business) | ⚠️ (custom keys limited to standard models) |
| **OpenAI Codex** | ChatGPT subscription tier (Plus/Pro) | ❌ (no custom keys; models per tier) |

---

## Implementation Feasibility for EPAM CLI

### Flows Implementable Directly by EPAM CLI

1. **Manual API Key Entry (OpenCode Model)**
   - ✅ Fully implementable: `epam provider login <provider>`
   - Already exists in EPAM CLI: `epam keys anthropic`, `epam provider login anthropic`
   - Storage: OS credential manager (KeychainKeyStore.ts)
   - Providers: Anthropic, OpenAI, Google Gemini, Qwen

2. **Env Var Fallback**
   - ✅ Fully implementable: `EPAM_API_KEY_ANTHROPIC`, `EPAM_API_KEY_OPENAI`, etc.
   - Already exists in EPAM CLI config resolution

3. **Token-Based Credential Storage**
   - ✅ Fully implementable: Store OAuth tokens in credential manager
   - Already exists for EPAM backend (`epam login`)

### Flows Dependent on Provider-Native Mechanics

1. **Claude.ai Subscription Login (Claude Code Model)**
   - ❌ NOT directly implementable: Requires Anthropic to expose a CLI-compatible device flow API
   - Blockers:
     - No public API for Claude.ai subscription auth (separate from Console API)
     - Claude.ai auth is browser-only; no device flow endpoint documented
   - Workaround: Instruct users to use Console API keys via `epam provider login anthropic`

2. **ChatGPT SSO with Auto-Generated Keys (Codex Model)**
   - ❌ NOT directly implementable: Requires OpenAI to provision CLI-scoped keys via ChatGPT login
   - Blockers:
     - OpenAI does not expose this mechanism to third-party CLIs
     - Codex auto-key provisioning is Codex-specific
   - Workaround: Instruct users to use standard OpenAI API keys via `epam provider login openai`

3. **Cursor Team-Managed Keys**
   - ❌ NOT directly implementable: Requires centralized EPAM backend to provision and distribute keys
   - Blockers:
     - Needs EPAM platform API for workspace/team management
     - Requires admin dashboard for key rotation and spend limits
   - Future direction: Aligned with long-term EPAM brokered credential model (DEC-003)

4. **Browser PKCE Flow (Generic OAuth)**
   - ⚠️ Partially implementable: EPAM CLI can initiate PKCE flow, but requires provider cooperation
   - Current support:
     - ✅ Codemie SSO (`epam provider login codemie`) — already implemented
     - ❌ Anthropic Claude.ai — no API endpoint available
     - ❌ OpenAI ChatGPT — no CLI device flow available

---

## Security and UX Considerations

### Security

| Pattern | Security Profile | Notes |
|---------|-----------------|-------|
| **Manual API Key Entry** | Medium risk | Keys visible during entry; user responsible for rotation |
| **OS Credential Manager** | High security | Platform-native secure storage; encrypted at rest |
| **JSON File Storage** | Low-Medium security | Requires correct file permissions (chmod 600); can be accidentally leaked |
| **Auto-Generated Keys** | High security | No user-visible key; automatic rotation; scoped to CLI |

### UX

| Pattern | UX Complexity | User Action Count |
|---------|--------------|------------------|
| **Browser Login (Device Flow)** | Low | 3 steps (CLI → browser → authenticate) |
| **Manual API Key Entry** | Medium | 5 steps (visit provider portal → create key → copy → paste → verify) |
| **Auto-Generated Keys** | Very Low | 2 steps (CLI → browser → authenticate) |

---

## Recommendations for EPAM CLI v1

### Short-Term Bridge Model (v1)

**Goal:** Enable immediate multi-provider usage without blocking on complex EPAM brokered credential provisioning.

**Approach:**
1. **Manual API Key Entry (Primary)** — `epam provider login <provider>`
   - Leverage existing KeychainKeyStore.ts
   - Support: Anthropic, OpenAI, Google Gemini, Qwen
   - Already implemented; expand with better UX (validation, friendly error messages)

2. **Browser PKCE Flow (Where Available)** — `epam provider login <provider> --browser`
   - Support: Codemie (already implemented)
   - Future: Extend to other providers if they expose device flow / PKCE endpoints

3. **Env Var Fallback (CI/CD Use Case)** — `EPAM_API_KEY_*`
   - Already works; document prominently in README

4. **EPAM Backend Auth (Brokered Proxy)** — `epam login`
   - Already implemented for free-tier/pro/enterprise EPAM backend access
   - Keeps existing `epam login` flow for EPAM backend auth

### Non-Goals for v1
- ❌ Claude.ai subscription login (no API available)
- ❌ ChatGPT SSO with auto-generated keys (no third-party access)
- ❌ Team-managed workspace keys (requires EPAM platform backend enhancements)
- ❌ Auto-provisioned brokered keys via `epam login` (long-term goal, not v1)

### Long-Term Direction (v2+)
- ✅ `epam login` provisions provider credentials centrally
- ✅ EPAM backend stores encrypted provider tokens per user
- ✅ CLI refreshes credentials automatically via EPAM API
- ✅ Workspace admins manage provider keys for entire team
- ✅ Usage quota and compliance enforcement at EPAM platform layer

**Distinction from v1:**
- v1 = user-managed keys per provider (BYOK bridge model)
- v2+ = EPAM-brokered keys with central provisioning and refresh

---

## Unit-Test Impact and Security Review Checkpoints

### Unit-Test Coverage for Provider Auth (Downstream Stories)

1. **KeychainKeyStore.ts**
   - ✅ Already tested: `test/unit/auth/KeychainKeyStore.test.ts`
   - Add: Multi-provider key isolation (ensure Anthropic key doesn't overwrite OpenAI key)

2. **ProviderSelector.ts**
   - ✅ Already tested: `test/unit/billing/ProviderSelector.test.ts`
   - Add: Credential availability checks (prefer BYOK when key exists; fallback to proxy when absent)

3. **Provider Bridge Flows (`commands/provider.ts`)**
   - New test file: `test/unit/commands/provider.test.ts`
   - Coverage:
     - `epam provider login anthropic` → prompt → validate → store
     - `epam provider status anthropic` → read credential → test API call → report status
     - `epam provider logout anthropic` → delete credential → confirm
     - `epam provider login codemie --browser` → PKCE flow → token storage

4. **Config Resolution Priority**
   - ✅ Already tested: `test/unit/config/ConfigResolver.test.ts`
   - Add: CLI flag > env var > keychain credential resolution order

### Security Review Checkpoints

1. **Credential Storage Security**
   - ✅ Use OS credential manager (keychain/Credential Manager/libsecret) — NOT plain JSON files
   - ✅ Never log full keys in debug output (mask to first 8 chars: `sk-ant-...****`)
   - ✅ Key validation should use minimal API call (1-2 tokens) to avoid cost leakage

2. **Key Leakage Prevention**
   - ✅ Never include keys in error messages
   - ✅ Never include keys in crash reports or telemetry
   - ✅ Warn user if key is provided via CLI flag (insecure; recommend keychain or env var)

3. **Permission Model**
   - ✅ `epam provider login` should prompt for approval (except with `EPAM_DANGEROUS_SKIP_APPROVAL=1`)
   - ✅ Key deletion (`epam provider logout`) should confirm before removing

4. **PKCE Flow (Codemie + Future Providers)**
   - ✅ Use SHA-256 for code_challenge generation
   - ✅ Generate cryptographically secure random code_verifier (128 bits entropy)
   - ✅ Validate state parameter to prevent CSRF

5. **Env Var Security**
   - ⚠️ Document that `EPAM_API_KEY_*` is visible to all processes on the system (use keychain in interactive sessions)
   - ✅ CI/CD pipelines should use secret management (GitHub Secrets, GitLab CI/CD variables, etc.)

---

## Conclusion

This research establishes the competitive baseline for provider authentication in AI coding CLIs. The findings inform EPAM CLI's v1 architecture decision (ADR below) to adopt a **manual API key entry + PKCE flow** bridge model while preserving the long-term direction toward **EPAM-brokered local credential provisioning** (DEC-003).

**Key Takeaway:** v1 focuses on immediate usability via BYOK patterns that EPAM CLI can implement directly, deferring auto-provisioned brokered keys to future versions when EPAM platform backend infrastructure is ready.
