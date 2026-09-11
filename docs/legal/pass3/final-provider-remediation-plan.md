# Final Provider & Commercial Contract Remediation Plan — Pass 3 Reconciliation

<!-- PASS 3 FINAL RECONCILIATION — NOT LEGAL ADVICE — DRAFT ONLY -->

**Date**: 2026-09-11
**Author**: Pass 3 Independent Reviewer
**Purpose**: Define the exact commercial contract requirements, negotiation roadmaps, and architectural fallbacks for each upstream provider.

---

## 1. Provider Contract Roadmap

```
PROVIDER ENGAGEMENT STAGES:
  [STAGE 1: Desktop Beta Launch]
    └─ Zero agreements required. Operates under pure BYOK.

  [STAGE 2: Cloud Beta Launch]
    ├─ OpenRouter: Execute Commercial/Enterprise Agreement for multi-tenant pooling.
    ├─ Google Cloud: Configure Paid Project + DPA for EEA users; geoblock Unpaid in EEA.
    └─ GitHub: Maintain verified OAuth App configuration (scope: `read:user`).

  [STAGE 3: Commercial Monetization]
    ├─ Stripe: Activate Live Account; pass compliance audit.
    └─ Google Cloud & OpenRouter: Formalize enterprise volume DPAs.
```

---

## 2. Granular Provider Profiles & Remediation Actions

### 1. OpenRouter, Inc.
- **Current CodeForge Architecture**:
  - Desktop: End-user supplies personal OpenRouter API key (BYOK).
  - Cloud API: CodeForge Cloud Gateway routes user requests through a single CodeForge-owned key for `:free` models.
- **Contractual Status (`EXTERNAL_CONTRACT_FACT`)**:
  - Desktop BYOK: **PERMITTED** under standard Terms of Service (§3.1, §3.2).
  - Cloud Gateway: **RESTRICTED** under standard Terms (§7.3 prohibition on pooling to bypass limits; §7.4 prohibition on reselling API access).
- **Acceptable Architecture**:
  - Desktop BYOK: Ship immediately.
  - Cloud Multi-Tenant: Permitted ONLY with an Enterprise/Commercial Agreement.
- **Agreement Required**:
  - **OpenRouter Enterprise Agreement**: Grants CodeForge the contractual right to aggregate end-user traffic behind a corporate API key and bundle inference into CodeForge subscriptions or allowances.
  - **OpenRouter Data Processing Agreement (DPA)**: Standard GDPR/CCPA DPA under §10.2.
- **Engineering Fallback (If Agreement Not Executed)**:
  - Disable hosted OpenRouter routing in `apps/cloud-api`.
  - Restrict OpenRouter usage exclusively to the Desktop App in BYOK mode.

---

### 2. Google LLC (Google AI Studio & Gemini API)
- **Current CodeForge Architecture**:
  - Desktop: User enters `GEMINI_API_KEY` (Auth Key from Google AI Studio).
  - Cloud API: Cloud Gateway routes through CodeForge Google Cloud Project.
- **Contractual Status (`EXTERNAL_CONTRACT_FACT`)**:
  - Desktop BYOK (US/Global): **PERMITTED** for professional/business development.
  - Desktop BYOK (EEA/UK/CH): **AMBIGUOUS / ATTORNEY REVIEW REQUIRED**.
  - Cloud Gateway (EEA/UK/CH on Unpaid): **STRICTLY PROHIBITED** by Google Gemini API Terms ("Use Restrictions: You may use only Paid Services when making API Clients available to users in the EEA").
- **Acceptable Architecture**:
  - Cloud Gateway routing EEA users exclusively to a Google Cloud Paid Project (active billing account).
  - Unpaid tier accessible ONLY to non-EEA users.
- **Agreement Required**:
  - **Google Cloud Customer Agreement** with attached **Google Cloud Data Processing Addendum (DPA)** for the corporate Cloud Gateway project.
- **Engineering Fallback**:
  - Enforce IP geoblocking in `packages/cloud-gateway` (`ENG-P0-03`) to reject Gemini Unpaid requests originating from EEA/UK/CH IP addresses and fail over to Groq or Cloudflare.

---

### 3. Groq, Inc.
- **Current CodeForge Architecture**:
  - Desktop: User enters Groq API key (`gsk_...`).
  - Cloud API: Cloud Gateway proxies fast-inference free models (`llama-3.3-70b`).
- **Contractual Status**:
  - Desktop BYOK: **PERMITTED** under Groq Developer Terms within published rate limits.
  - Cloud Gateway: Permitted within free allowance; high volume requires commercial tier.
- **Agreement Required**:
  - Groq Commercial API Agreement if CodeForge Cloud exceeds standard developer tier rate limits.
- **Engineering Fallback**:
  - Rely on 8-Bit health tracker (`packages/eight-bit/src/health.ts`) to back off gracefully upon receiving HTTP 429 (Rate Limited).

---

### 4. Cloudflare, Inc. (Workers AI)
- **Current CodeForge Architecture**:
  - Desktop & Cloud: Uses Cloudflare Account ID + API Token.
- **Contractual Status**:
  - **PERMITTED**. Cloudflare explicitly encourages building application gateways and agentic clients using Workers AI.
- **Agreement Required**:
  - Cloudflare Workers Paid subscription ($5/mo baseline) to lift daily neuron allowance caps.
- **Engineering Fallback**:
  - Fall back to alternative free providers when daily neuron allowances are exhausted.

---

### 5. GitHub, Inc. (Microsoft)
- **Current CodeForge Architecture**:
  - Cloud API: Server-brokered OAuth flow with PKCE (`packages/cloud-auth`).
  - Scope requested: `read:user` (minimal public profile).
- **Contractual Status**:
  - **PERMITTED / FULLY COMPLIANT**. Follows standard OAuth 2.0 best practices for public desktop clients. Drops access token after profile provisioning.
- **Agreement Required**:
  - Standard GitHub OAuth App registration (no enterprise agreement needed).
- **Engineering Fallback**:
  - Support local offline mode in Desktop without cloud sign-in.

---

### 6. Stripe, Inc.
- **Current CodeForge Architecture**:
  - Cloud API: Test mode enforced via `sk_test_` keys. Hardcoded configuration guard rejects live keys at startup.
- **Contractual Status**:
  - **TEST ENVIRONMENT COMPLIANT**.
- **Agreement Required (Prior to Commercial Launch)**:
  - Stripe Connected Account / Standard Merchant Agreement.
  - Terms of Service and refund policy published on corporate domain.
- **Engineering Fallback**:
  - Maintain CodeForge as a 100% free product with zero billing infrastructure active.
