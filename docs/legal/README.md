# CodeForge Legal, Terms, Privacy & Commercial Release Readiness Workspace

Welcome to the CodeForge Legal Audit and Governance workspace. This directory contains the complete primary legal discovery package, empirical data flow inventories, intellectual property audits, third-party terms analyses, attorney review packets, and reviewable draft policies prepared during **Pass 1** of the CodeForge legal readiness pipeline.

---

## 1. Review Pipeline Architecture

The CodeForge legal readiness audit is conducted through an independent, multi-tiered review pipeline:

```
[ Pass 1: Primary Audit Agent ] (COMPLETED)
       │
       ▼
[ Pass 2: Independent Adversarial Reviewer ] (QUEUED)
  - Verify sources, attack assumptions, challenge omissions
       │
       ▼
[ Pass 3: Final Independent Reviewer ] (QUEUED)
  - Contractual risk, statutory privacy, commercial release readiness
       │
       ▼
[ Licensed Outside Legal Counsel ] (ATTORNEY REVIEW)
  - Definitive legal advice, corporate formation, binding terms execution
```

> [!IMPORTANT]
> **Audit Status**: All documents in this directory represent **Pass 1 (Primary Audit)** findings. They are non-binding engineering, compliance, and legal discovery analyses. No document here certifies legal compliance or constitutes formal legal advice.

---

## 2. Directory Index & Document Map

### A. Fact Registers & Empirical Data Audits
- [`product-fact-ledger.md`](./product-fact-ledger.md) — Authoritative status of 25+ product capabilities across SHIPPING, STAGING, EXPERIMENTAL, and FUTURE classifications based on repository code evidence.
- [`data-flow-inventory.md`](./data-flow-inventory.md) — Detailed tracing of prompts, code context, credentials, SQLite local persistence, PostgreSQL cloud storage, and network egress.
- [`third-party-services-register.md`](./third-party-services-register.md) — Architectural profiles and network containment for OpenRouter, Google Gemini, Groq, Cloudflare, OpenAI, Anthropic, Z.AI, Stripe, and GitHub OAuth.
- [`provider-terms-register.md`](./provider-terms-register.md) — Comprehensive legal and contractual analysis of upstream AI provider terms, BYOK implications, and routing restrictions.
- [`model-license-register.md`](./model-license-register.md) — Model-specific license analysis (Llama 3, Mistral, Qwen, DeepSeek) vs proprietary API models, commercial rights, and attribution duties.

### B. Intellectual Property & Claims Audits
- [`open-source-license-audit.md`](./open-source-license-audit.md) — Deterministic audit of the 686-package dependency tree and the exact shipping packaged Electron binary (`app.asar`), verifying zero copyleft licenses.
- [`asset-provenance-audit.md`](./asset-provenance-audit.md) — Legal provenance and copyright audit of desktop icons, 8-Bit mascot artwork, UI emojis, and third-party brand logos.
- [`claims-substantiation-audit.md`](./claims-substantiation-audit.md) — Technical and legal substantiation of marketing and architecture claims (ForgeZero, ForgeGreen, ForgeVerify, security/sandboxing).
- [`source-register.md`](./source-register.md) — Comprehensive citations of codebase files, upstream agreements, statutes (GDPR, CCPA, EU AI Act), and regulatory precedents.

### C. Review Packets & Decision Ledgers
- [`commercial-launch-checklist.md`](./commercial-launch-checklist.md) — Multi-disciplinary release readiness gate across Business, Legal, Engineering, Security, and Compliance.
- [`attorney-review-issues.md`](./attorney-review-issues.md) — High-stakes legal briefing packet structured specifically for outside counsel (facts, statutory risks, and strategic options).
- [`unresolved-legal-facts.md`](./unresolved-legal-facts.md) — Master ledger of mandatory business decisions required by project leadership.
- [`handoff-to-independent-review.md`](./handoff-to-independent-review.md) — Instructions, critical challenge areas, and priorities for the Pass 2 Adversarial Reviewer.
- [`handoff-to-final-review.md`](./handoff-to-final-review.md) — Final commercial release reviewer protocol for Pass 3.

### D. Final Pass 1 Readiness Reports
- [`pass1-legal-readiness-report.md`](./pass1-legal-readiness-report.md) — Narrative executive summary, evidence matrices, and risk classifications.
- [`pass1-legal-readiness-report.json`](./pass1-legal-readiness-report.json) — Machine-readable audit report and compliance data.

### E. Reviewable Policy Drafts (`docs/legal/drafts/`)
- [`drafts/terms-of-service.md`](./drafts/terms-of-service.md) — Complete CodeForge Terms of Service tailored to BYOK architecture and autonomous execution risk.
- [`drafts/privacy-policy.md`](./drafts/privacy-policy.md) — Data-flow-backed Privacy Policy delineating local processing from cloud/provider routing.
- [`drafts/acceptable-use-policy.md`](./drafts/acceptable-use-policy.md) — Prohibitions against malicious code generation, security abuse, and provider policy violations.
- [`drafts/ai-output-disclaimer.md`](./drafts/ai-output-disclaimer.md) — Detailed disclaimer for autonomous AI code generation and shell execution.
- [`drafts/subscription-billing-terms.md`](./drafts/subscription-billing-terms.md) — Cloud credits, tier entitlements, Stripe Test Mode provisions, and negative-option disclosures.
- [`drafts/desktop-software-license.md`](./drafts/desktop-software-license.md) — Packaged desktop application distribution terms aligned with open-source core.
- [`drafts/third-party-notices.md`](./drafts/third-party-notices.md) — Comprehensive attribution and copyright notices for packaged third-party components.
- [`drafts/security-disclosure.md`](./drafts/security-disclosure.md) — Coordinated vulnerability disclosure policy and safe harbor framework.
- [`drafts/dmca-copyright-policy.md`](./drafts/dmca-copyright-policy.md) — Notice and takedown policy under 17 U.S.C. § 512.

---

## 3. Governance & Usage Notes

1. **Unresolved Decision Markers**: All policy drafts retain explicit markers (`[BUSINESS DECISION REQUIRED]`, `[ATTORNEY REVIEW REQUIRED]`, `[MINIMUM AGE / PROVIDER FLOW-DOWN DECISION REQUIRED]`). These must not be removed until project leadership and counsel formally establish the governing terms.
2. **External Action Restrictions**: No document in this workspace may be published to the public web, embedded into application clickwrap, or submitted to government authorities without separate, explicit human authorization.
