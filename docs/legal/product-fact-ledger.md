# CodeForge Product Fact Ledger

**Audit Date**: September 10, 2026
**Auditor**: Primary Audit Agent (Pass 1)
**Methodology**: Repository-wide static analysis, build inspection, and empirical runtime verification.

---

## 1. Executive Summary & Lifecycle Classifications

This ledger documents the empirical technical status of all major CodeForge product capabilities. Every component is classified into one of four lifecycle states:
- **SHIPPING**: Included in released or certifiable desktop/CLI distributions, active by default or user-selectable in user-facing builds.
- **STAGING / PRE-COMMERCIAL**: Built in codebase, operational in staging/dev environments, but not yet wired to live production infrastructure or commercial billing.
- **EXPERIMENTAL**: Code exists behind feature flags, partial implementations, or research harnesses not certified for daily-driver usage.
- **FUTURE**: Planned architecture, conceptual designs, or backlog items documented in specifications without complete runnable implementations.

---

## 2. Product Capability Ledger

| # | Component / Capability | Lifecycle Status | Repository Evidence | Operational Architecture | Legal & Compliance Relevance |
|---|---|---|---|---|---|
| 1 | **CodeForge Desktop** | **SHIPPING** | `apps/desktop/package.json`<br>`apps/desktop/src/main.ts`<br>`apps/desktop/release/win-unpacked/` | Packaged Electron 33.4.11 application for Windows (NSIS installer & Portable EXE), bundling React 19 UI, local loopback server, and SQLite storage. | Primary consumer-facing client; subject to desktop EULA, third-party binary notices, and local OS execution liabilities. |
| 2 | **CodeForge CLI** | **SHIPPING** | `packages/server/src/cli.ts`<br>`packages/core/src/index.ts` | Node.js command-line interface (`forge serve`, `forge run`) exposing headless runtime and task automation. | Direct developer interface; inherits local user permissions and shell execution authority. |
| 3 | **CodeForge Runtime Server** | **SHIPPING** | `packages/server/src/server.ts` | Loopback HTTP/WebSocket server listening on `127.0.0.1` (dynamic port); orchestrates agent sessions, tool dispatch, and streaming events. | Local IPC security boundary; processes prompt and tool payloads over unencrypted loopback HTTP. |
| 4 | **Cloud API Service** | **STAGING / PRE-COMMERCIAL** | `apps/cloud-api/src/server.ts`<br>`apps/cloud-api/src/routes/` | Express.js API server exposing auth endpoints, device sessions, cloud credit management, and hosted proxy interfaces. | Hosted multi-tenant cloud component; triggers GDPR/CCPA data controller obligations once deployed to production. |
| 5 | **Web Application** | **STAGING** | `apps/web/package.json`<br>`apps/web/src/` | Vite + React web client intended for browser-based session monitoring and cloud account management. | Web client; requires cookie banner, web privacy policy, and browser security disclosures if deployed. |
| 6 | **ForgeZero Firewall** | **SHIPPING** | `packages/forge-zero/src/zero-evaluator.ts`<br>`packages/forge-zero/src/rules.ts` | Zero-billing firewall enforcing model eligibility; fail-closed rejection of paid models and strictly prohibiting local LLM inference. | Central architectural safeguard against unintended API billing; forms the technical foundation for "Verified Free" claims. |
| 7 | **8-Bit Autonomous Agent Engine** | **SHIPPING** | `packages/eight-bit/src/agent.ts`<br>`packages/eight-bit/src/qualification/runner.ts` | Autonomous engineering agent loop supporting planning, tool dispatch, self-healing, calibration, and free-model qualification. | Autonomous execution risk; performs file edits, git commands, and shell execution without per-step human confirmation in full-auto mode. |
| 8 | **ForgeGreen Scheduler** | **SHIPPING** | `packages/forge-green/src/green-router.ts`<br>`packages/forge-green/src/carbon-grid.ts` | Carbon- and energy-aware task scheduling; computes time-of-use and grid carbon intensity heuristics to defer background jobs. | Subject to marketing claims substantiation; documentation explicitly disclaims verified carbon offset measurements. |
| 9 | **ForgeVerify Gate** | **SHIPPING** | `packages/workflow/src/completion-gate.ts`<br>`docs/forgeverify.md` | Deterministic verification engine executing user test suites, syntax linters, and contract assertions before certifying task completion. | Critical defense against hallucinated or broken code; gates the transition to the terminal `completed` state. |
| 10 | **GEMS Governance Mode** | **EXPERIMENTAL** | `GEMS_MODE.md`<br>`packages/permissions/src/gems.ts` | Enterprise governance and safety architecture providing multi-party policy enforcement and audit trails. | Advanced enterprise control layer; not yet active or required for standard single-user desktop release. |
| 11 | **Full-Auto Autonomous Mode** | **SHIPPING** | `FULL_AUTO.md`<br>`packages/agent/src/loop.ts` | Unattended task execution loop executing multi-turn tool commands (write, edit, shell, git) until completion gate passes. | Requires prominent AI Output Disclaimer and Terms of Service limitation of liability for unintended system modifications. |
| 12 | **Completion Gate Authority** | **SHIPPING** | `packages/workflow/src/completion-gate.ts` | Hard authority (`evaluateCompletion`) requiring verified evidence (test runs, diffs) before declaring completion; terminates as `blocked` on failure. | Enforces runtime correctness; prevents agent from falsely asserting success to user. |
| 13 | **OpenRouter OAuth PKCE Flow** | **SHIPPING** | `apps/desktop/src/openrouter-oauth-flow.ts` | Desktop loopback OAuth 2.0 with PKCE requesting user-authorized API key directly from OpenRouter. | Desktop BYOK integration; user maintains direct account relationship with OpenRouter. |
| 14 | **GitHub Cloud OAuth PKCE Flow** | **SHIPPING** | `apps/desktop/src/cloud-auth-flow.ts` | Desktop loopback OAuth flow connecting to CodeForge Cloud via GitHub OAuth. | Authenticates user device session to hosted cloud database; stores GitHub identity ID and email. |
| 15 | **Local SQLite Persistence** | **SHIPPING** | `packages/sessions/src/persistence.ts` | SQLite database storing local sessions, turns, work items, and tool execution events using `node:sqlite` or `better-sqlite3`. | Local storage on user disk; lacks automated TTL or session deletion endpoint (`RETENTION_POLICY_UNDEFINED`). |
| 16 | **Cloud PostgreSQL Persistence** | **STAGING / PRE-COMMERCIAL** | `packages/cloud-db/src/migrations.ts` | 7 migrations defining schemas for users, devices, credit ledgers, subscriptions, reservations, and hosted requests. | Multi-tenant cloud database; schema currently lacks automated retention policies or user account erasure cascades. |
| 17 | **Stripe Billing Integration** | **STAGING / PRE-COMMERCIAL** | `packages/cloud-billing/src/stripe-service.ts` | Integration supporting Checkout Sessions, Customer Portals, and webhooks; strictly restricts keys to `sk_test_` / `rk_test_`. | Pre-commercial test mode; live keys (`sk_live_`) are hard-blocked by code assertion until commercial clearance. |
| 18 | **Cloud Credit Ledger** | **STAGING / PRE-COMMERCIAL** | `packages/cloud-db/src/migrations.ts` | Database ledger tracking prepaid credits, reservations, and usage events (Free: 500k credits/mo, Pro: 5M credits/mo). | Virtual currency/credit mechanics; requires clear Terms regarding non-refundability, expiry, and commercial entitlements. |
| 19 | **Context Engine** | **SHIPPING** | `packages/context/src/` | AST parsing, symbol indexing, repository structure extraction, and prompt compression for model context windows. | Scans user repository files; processes proprietary source code to construct outbound LLM prompt payloads. |
| 20 | **Tools Execution Engine** | **SHIPPING** | `packages/tools/src/` | Local host tool implementations: file read/write, patch application, directory listing, ripgrep, and terminal process spawning. | High-privilege subsystem; executes shell commands on host operating system with user privileges. |
| 21 | **Local Secret Storage** | **SHIPPING** | `packages/secrets/src/storage.ts`<br>`apps/desktop/src/main.ts` | API keys and tokens encrypted at rest via Windows Data Protection API (`safeStorage` / DPAPI). | Security mechanism protecting stored credentials against unauthorized read by non-elevated host processes. |
| 22 | **Secret Redaction Subsystem** | **SHIPPING** | `packages/secrets/src/redaction.ts` | High-entropy token and known API key regex redaction applied to outgoing logs, UI events, and session history. | Prevents accidental leak of credentials into logs or provider prompt context. |
| 23 | **Model Registry** | **SHIPPING** | `packages/model-registry/src/models.ts` | Static and dynamic catalog of supported cloud LLM endpoints, context limits, pricing metadata, and zero-cost eligibility rules. | Authoritative mapping for model capabilities; establishes baseline pricing and tier validation. |
| 24 | **Provider Policy Gate** | **SHIPPING** | `packages/model-registry/src/provider-policy.ts` | Classification of providers into `permissive` vs `strict` privacy tiers; blocks data-logging providers under STRICT mode. | Privacy control enforcing user privacy preferences; restricts Google Unpaid services when strict privacy is enabled. |
| 25 | **Telemetry & Diagnostics** | **SHIPPING (LOCAL ONLY)** | `apps/desktop/src/telemetry.ts` | Diagnostics and error logging written strictly to local files in user data directory; NO remote telemetry pings. | High consumer privacy compliance; zero third-party telemetry egress in shipped desktop application. |
| 26 | **Provider Allowance Probing** | **SHIPPING** | `apps/desktop/src/main.ts`<br>`packages/eight-bit/src/qualification/runner.ts` | Automated transmission of minimal synthetic test prompts to OpenRouter/Google to verify active zero-cost allowance status. | Must comply with upstream API Terms prohibiting automated rate limit circumvention or abuse. |

---

## 3. Operational Data Boundary Summary

1. **Local-First Processing**: In standard Desktop operation without Cloud API sign-in, all session records, code ASTs, diffs, tool outputs, and encrypted credentials remain exclusively on the user's local disk (`%APPDATA%/CodeForge`).
2. **Network Egress Scope**:
   - Outbound HTTPS calls to model providers (OpenRouter, Google Gemini, Groq, etc.) containing prompt text and relevant code snippets.
   - Outbound loopback HTTP calls between the Electron front-end and the local Node.js runtime server (`127.0.0.1`).
   - Outbound HTTPS calls to GitHub / CodeForge Cloud ONLY when the user explicitly triggers cloud authentication.
3. **Telemetry & Tracking Absence**: CodeForge Desktop contains zero Google Analytics, PostHog, Mixpanel, Sentry, or third-party behavioral trackers.
