# Architecture Decision Record: CodeForge Cloud

**Status**: Accepted  
**Checked date**: 2026-08-29  
**Authors**: CodeForge Core Architecture Team  

---

## 1. Context and Problem Statement

CodeForge has certified a zero-cost desktop platform supporting Direct/BYOK provider connectivity. To enable a frictionless onboarding experience for mainstream developers, CodeForge must provide a Hosted Cloud tier where users can download the application, sign in with GitHub, open any repository, and immediately run autonomous coding tasks without configuring API keys or creating 3rd-party provider accounts. Simultaneously, the open, direct BYOK path must remain completely functional and accountless.

---

## 2. Decision Summary

| Dimension | Selected Technology | Primary Rationale |
| :--- | :--- | :--- |
| **Auth** | GitHub OAuth + PKCE with Loopback Listener & Signed JWT Sessions | Eliminates client secrets from desktop distribution; leverages standard OAuth 2.0 PKCE (RFC 7636) with developer-native GitHub identity. |
| **Database** | PostgreSQL Schema (Node/pg) with Abstracted In-Memory/SQLite Driver for Deterministic Test Isolation | Production-grade relational consistency and ACID transactions for credit ledger, with embedded test runner capability. |
| **Hosting** | Node.js / Fastify / HTTP Server (Containerized / Fly.io / Cloudflare / Node runtime) | Low latency, strict ESM TypeScript alignment with monorepo packages, streaming SSE compatibility. |
| **Gateway** | Native TypeScript AI Gateway with Upstream Multi-Provider Routing | Eliminates external gateway dependencies, integrates server-side ForgeZero natively, unifies token/cost reconciliation. |
| **Billing** | Stripe Billing (Test Mode Only) Subscriptions, Checkout Sessions & Webhooks | Server-authoritative idempotency, webhook signature verification, automatic portal lifecycle management. |
| **Secrets** | Envelope Encryption & OS Secure Storage (DPAPI/safeStorage on Desktop, KMS/Env on Cloud) | Zero plaintext secrets in database or client bundles; renderer credential isolation. |
| **Observability** | Structured JSON Logs with Request Correlation IDs & Metrics Aggregator | No prompt or source code logging; high cardinality token and cost attribution. |
| **Rate Limiting** | Server-Authoritative Token Bucket + Concurrency & Global Spend Kill-Switch | Strict budget controls, fail-closed concurrency caps, prevention of runaway provider billing. |

---

## 3. Detailed Decisions & Tradeoffs

### 3.1 Authentication
- **Choice**: GitHub OAuth App with PKCE (`code_challenge_method=S256`) and Desktop Loopback Callback (`http://127.0.0.1:<port>/auth/callback`), issuing short-lived signed JWT access tokens and rotating refresh tokens.
- **Why**: GitHub is the standard identity for developers. PKCE eliminates client secrets from Electron binaries.
- **Alternatives Considered**: Supabase Auth, Auth.js, Custom username/password.
- **Tradeoffs**: Requires a loopback listener on desktop; requires GitHub OAuth app registration.
- **Sources**: GitHub OAuth PKCE Documentation (RFC 7636).

### 3.2 Database & Schema
- **Choice**: Relational ledger architecture (PostgreSQL schema with SQL migrations, supported by an abstract database repository interface).
- **Why**: Append-only ledger transactions (`credit_ledger`, `usage_events`, `hosted_requests`) require strict serializability and ACID idempotency to avoid double-charging or race conditions.
- **Entities**: `users`, `identities`, `devices`, `sessions`, `plans`, `subscriptions`, `entitlements`, `usage_events`, `usage_periods`, `credit_ledger`, `hosted_requests`, `billing_webhook_events`, `provider_cost_events`, `account_settings`, `abuse_events`.
- **Tradeoffs**: Requires explicit migration management; strict constraints require robust schema typing.

### 3.3 Gateway & Inference Routing
- **Choice**: Native TypeScript Cloud AI Gateway integrating server-side ForgeZero.
- **Why**: ForgeZero remains the central policy firewall for eligibility, cost ceilings, and privacy constraints. A native TypeScript gateway directly shares types with `@codeforge/providers` and `@codeforge/forge-zero`.
- **Alternatives Considered**: LiteLLM proxy, Vercel AI SDK.
- **Tradeoffs**: We manage provider adapters and streaming SSE internally, ensuring zero third-party lock-in and 100% testability.

### 3.4 Billing (Stripe Test Mode)
- **Choice**: Stripe Checkout + Customer Portal + Webhook verification using official `stripe` Node.js SDK.
- **Why**: Webhooks act as authoritative billing truth (`checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.payment_failed`).
- **Policy**: STRICT TEST MODE ONLY. No real cards, no production price IDs.

### 3.5 Privacy & Code Redaction
- **Choice**: Ephemeral prompt processing. Zero raw repository content persistence in cloud logs or databases.
- **Why**: Developer trust and enterprise compliance require that source code and user prompts are never retained in server-side application logs or metadata tables.

---

## 4. Verification & Governance Hierarchy

1. User's explicit current instruction
2. CodeForge zero-cost / zero-liability safety policy
3. Server-side ForgeZero routing & entitlement checks
4. Server-authoritative credit ledger
5. Local Direct/BYOK fallback availability
