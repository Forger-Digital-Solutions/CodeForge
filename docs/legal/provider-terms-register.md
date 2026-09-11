# CodeForge Upstream AI Provider Terms Register

**Audit Date**: September 10, 2026
**Auditor**: Primary Audit Agent (Pass 1)
**Standard**: Contractual flow-down analysis, intellectual property rights, commercial routing permissions, and data privacy restrictions.

---

## 1. Provider Terms Summary Matrix

| Provider | Governing Agreement | Effective Date | Date Accessed | Governing Law & Forum | Minimum Age | Commercial Use / Routing Rights | Privacy & Data Usage (Unpaid vs Paid) |
|---|---|---|---|---|---|---|---|
| **OpenRouter** | OpenRouter Terms of Service | August 31, 2026 | September 10, 2026 | California, USA (Arbitration) | 18+ (§ 2) | Prohibits reselling API access or developing competing services (§ 7(4)) under standard consumer terms. Enterprise terms available. | Metadata logged; prompt data handling governed by upstream host model providers. |
| **Google Gemini API** | Google APIs Terms of Service & Gemini API Additional Terms of Service | March 23, 2026 | September 10, 2026 | California, USA | 18+ (Additional Terms) | Permitted subject to flow-down requirements. **EEA/CH/UK restriction**: API Clients in these regions may only use Paid Services. | **Unpaid**: Prompts/responses used to train Google products; human review. **Paid**: Data not used to train models. |
| **Groq** | Groq Terms of Service & Commercial Terms | Current (2026) | September 10, 2026 | California, USA | 18+ | Developer API use permitted; standard rate limits apply. Reselling raw API prohibited without partner agreement. | Standard commercial API data protection; enterprise options available. |
| **Anthropic** | Commercial Terms of Service | June 17, 2025 | September 10, 2026 | California, USA | 18+ | Commercial integration permitted for customer applications under developer terms. | Customer Content not used to train generative models without express consent. |
| **OpenAI** | Business Terms & Service Terms | Current (2026) | September 10, 2026 | California, USA | 18+ (or 13+ with parental consent; API strictly 18+) | Commercial API use permitted; prohibits developing competing models using outputs. | API Customer Content not used to train models by default. |

---

## 2. In-Depth Provider Legal Analyses

### A. OpenRouter Standard Terms Analysis
- **Source**: `https://openrouter.ai/terms`
- **Publisher**: OpenRouter, Inc.
- **Effective Date**: August 31, 2026 (Accessed September 10, 2026)
- **Key Provisions**:
  - **Section 2 (Eligibility)**: Users must be at least 18 years old.
  - **Section 7(3) (Prohibited Use)**: Users may not use automated means to circumvent rate limits, allowances, or access restrictions.
  - **Section 7(4) (Resale & Competition)**: Users may not access the service "for purposes of reselling API access to Models or otherwise developing a competing service."

#### Classification: `OPENROUTER_STANDARD_TERMS_COMMERCIAL_ROUTING_REVIEW_REQUIRED`

To properly assess CodeForge's integration against OpenRouter's standard terms, seven distinct operational modes are evaluated:

1. **Mode A: Desktop BYOK (User Brings Own Key)**
   - *Architecture*: User enters their own personal API key obtained from OpenRouter. The user has a direct contractual relationship with OpenRouter.
   - *Status*: **CLEARLY PERMITTED**. The desktop app functions as an interface/client for the user's personal API access, identical to open-source developer tooling.
2. **Mode B: Desktop Direct OAuth PKCE Flow**
   - *Architecture*: User authenticates via `apps/desktop/src/openrouter-oauth-flow.ts`, granting a scoped token directly to their local desktop app.
   - *Status*: **CLEARLY PERMITTED**. Conforms to OpenRouter's published OAuth 2.0 PKCE developer specifications.
3. **Mode C: CodeForge-Owned Shared OpenRouter Account**
   - *Architecture*: CodeForge runs desktop or CLI sessions using a single master OpenRouter API key owned by Forger Digital Solutions.
   - *Status*: **RESTRICTED UNDER STANDARD TERMS**. Violates account-sharing and resale provisions of § 7.
4. **Mode D: Hosted Multi-Tenant Cloud Proxying**
   - *Architecture*: CodeForge Cloud API proxies requests from multiple unauthenticated or subscription users through a centralized OpenRouter key.
   - *Status*: **PRE-COMMERCIAL BLOCKER UNDER STANDARD TERMS**. Subsumes OpenRouter API access into a third-party paid/free subscription, directly implicating the "reselling API access" prohibition in § 7(4). Requires a negotiated Enterprise Agreement.
5. **Mode E: ForgeAuto / Free Allowance Routing**
   - *Architecture*: Directing user requests to `:free` models via user's BYOK key.
   - *Status*: **CLEARLY PERMITTED**, provided requests respect rate limits and do not employ automated multi-account pooling.
6. **Mode F: Commercial / Premium Hosted Routing**
   - *Architecture*: Charging users monthly credits (e.g., CodeForge Pro at 5M credits/mo) to query models through a hosted proxy.
   - *Status*: **REQUIRES ENTERPRISE AGREEMENT**. Cannot be launched commercially under OpenRouter standard terms.
7. **Mode G: Enterprise OpenRouter Agreement Path**
   - *Architecture*: Formal commercial/reseller agreement with OpenRouter authorizing multi-tenant brokering and downstream service provisioning.
   - *Status*: **RECOMMENDED SOLUTION**. Establishes definitive contractual rights prior to commercial cloud launch.

---

### B. Google Gemini API Additional Terms Analysis
- **Source**: `https://ai.google.dev/gemini-api/terms`
- **Publisher**: Google LLC
- **Effective Date**: March 23, 2026 (Accessed September 10, 2026)
- **Relevant Headings**:
  - *"Unpaid Services and Paid Services"*
  - *"Restrictions on API Clients in Specified Regions"*
  - *"Age Requirements"*
  - *"Confidentiality and Sensitive Data"*

#### Key Contractual Distinctions:
1. **Unpaid Services Data Treatment**:
   - Google terms state: For Unpaid Services, Google may use submitted prompts, generated content, and related materials to provide, maintain, develop, and improve Google products and services (including machine learning technologies).
   - Prompts and responses may be reviewed by trained human reviewers (in de-identified form).
   - Google explicitly instructs users: **Do not submit sensitive, confidential, or personal information when using Unpaid Services.**
2. **Paid Services Data Treatment**:
   - When using Paid Services, submitted prompts and responses are not used to train Google models or improve Google products without customer permission, and are treated with enterprise confidentiality.
3. **Regional Restriction for API Clients**:
   - Under the section governing specified regions, Google explicitly provides that when an API developer makes an API Client (application) available to end users located in the **European Economic Area (EEA), Switzerland, or the United Kingdom**, the developer **must only use Paid Services**. Developers are contractually prohibited from offering Unpaid Services to end users in these regions.

#### Legal Implications for CodeForge:
- **Consumer Protection & Privacy Claims**: Any representation that "CodeForge keeps your code completely private" is false if the application routes source code through Google Gemini Unpaid Services. CodeForge's `provider-policy.ts` correctly classifies Google Unpaid as `freePrivacyClass: "permissive"` and excludes it in `STRICT` mode. This technical gate must be preserved and clearly disclosed in the Privacy Policy.
- **Contractual Regional Enforcement**: User consent *cannot* waive or override Google's contractual prohibition on offering Unpaid Services in the EEA, UK, and Switzerland.
- **Architectural Remedy Options**:
  1. Detect end-user locale/IP or require user country declaration; disable Gemini Unpaid routes for users in EEA, UK, and Switzerland.
  2. Require users in EEA, UK, and Switzerland to supply a Google Cloud billing-enabled key (Paid Services tier) for Gemini models.
  3. Remove Google Gemini from the default free rotation for international distributions.

---

### C. Groq Commercial Terms Analysis
- **Source**: `https://groq.com/terms-of-service/`
- **Publisher**: Groq, Inc.
- **Status**: Standard developer BYOK is fully permitted. Free tier provides fast inference with strict rate caps (e.g., requests per minute). Automated loops must implement exponential backoff on HTTP 429 to avoid suspension.

---

### D. Upstream Flow-Down Requirements Summary
To remain compliant with all upstream providers, CodeForge's Terms of Service and Acceptable Use Policy must legally flow down the following prohibitions:
1. **No High-Risk Applications**: Prohibiting use in life support, critical infrastructure, weapons development, or autonomous lethal systems.
2. **No Model Distillation / Competing Models**: Prohibiting using outputs from OpenAI, Anthropic, or Google models to train competing foundational language models.
3. **Age Restriction Flow-Down**: Explicitly addressing the 18+ requirement mandated by Google Gemini API and OpenRouter standard terms.
