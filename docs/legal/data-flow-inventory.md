# CodeForge Data Flow Inventory & Retention Audit

**Audit Date**: September 10, 2026
**Auditor**: Primary Audit Agent (Pass 1)
**Standard**: GDPR Art. 30 (Records of Processing Activities), CCPA/CPRA Data Inventory, SOC 2 Data Classification.

---

## 1. Executive Summary & Core Architectural Finding

CodeForge operates under a dual-mode data architecture:
1. **Desktop / Local-First Mode (Shipping Baseline)**: Processes source code, user instructions, session history, and credentials locally. Egress is restricted to direct outbound HTTPS API calls from the user's workstation to user-selected LLM providers (BYOK). No centralized telemetry or session streaming to CodeForge servers occurs.
2. **Cloud-Authenticated Mode (Staging / Pre-Commercial)**: Enables cloud credit management, device session syncing, and hosted execution. When connected, account metadata, billing IDs, and hosted request logs are persisted in multi-tenant PostgreSQL databases.

> [!WARNING]
> **Key Finding: `RETENTION_POLICY_UNDEFINED`**
> Neither the local SQLite runtime nor the hosted PostgreSQL database schema defines an automated Time-To-Live (TTL), periodic log purging routine, or user-initiated deletion endpoint (`DELETE /api/sessions/:id` is missing in the local server; no account erasure cascade exists in `cloud-db`).
> - **Architectural Deficiency**: Confirmed across local and cloud codebases.
> - **Statutory Status**: Currently non-critical for local unauthenticated open-source CLI/Desktop use (data remains on user disk under user control). However, this constitutes an immediate commercial launch blocker for hosted cloud services in jurisdictions mandating erasure rights (GDPR Art. 17, CCPA/CPRA § 1798.105).

---

## 2. Comprehensive Data Category Map

| Data Category | Data Elements | Source | Local Storage Location | Cloud / Remote Storage | Network Egress & Recipients | Retention Mechanism |
|---|---|---|---|---|---|---|
| **User Code & Workspaces** | File contents, AST representations, git diffs, file trees, syntax errors. | Local user file system. | Local disk cache; SQLite `events` and `turns` tables. | In cloud mode: hosted session logs and verification diffs. | Direct outbound HTTPS to selected LLM APIs (OpenRouter, Google, Groq). | **Indefinite** on local disk until user manually deletes SQLite file or workspace. |
| **User Prompts & Instructions** | Natural language instructions, engineering task descriptions, system prompts. | User keyboard input in UI / CLI. | SQLite `turns` table (`prompt` column). | In cloud mode: `hosted_requests` table (`payload` column). | Outbound HTTPS to LLM APIs; loopback HTTP to `127.0.0.1`. | **Indefinite**. No automated session expiration or rotation. |
| **Model Completions & Diffs** | LLM response tokens, tool call parameters, generated code patches. | Upstream LLM responses. | SQLite `turns` table (`response` column), SQLite `events`. | In cloud mode: `hosted_requests` and `verification_evidence`. | Streamed over loopback WebSocket to Electron desktop renderer. | **Indefinite**. Persisted locally in session database. |
| **API Keys & Credentials** | OpenRouter API keys, Google Gemini keys, Groq keys, custom provider tokens. | User configuration / OAuth PKCE callback. | Encrypted on disk using Windows DPAPI (`safeStorage`); in-memory runtime cache. | **NEVER** transmitted to CodeForge Cloud in BYOK mode. | Transmitted in `Authorization: Bearer <key>` headers to upstream LLM APIs. | Persisted in encrypted store until user clears key in Desktop Settings. |
| **Identity & Authentication** | GitHub User ID, GitHub username, email address, OAuth access tokens. | GitHub OAuth PKCE flow (`apps/desktop/src/cloud-auth-flow.ts`). | Local Desktop state (`auth.json`); encrypted tokens. | Cloud DB `users`, `identities`, `device_sessions`, `oauth_transactions`. | HTTPS to `github.com/login/oauth` and `api.codeforge.dev`. | **Indefinite** in Cloud DB. No account self-deletion route exists. |
| **Billing & Commercial** | Stripe Customer ID, Subscription ID, Payment Intent status, credit balances. | Stripe Checkout webhooks (`packages/cloud-billing`). | None locally. | Cloud DB `subscriptions`, `credit_ledger`, `billing_webhooks`. | HTTPS to `api.stripe.com` (restricted to Stripe Test Mode). | Retained in Stripe and Cloud DB according to statutory financial records rules. |
| **Tool Execution Events** | Process execution logs, terminal stdout/stderr, git commit hashes. | Host OS execution via `packages/tools`. | SQLite `events` table; local debug log files. | In cloud mode: `hosted_requests` execution metadata. | Displayed in UI; masked by `@codeforge/secrets` regex redaction before logging. | **Indefinite** in session database; debug log files overwrite on new runs. |
| **Diagnostics & Telemetry** | OS version, Electron version, startup errors, crash stack traces. | Electron runtime (`apps/desktop/src/telemetry.ts`). | Local log files in `%APPDATA%/CodeForge/logs/`. | **NONE**. No remote telemetry pings are transmitted. | Zero outbound network egress for telemetry. | Overwritten or appended locally; user can delete logs manually. |

---

## 3. Storage Architecture Deep Dive

### A. Local Persistence (`packages/sessions/src/persistence.ts`)
- **Engine**: SQLite via `node:sqlite` (Node.js >= 22.5) or `better-sqlite3` native addon fallback.
- **Database Schema**:
  - `sessions`: id, title, created_at, updated_at, status, working_directory.
  - `turns`: id, session_id, turn_number, prompt, response, model, cost, tokens_in, tokens_out.
  - `work_items`: id, session_id, title, status, plan.
  - `events`: id, session_id, event_type, payload (JSON), timestamp.
- **Security & Access**: File stored with standard OS user file permissions. Unencrypted database file, but sensitive tokens within events are redacted prior to write.
- **Deletion Path**: **Missing**. The server exposes endpoints to read and create sessions, but implements no `DELETE /api/sessions/:id` endpoint.

### B. Cloud Persistence (`packages/cloud-db/src/migrations.ts`)
- **Engine**: PostgreSQL (production target) / SQLite (staging/development harness).
- **Database Tables (7 Migrations)**:
  1. `users`, `identities`, `device_sessions`, `plans`, `subscriptions`, `entitlements`.
  2. `credit_ledger`, `usage_events`, `reservations`.
  3. `hosted_requests`.
  4. `billing_webhooks`.
  5. `account_settings`, `abuse_events`.
  6. `oauth_transactions`, `desktop_auth_codes`, `github_installations`, `publications`.
  7. `verification_plans`, `verification_evidence`.
- **Deletion Path**: **Missing**. No foreign key cascades or soft-delete triggers are configured to purge user data or associated `hosted_requests` upon user request.

---

## 4. Network Egress & Third-Party Transmissions

```
                       ┌──────────────────────────────────────────────┐
                       │           Local Host Environment             │
                       │                                              │
                       │   ┌────────────────┐   Loopback HTTP/WS      │
                       │   │ Electron UI    │ ◄──────────────────►    │
                       │   └────────────────┘   127.0.0.1:<dynamic>   │
                       │            ▲                                 │
                       │            │ IPC                             │
                       │            ▼                                 │
                       │   ┌────────────────┐                         │
                       │   │ Node Runtime   │                         │
                       │   │ Server Engine  │                         │
                       │   └────────┬───────┘                         │
                       │            │                                 │
                       └────────────┼─────────────────────────────────┘
                                    │ Direct Outbound HTTPS (TLS 1.3)
             ┌──────────────────────┼──────────────────────┐
             │                      │                      │
             ▼                      ▼                      ▼
  ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
  │ Upstream LLM APIs  │ │ CodeForge Cloud    │ │ Identity & Billing │
  │                    │ │ (Optional Sign-In) │ │                    │
  │ • OpenRouter       │ │ • api.codeforge.   │ │ • GitHub OAuth     │
  │ • Google Gemini    │ │   dev              │ │ • Stripe (Test)    │
  │ • Groq / Cloudflare│ │ • Session Sync     │ │                    │
  │ • Anthropic/OpenAI │ │ • Hosted Proxy     │ │                    │
  └────────────────────┘ └────────────────────┘ └────────────────────┘
```

1. **Loopback Traffic**: Confined strictly to `127.0.0.1` binding. No external interfaces (`0.0.0.0`) are opened.
2. **LLM Inference Traffic**: In BYOK mode, prompt payloads containing source code and instructions pass directly from user workstation to LLM provider endpoints over TLS. No intermediary CodeForge proxy inspects this traffic.
3. **Secret Redaction Barrier**: Before prompts are constructed or events are emitted, `packages/secrets/src/redaction.ts` scrubs strings against patterns for AWS keys, GitHub tokens, OpenAI keys, OpenRouter keys, and generic high-entropy hex strings.

---

## 5. Regulatory Applicability Analysis

### A. GDPR (EU) / UK GDPR
- **Current Desktop (Unauthenticated)**: CodeForge acts neither as Controller nor Processor; user processes data locally on their own equipment (household/purely personal or internal business exemption applies to tool distributor).
- **Cloud API / Staging**: Once user creates a cloud account, CodeForge becomes a **Data Controller** for account metadata (GitHub ID, email) and a **Data Processor** for hosted code requests.
  - **GDPR Art. 17 (Right to Erasure)**: Immediate blocker for commercial launch of Cloud API. A complete account and data deletion pipeline must be deployed prior to admitting EEA/UK users.
  - **GDPR Art. 32 (Security of Processing)**: Desktop DPAPI credential encryption satisfies state-of-the-art standards for local client storage.

### B. CCPA / CPRA (California)
- CodeForge does not sell or share personal information for cross-context behavioral advertising.
- Consumer right to delete (§ 1798.105) requires automated deletion request fulfillment mechanism prior to serving California residents commercially.

---

## 6. Remediation Requirements Prior to Commercial Release

1. **Local Server Endpoint**: Implement `DELETE /api/sessions/:id` and a "Clear All History" button in Desktop Settings that physically removes or vacuums SQLite records.
2. **Cloud Account Erasure**: Implement `POST /api/account/delete` in `apps/cloud-api` executing transactional cascade deletion across `users`, `identities`, `device_sessions`, `hosted_requests`, and `verification_evidence`.
3. **Automated Cloud TTL**: Configure database scheduled jobs (e.g., pg_cron or worker loop) to purge raw `hosted_requests` and `usage_events` older than 30 days (`[BUSINESS DECISION REQUIRED]`).
