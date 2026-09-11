# Launch Readiness Matrix by Architecture Mode — Pass 3 Reconciliation

<!-- PASS 3 FINAL RECONCILIATION — NOT LEGAL ADVICE — DRAFT ONLY -->

**Date**: 2026-09-11
**Author**: Pass 3 Independent Reviewer
**Principle**: Legal compliance is architecture-dependent. A blocker for commercial hosted multi-tenant SaaS must NOT be conflated with the readiness of an open-source desktop beta.

---

## 1. Summary of Launch Modes

| Launch Mode | Architecture Description | Readiness Status | Hard Blockers Remaining | High-Priority Pre-Requisites |
|---|---|---|---|---|
| **Mode A: Private / Internal Development** | Monorepo development, internal team dogfooding, local test suites. | **READY NOW** | **NONE**. | None. |
| **Mode B: Public Free Desktop Beta** | Public GitHub repo, downloadable Windows/Mac desktop binary, BYOK only. | **BLOCKED (TRIVIAL FIXES)** | **LEG-P0-01** (Root LICENSE missing). | 18+ age gate in Terms; UI disclosure for Unpaid model training. |
| **Mode C: Public Free Cloud Beta** | Hosted CodeForge Cloud API, GitHub OAuth login, ForgeZero hosted routing allowance. | **BLOCKED** | **LEG-P0-01** (Root LICENSE); **LEG-P0-02** (GDPR Account Deletion); **LEG-P0-03** (EEA Gemini Geoblock). | **LEG-P1-01** (OpenRouter Enterprise Agreement); 18+ age gate. |
| **Mode D: Paid Desktop Subscription** | Pro desktop client with licensed features, user BYOK inference, Stripe billing. | **BLOCKED** | **LEG-P0-01** (Root LICENSE); Stripe Live cutover. | Commercial EULA / Terms of Sale; refund policy; entity formation. |
| **Mode E: Paid Hosted CodeForge SaaS** | Multi-tenant cloud workspace, bundled inference credits, paid Stripe subscriptions. | **BLOCKED** | **LEG-P0-01**; **LEG-P0-02**; **LEG-P0-03**; Stripe Live cutover. | OpenRouter Enterprise Agreement; Google Cloud DPA; terms & billing compliance. |
| **Mode F: Enterprise On-Premises** | Self-hosted CodeForge server within customer VPC / enterprise network. | **BLOCKED** | **LEG-P0-01** (Root LICENSE / Commercial Agreement). | Enterprise Master Services Agreement (MSA); security whitepaper. |

---

## 2. Granular Mode-by-Mode Analysis

### Mode A: Private / Internal Development
- **Scope**: Core team engineering, building features, running internal integration tests.
- **Current Legal Status**: **FULLY COMPLIANT / READY**.
- **Analysis**: Internal development does not distribute software publicly or process public personal data. Missing root license and lack of account deletion routes have zero legal consequence for private git commits.

---

### Mode B: Public Free Desktop Beta (Local BYOK)
- **Scope**: Distributing `CodeForge.exe` installer publicly for developers to test using their own API keys (BYOK). No cloud backend required.
- **Current Legal Status**: **BLOCKED BY 1 SIMPLE REPOSITORY FIX**.
- **Blocking P0s**:
  - `LEG-P0-01`: Commit canonical `LICENSE` (MIT) to repository root.
- **Surviving P1 Requirements (Before Public Announcement)**:
  - `LEG-P1-02`: Adopt 18+ minimum age requirement in Desktop EULA / Terms.
  - `LEG-P1-03`: Add UI badge warning users that Google Gemini Unpaid tier may use prompts for training.
  - `LEG-P1-05`: Add first-run disclosure regarding host-OS command execution.
- **Why Other Blockers Do NOT Apply**:
  - Does NOT require OpenRouter Enterprise Agreement (user uses own BYOK key).
  - Does NOT require GDPR Cloud Deletion endpoint (local SQLite data is user-controlled).
  - Does NOT require Stripe activation ($0 software).
- **Time to Unblock**: **1 to 2 engineering days**.

---

### Mode C: Public Free Cloud Beta (Hosted Routing)
- **Scope**: Operating `apps/cloud-api` publicly, allowing users to sign in with GitHub and utilize a shared free inference allowance (ForgeZero).
- **Current Legal Status**: **BLOCKED BY 3 P0 ISSUES + 1 CONTRACT REQUIREMENT**.
- **Blocking P0s**:
  - `LEG-P0-01`: Root `LICENSE` file missing.
  - `LEG-P0-02`: GDPR Art. 17 Account Deletion missing (`DELETE /api/account` + cascading purge).
  - `LEG-P0-03`: EEA regional ban on Gemini Unpaid tier requires geoblocking or routing EEA cloud users exclusively to a Google Cloud Paid project.
- **Blocking Contract Requirement (P1)**:
  - `LEG-P1-01`: OpenRouter ToS §7.3/§7.4 restricts pooling multiple users behind a single shared key without an Enterprise/Commercial Agreement.
- **Time to Unblock**: **1 to 2 engineering sprints (2 to 4 weeks)**.

---

### Mode D: Paid Desktop Subscription
- **Scope**: Selling a desktop software license or Pro feature tier directly to developers via Stripe, with inference remaining BYOK.
- **Current Legal Status**: **BLOCKED BY COMMERCIAL READINESS**.
- **Blocking P0s**:
  - `LEG-P0-01`: Root software license.
- **Commercial Prerequisites**:
  - Formal entity formation (LLC or C-Corp) and merchant banking.
  - Stripe Live account activation (replacing `sk_test_` configuration).
  - Commercial Terms of Sale, subscription billing terms, auto-renewal disclosures, and refund policy.
- **Time to Unblock**: **Requires Business & Legal Entity Execution**.

---

### Mode E: Paid Hosted CodeForge SaaS
- **Scope**: Full commercial multi-tenant web/cloud platform with bundled inference and monthly paid billing.
- **Current Legal Status**: **BLOCKED BY FULL SUITE OF LEGAL & COMMERCIAL PREREQUISITES**.
- **Blocking P0s & P1s**:
  - All Mode C blockers (`LEG-P0-01`, `LEG-P0-02`, `LEG-P0-03`, `LEG-P1-01`).
  - Formal Data Processing Addendum (DPA) executed with Google Cloud and OpenRouter.
  - Commercial subscription terms, cancellation workflows, tax collection (Stripe Tax), and PCI-DSS compliance.
  - Trademark clearance for "CodeForge" in International Classes 009 and 042.
- **Time to Unblock**: **Requires Multi-Month Product, Contractual, and Governance Execution**.

---

### Mode F: Enterprise On-Premises / VPC Deployment
- **Scope**: Deploying CodeForge server and client into an enterprise customer's private cloud or air-gapped infrastructure.
- **Current Legal Status**: **CUSTOM CONTRACT REQUIRED**.
- **Requirements**:
  - Enterprise Master Services Agreement (MSA) with customized IP indemnity, SLA, and liability caps.
  - Security architecture whitepaper detailing secret storage (`safeStorage`) and network egress.
  - Software Escrow or commercial source-available licensing if requested.

---

## 3. Launch Decision Framework for Leadership

```
                      Do you want to launch?
                                │
          ┌─────────────────────┴─────────────────────┐
          ▼                                           ▼
   DESKTOP ONLY (BYOK)                         CLOUD API / SAAS
          │                                           │
   Add Root LICENSE                            Add Root LICENSE
   Add 18+ Age Terms                           Build DELETE /api/account
   Add Unpaid Model Warning                    Geoblock EEA from Free Gemini
          │                                    Sign OpenRouter Enterprise
          ▼                                           │
   READY FOR PUBLIC BETA                              ▼
   (Estimated: 2 Days)                         READY FOR CLOUD BETA
                                               (Estimated: 3-4 Weeks)
```
