# Final Provider Contract & Model Licensing Matrix — Pass 3 Reconciliation

<!-- PASS 3 FINAL RECONCILIATION — NOT LEGAL ADVICE — DRAFT ONLY -->

**Date**: 2026-09-11
**Author**: Pass 3 Independent Reviewer
**Standard**: Contract text cited from current primary sources. Strict separation between **Provider Contract** (terms governing API access) and **Model License** (weights/outputs legal terms).

---

## 1. Provider Contract Architecture Matrix

| Provider | Access Mode | Credential Holder | Current Contractual Status | Permitted Architecture | Restricted Architecture | Agreement Needed? |
|---|---|---|---|---|---|---|
| **OpenRouter** | Desktop BYOK | End User | **PERMITTED** under standard terms (§3.1, §3.2). | Desktop client sends HTTP directly from user workstation with user's key. | Embedding hardcoded CodeForge key in desktop binary. | None. Standard ToS applies to user. |
| **OpenRouter** | Cloud Multi-Tenant | CodeForge Cloud | **RESTRICTED** under standard terms (§7.3, §7.4). | Single-tenant passthrough or negotiated enterprise routing. | Monetized proxying without agreement ("reselling API access" §7.4); pooling users on free models (§7.3). | **YES**: OpenRouter Commercial / Enterprise Agreement required. |
| **OpenRouter** | 8-Bit Probing | End User or Cloud | **AMBIGUOUS / RATE LIMITED**. | Intermittent role testing within normal account rate limits. | Continuous high-frequency scraping or safety boundary stress-testing (§8 Red Teaming). | Written consent required if conducting systematic stress testing. |
| **Google Gemini** | Desktop BYOK (US/Global) | End User | **PERMITTED**. User acquires Auth Key from Google AI Studio. | Desktop client sends HTTP directly to Google API with user Auth Key. | Distributing keys to third parties. | None. Google AI Studio Terms apply to user. |
| **Google Gemini** | Desktop BYOK (EEA/UK/CH) | End User | **AMBIGUOUS (ATTORNEY REVIEW)**. | User configures Paid Google Cloud billing project. | User configures Unpaid Gemini API key. Terms state: *"You may use only Paid Services when making API Clients available in EEA."* | **ATTORNEY_REVIEW**: Clarify whether distributing software constitutes "making API Clients available". |
| **Google Gemini** | Cloud Hosted Routing (Global) | CodeForge Cloud | **PERMITTED (PAID)** / **RESTRICTED (UNPAID)**. | Routing via CodeForge Google Cloud Paid project with DPA. | Routing users through Google AI Studio Unpaid tier for commercial gain. | Google Cloud Paid Services Agreement + DPA. |
| **Google Gemini** | Cloud Hosted Routing (EEA/UK/CH) | CodeForge Cloud | **STRICTLY PROHIBITED (UNPAID)** / **PERMITTED (PAID)**. | Cloud Gateway routes EEA users to Google Cloud Paid Project. | Routing EEA users to Gemini Unpaid tier. Direct breach of Google Terms. | Geoblock Unpaid tier for EEA IPs; enforce Paid tier routing. |
| **Groq** | Desktop BYOK | End User | **PERMITTED**. Groq Developer Terms grant API client usage within free tier limits. | Direct client requests with user `gsk_...` key. | Reverse engineering inference engine or reselling raw capacity. | Standard Developer Terms. |
| **Groq** | Cloud Hosted Routing | CodeForge Cloud | **PERMITTED (PAID)** / **RESTRICTED (FREE)**. | Enterprise plan with commercial API terms. | Pooling hundreds of free users onto Groq free tier allowance. | Commercial Groq API Agreement. |
| **Cloudflare Workers AI** | Desktop BYOK | End User | **PERMITTED**. Cloudflare API Token used with user's Account ID. | Direct API requests from desktop. | Distributing account credentials. | Standard Cloudflare Terms. |
| **Cloudflare Workers AI** | Cloud Hosted Routing | CodeForge Cloud | **PERMITTED**. Multi-tenant Worker deployment under CodeForge account. | Cloudflare Workers Paid plan with AI Gateway. | Exceeding daily free neuron limits. | Cloudflare Enterprise / Workers Paid. |
| **GitHub** | OAuth Identity | CodeForge Cloud | **PERMITTED**. Minimal scope `read:user` requested; server-brokered PKCE. | Exchanging code for profile; immediately dropping token. | Requesting excessive scopes (`repo`, `admin`); persisting tokens unencrypted. | Standard GitHub Developer Agreement. |
| **Stripe** | Billing Platform | CodeForge Cloud | **TEST MODE ENFORCED**. Live billing refused at startup. | Sandboxed testing with `sk_test_` keys. | Live real-money processing without formal legal terms and tax registration. | Stripe Live Account activation required prior to monetization. |

---

## 2. Google Gemini API Contract Specifics

### Primary Authority (`EXTERNAL_CONTRACT_FACT`)
- **Document**: Google Gemini API Additional Terms of Service
- **Effective Date**: March 23, 2026 (Verified current)
- **URL**: `https://ai.google.dev/gemini-api/terms`

### Key Contractual Provisions
1. **Age Requirement (Heading: "Age Requirements")**:
   - *"You must be 18 years of age or older to use the APIs. You also will not use the Services as part of a website, application, or other service ('API Clients') that is directed towards or is likely to be accessed by individuals under the age of 18."*
   - **Impact**: CodeForge must enforce an explicit 18+ age requirement in its Terms of Service.
2. **EEA/UK/CH Geographic Restriction (Heading: "Use Restrictions")**:
   - *"You may only access the Services (or make API Clients available to users) within an available region. You may use only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom."*
   - **Impact**: CodeForge Cloud Gateway MUST NOT route EEA/UK/CH users to the Unpaid Gemini API. Doing so is an explicit breach of contract.
3. **Consumer Use Restriction (Heading: "Use Restrictions")**:
   - *"Use of Google AI Studio and Gemini API is for developers building with Google AI models for professional or business purposes, not for consumer use."*
   - **Impact**: CodeForge must be positioned as a professional developer tool, not a consumer chat product.
4. **Data Training on Unpaid Tier (Heading: "Unpaid Services")**:
   - *"Google uses the content you submit... to provide, improve, and develop Google products... To help with quality and improve our products, human reviewers may read, annotate, and process your API input and output. Do not submit sensitive, confidential, or personal information to the Unpaid Services."*
   - *"If you're in the European Economic Area, Switzerland, or the United Kingdom, the terms under 'How Google uses Your Data' in 'Paid Services' apply to all Services... even though they are offered free of charge."*
   - **Impact**: Prompts sent to Gemini Unpaid tier are used for Google model training (outside EEA). CodeForge must prominently warn users not to send confidential employer code to the Unpaid tier.
5. **Agentic Services Clause (Heading: "Agentic Services")**:
   - *"If your API Client provides agentic services... you are solely responsible for the actions and tasks performed by the service. You will not automatically bypass any requests for human confirmation."*
   - **Impact**: CodeForge's approval gates for file writes and command executions are explicitly required by Google's Agentic Services terms. CodeForge MUST NOT provide a "headless no-approval" mode that bypasses confirmation without explicit user consent.

---

## 3. OpenRouter Contract Specifics

### Primary Authority (`EXTERNAL_CONTRACT_FACT`)
- **Document**: OpenRouter Terms of Service
- **Last Updated**: August 31, 2026 (Verified current)
- **URL**: `https://openrouter.ai/terms`

### Key Contractual Provisions
1. **Section 2 — Eligibility**:
   - *"You must be at least 18 years of age to use the Service."*
2. **Section 7.3 — Account Limits**:
   - Prohibits creating *"multiple accounts as a single user, for purposes of bypassing or circumventing use limits on the Site or Service or for any other reason"*.
3. **Section 7.4 — Reselling & Competition**:
   - Prohibits accessing the Service for *"purposes of reselling API access to Models or otherwise developing a competing service"*.
4. **Section 8 — Red Teaming**:
   - Prohibits *"Red Teaming or similar adversarial testing... without prior written consent from OpenRouter"*.
5. **Section 10.2 — Data Processing Agreement**:
   - Incorporates a standard DPA for commercial/for-profit use.

---

## 4. Model Weights Licensing vs. API Routing

When routing through cloud APIs (OpenRouter, Google, Groq), the governing legal agreement is the **Provider Terms of Service**, not the underlying open-weights model license. However, when models are identified by name, downstream restrictions flow down:

| Model ID | Model Creator | Hosting Provider | Governing Legal Document | Commercial Use Permitted? | Downstream Restrictions |
|---|---|---|---|---|---|
| `google/gemini-2.5-flash-lite` | Google | Google AI Studio | Google Gemini API Terms | Yes (Professional/Business) | 18+ only; No consumer use; Prompts used for training on Unpaid tier. |
| `meta-llama/llama-3.3-70b-instruct` | Meta | OpenRouter / Groq | Provider ToS + Llama 3.3 Community License | Yes (under 700M MAU) | Must include "Built with Llama"; no training competing models; Meta AUP. |
| `mistralai/mistral-small-3` | Mistral AI | OpenRouter | Provider ToS + Apache 2.0 / Mistral Terms | Yes | Standard attribution. |
| `deepseek/deepseek-chat` | DeepSeek | OpenRouter | Provider ToS + MIT License | Yes | Standard MIT attribution. |
| `qwen/qwen-2.5-coder-32b` | Alibaba Cloud | OpenRouter | Provider ToS + Qwen License | Yes | Standard attribution; compliance with Alibaba AUP. |

---

## 5. Summary of Required Contractual Actions

1. **Desktop BYOK**: Requires ZERO provider agreements. End users operate under their own individual agreements with Google, OpenRouter, and Groq.
2. **Cloud API Staging / Beta**: Free allowance proxying requires an **OpenRouter Enterprise Agreement** if routing through OpenRouter.
3. **Cloud API EEA Deployment**: Requires geoblocking Gemini Unpaid tier from EEA/UK/CH IP addresses, routing EEA users exclusively to a Google Cloud Paid project with an active billing account.
4. **Commercial Launch**: Requires activating Stripe Live billing, executing the OpenRouter DPA, and executing the Google Cloud DPA.
