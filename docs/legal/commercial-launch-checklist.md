# CodeForge Commercial Launch Readiness Checklist

**Audit Date**: September 10, 2026
**Auditor**: Primary Audit Agent (Pass 1)
**Standard**: Comprehensive Pre-Release Compliance Gate across Legal, Security, Product, and Operations.

---

## 1. Launch Gate Overview

Prior to public commercial distribution, code publication, or accepting paid subscriber revenue, all checklist items must reach verified `PASS` status with sign-off from designated stakeholders.

```
       [ ENGINEERING GATE ] ──▶ [ LICENSING GATE ] ──▶ [ PRIVACY GATE ]
                                                              │
                                                              ▼
       [ COMMERCIAL RELEASE ] ◀── [ ATTORNEY SIGN-OFF ] ◀── [ CONTRACTS GATE ]
```

---

## 2. Multi-Disciplinary Launch Gates

### Gate A: Corporate & Business Infrastructure
- [ ] **A.1 Corporate Formation**: Operating legal entity formally organized and in good standing (e.g., Delaware LLC/C-Corp).
- [ ] **A.2 Registered Office**: Commercial mailing address and registered agent operational.
- [ ] **A.3 Official Inboxes**: Domain MX records active for `legal@`, `privacy@`, `security@`, and `support@`.
- [ ] **A.4 Commercial Pricing Sign-Off**: Retail pricing tiers ($/mo and credit allowances) approved by executive leadership.
- [ ] **A.5 Stripe Production Mode**: Formal migration from test keys (`sk_test_`) to production keys (`sk_live_`) with banking underwriting complete.

### Gate B: Open-Source & Intellectual Property
- [ ] **B.1 Root `LICENSE` File Added**: Canonical MIT License text committed to repository root (`G:\CodeForge\LICENSE`).
- [ ] **B.2 Internal Package Manifests**: All 20 workspace manifests in `packages/*/package.json` updated with `"license": "MIT"`.
- [ ] **B.3 Third-Party Notices Shipped**: Packaged desktop installer bundles authoritative `third-party-notices.md` alongside `LICENSE.electron.txt`.
- [ ] **B.4 Trademark Clearance**: Legal clearance search completed for "CodeForge" brand name in major software jurisdictions.
- [ ] **B.5 Model Attribution Verified**: UI Model Selector satisfies Meta Llama ("Built with Meta Llama") and NVIDIA attribution covenants.

### Gate C: Upstream AI Provider Compliance
- [ ] **C.1 OpenRouter Cloud Routing Resolution**: Either (1) execute OpenRouter Enterprise Reseller Agreement for hosted multi-tenant cloud routes, or (2) strictly enforce client-side BYOK where CodeForge Cloud never proxies model tokens through a shared master key.
- [ ] **C.2 Google Gemini Regional Gating**: Technical controls deployed to prevent routing EEA, UK, and Swiss end users through Google Gemini Unpaid Services tiers, conforming to Google's regional Paid Services mandate.
- [ ] **C.3 Automated Probing Rate Limits**: Synthetic allowance probing routines in 8-Bit and Desktop hardened with exponential backoff to prevent HTTP 429 throttling.
- [ ] **C.4 Model Distillation Prohibition**: Acceptable Use Policy explicitly flows down prohibitions against using model outputs to train competing foundational LLMs.

### Gate D: Privacy & Data Retention Remediation
- [ ] **D.1 Local Session Erasure Endpoint**: Implement `DELETE /api/sessions/:id` in `packages/server` and "Clear Local History" UI button in Desktop Settings.
- [ ] **D.2 Cloud Account Deletion Cascade**: Implement `POST /api/account/delete` in `apps/cloud-api` executing transactional cascade deletion across all PostgreSQL tables.
- [ ] **D.3 Automated Cloud TTL Purge**: Scheduled worker job deployed to purge raw prompt payloads from `hosted_requests` older than approved retention window (e.g., 30 days).
- [ ] **D.4 Cookie Banner & Tracking Disclosures**: Ensure web app (`apps/web`) deploys opt-in cookie consent before activating any web analytics.

### Gate E: Terms, Policies & Consumer Protection
- [ ] **E.1 Remove Placeholder Tags**: All `[BUSINESS DECISION REQUIRED]` and `[ATTORNEY REVIEW REQUIRED]` markers replaced with approved terms.
- [ ] **E.2 Arbitration & Governing Law Finalized**: Executive sign-off on dispute resolution mechanism and chosen state/country forum.
- [ ] **E.3 Minimum Age Enforcement**: Eligibility rules finalized and reflected in onboarding UI.
- [ ] **E.4 DMCA Registration**: Designated Copyright Agent registered with U.S. Copyright Office directory before enabling hosted user publications.
- [ ] **E.5 Marketing Claims Alignment**: Public website and app store listings audited against FTC Green Guides and Lanham Act standards (no unsubstantiated carbon offset or absolute zero-cost claims).

### Gate F: Security & Vulnerability Management
- [ ] **F.1 Security Disclosure Policy Published**: Vulnerability reporting policy and PGP key published at `/.well-known/security.txt`.
- [ ] **F.2 Safe Harbor Authorization**: Legal approval of vulnerability research safe harbor commitments.
- [ ] **F.3 Pre-Release Secret Scan**: Repository-wide automated scan confirming zero API keys, test tokens, or private secrets in release branch.
