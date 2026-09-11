# CodeForge Legal Authorities & Source Register

**Audit Date**: September 10, 2026
**Auditor**: Primary Audit Agent (Pass 1)
**Standard**: Primary Source Verification & Legal Freshness.

---

## 1. Statutory & Regulatory Authorities

| Authority / Jurisdiction | Citation / Identifier | Full Title / Document Name | Effective / Enacted Date | Direct Relevance to CodeForge |
|---|---|---|---|---|
| **European Union** | Regulation (EU) 2016/679 | **General Data Protection Regulation (GDPR)** | May 25, 2018 | Art. 17 (Right to Erasure); Art. 30 (Records of Processing); Art. 32 (Security of Processing); Art. 44–49 (Cross-border data transfers). |
| **European Union** | Regulation (EU) 2024/1689 | **EU Artificial Intelligence Act (AI Act)** | August 1, 2024 | Art. 50 (Transparency obligations for AI system providers and deployers; notifying users they are interacting with AI). |
| **United States (Federal)** | 15 U.S.C. § 45 | **Federal Trade Commission Act § 5** | 1914 (as amended) | Prohibition against unfair or deceptive acts or practices; mandatory prior substantiation of objective performance claims (ForgeZero, ForgeGreen). |
| **United States (Federal)** | 16 CFR Part 260 | **FTC Guides for the Use of Environmental Marketing Claims ("Green Guides")** | 2012 (as updated) | Rules governing carbon, energy, and green claims; prohibits unsubstantiated carbon reduction representations (ForgeGreen). |
| **United States (Federal)** | 17 U.S.C. § 512 | **Digital Millennium Copyright Act (DMCA) § 512** | October 28, 1998 | Safe harbor protections for online service providers transmitting or hosting user-generated materials; requirement of designated agent. |
| **United States (Federal)** | 15 U.S.C. § 1125(a) | **Lanham Act § 43(a)** | July 5, 1947 | False advertising, trademark infringement, and nominative fair use standards for model provider logos. |
| **United States (State - CA)** | Cal. Civ. Code § 1798.100 *et seq.* | **California Consumer Privacy Act (CCPA) / CPRA** | January 1, 2023 | Consumer privacy notices, right to delete (§ 1798.105), and data inventory requirements. |
| **United States (Commercial)** | UCC § 2-316 | **Uniform Commercial Code § 2-316** | Various State Adoptions | Statutory requirements for conspicuous exclusion or modification of implied warranties of merchantability and fitness. |

---

## 2. Upstream AI Provider Agreements & Official Policies

| Provider | Official Document Title | Canonical URL | Effective Date | Date Verified | Key Provisions Cited |
|---|---|---|---|---|---|
| **OpenRouter, Inc.** | Terms of Service | `https://openrouter.ai/terms` | August 31, 2026 | September 10, 2026 | § 2 (18+ Eligibility); § 7(3) (Rate limit circumvention); § 7(4) (Resale and competing service prohibition); § 10 (Arbitration). |
| **Google LLC** | Google APIs Terms of Service & Gemini API Additional Terms | `https://ai.google.dev/gemini-api/terms` | March 23, 2026 | September 10, 2026 | Unpaid Services vs Paid Services data training; Restrictions on API Clients in Specified Regions (EEA, UK, Switzerland must use Paid Services); Age Requirements (18+). |
| **Groq, Inc.** | Terms of Service | `https://groq.com/terms-of-service/` | Current (2026) | September 10, 2026 | Standard developer API terms; commercial rate limits and acceptable use. |
| **Anthropic PBC** | Commercial Terms of Service | `https://www.anthropic.com/legal/commercial-terms` | June 17, 2025 | September 10, 2026 | Customer Content confidentiality; prohibition against model distillation and unauthorized security probing. |
| **OpenAI LLC** | Business Terms & Service Terms | `https://openai.com/policies/business-terms` | Current (2026) | September 10, 2026 | API data excluded from training; restrictions on creating competing models. |

---

## 3. Model Weight License Agreements

| Model Family | Canonical License Name | Governing Entity / Licensor | Canonical Reference | Key Obligations |
|---|---|---|---|---|
| **Meta Llama 3.1 & 3.2** | Meta Llama Community License Agreement | Meta Platforms, Inc. | `https://www.llama.com/llama3/license/` | Attribution notice ("Built with Meta Llama"); commercial use threshold (< 700M MAU); model distillation restrictions. |
| **NVIDIA Nemotron** | NVIDIA Open Model License Agreement | NVIDIA Corporation | `https://developer.download.nvidia.com/licenses/nvidia-open-model-license-agreement.txt` | Copyright preservation; attribution; prohibited applications (malicious, discrimination, military). |
| **Qwen 3** | Tongyi Qianwen License Agreement | Alibaba Cloud | `https://github.com/QwenLM/Qwen` | Royalty-free commercial use (< 100M MAU); commercial license request required above threshold. |
| **DeepSeek** | DeepSeek Open Source License | Hangzhou DeepSeek AI Co., Ltd. | `https://github.com/deepseek-ai` | Permissive MIT-based terms with acceptable use restrictions against malicious code and cyberattack generation. |

---

## 4. Codebase Audit Anchors & Evidence Citations

| Subsystem / Topic | Primary Code File | Key Functions / Structures Audited |
|---|---|---|
| **Zero-Billing Firewall** | `packages/forge-zero/src/zero-evaluator.ts` | `evaluateZeroCostEligibility`, `isVerifiedFreeModel` |
| **Model Registry & Overlays** | `packages/model-registry/src/overlay.ts` | `verifyZeroUnitFree`, `verifyAllowanceFree` |
| **Offline Catalog Snapshot** | `packages/model-registry/src/snapshot.ts` | `MODELS_DEV_SNAPSHOT`, `MODELS_DEV_SNAPSHOT_CAPTURED_AT` |
| **Completion Gate** | `packages/workflow/src/completion-gate.ts` | `evaluateCompletion`, terminal `completed` vs `blocked` states |
| **Local SQLite Persistence** | `packages/sessions/src/persistence.ts` | `createSession`, `addTurn`, `addEvent` (verifying absence of deletion API) |
| **Cloud PostgreSQL Migrations** | `packages/cloud-db/src/migrations.ts` | Tables 1–7 (`users`, `subscriptions`, `hosted_requests`, etc.) |
| **Stripe Billing Service** | `packages/cloud-billing/src/stripe-service.ts` | `createCheckoutSession`, assertion blocking `sk_live_` |
| **OpenRouter Desktop OAuth** | `apps/desktop/src/openrouter-oauth-flow.ts` | `startOAuthFlow`, PKCE code challenge generation |
| **Secret Redaction** | `packages/secrets/src/redaction.ts` | Regex token masking filters |
| **Tool Execution Engine** | `packages/tools/src/` | Unsandboxed shell, file system, and git dispatch |
| **Packaged Release Artifacts** | `apps/desktop/release/win-unpacked/` | `CodeForge.exe`, `resources/app.asar`, `LICENSE.electron.txt` |
