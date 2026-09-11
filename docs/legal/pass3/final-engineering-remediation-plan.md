# Final Engineering Remediation Plan — Pass 3 Reconciliation

<!-- PASS 3 FINAL RECONCILIATION — NOT LEGAL ADVICE — DRAFT ONLY -->

**Date**: 2026-09-11
**Author**: Pass 3 Independent Reviewer
**Rule**: This is the action plan for the subsequent remediation milestone. **DO NOT implement engineering changes during Pass 3.**

---

## 1. Remediation Backlog Overview

```
PRIORITY ORDER:
  1. ENG-P0-01 (Root LICENSE) [Dependencies: None]
  2. ENG-P0-02 (Cloud Account Deletion) [Dependencies: None]
  3. ENG-P0-03 (EEA Gemini Gateway Filter) [Dependencies: None]
  4. ENG-P1-01 (Unpaid Model UI Warning) [Dependencies: None]
  5. ENG-P1-02 (18+ Age Gate UI) [Dependencies: None]
  6. ENG-P1-03 (Host OS Autonomy Disclosure) [Dependencies: None]
  7. ENG-P1-04 (Marketing Claim Substantiation) [Dependencies: None]
  8. ENG-P2-01 (VS Code Extension License) [Dependencies: None]
  9. ENG-P2-02 (Monorepo Manifest License Normalization) [Dependencies: ENG-P0-01]
  10. ENG-P2-03 (8-Bit Rate Limit & Capping Protection) [Dependencies: None]
  11. ENG-P3-01 (Cloud Retention & Pruning Lifecycle) [Dependencies: None]
  12. ENG-P3-02 (Google Auth Key Guidance Text) [Dependencies: None]
```

---

## 2. Detailed Task Specifications

### [ENG-P0-01] Commit Canonical Root LICENSE File
- **Legal Driver**: Intellectual property foundation (`LEG-P0-01`). Resolves "All Rights Reserved" default.
- **Affected Files**: `G:\CodeForge\LICENSE` (New file).
- **Scope**: **SMALL** (10 minutes).
- **Proposed Implementation**:
  - Upon leadership decision, commit the canonical MIT License text naming `Copyright (c) 2026 Forger Digital Solutions`.
- **Acceptance Criteria**:
  - `Test-Path G:\CodeForge\LICENSE` returns true.
  - License contains valid copyright year and entity name.
- **Test Requirements**: Add automated CI check verifying `LICENSE` exists at repo root.

---

### [ENG-P0-02] Cloud Account Deletion Endpoint & Cascading Purge
- **Legal Driver**: GDPR Article 17 Right to Erasure (`LEG-P0-02`).
- **Affected Files**:
  - `apps/cloud-api/src/routes/account.ts` (or `apps/cloud-api/src/server.ts`)
  - `packages/cloud-db/src/index.ts`
  - `packages/cloud-db/src/migrations.ts`
- **Scope**: **MEDIUM** (2-3 engineering days).
- **Proposed Implementation**:
  1. Add `DELETE /v1/account` route to `apps/cloud-api` requiring authenticated JWT bearer token.
  2. Implement database method `db.deleteUserAccount(userId: string)` inside a transactional block.
  3. Ensure foreign keys on `device_sessions`, `subscriptions`, `continuations`, and `audit_records` enforce `ON DELETE CASCADE` or are explicitly purged in order.
  4. Invalidate all active refresh token hashes and emit an audit log entry confirming account erasure.
- **Acceptance Criteria**:
  - Calling `DELETE /v1/account` returns HTTP 200/204.
  - Subsequent requests with the deleted user's token return HTTP 401.
  - Querying Postgres confirms zero user or device session rows remain.
- **Test Requirements**: Unit test in `apps/cloud-api/test/account-deletion.test.ts` verifying complete cascading purge.

---

### [ENG-P0-03] Cloud Gateway Regional Geoblocking for Gemini Unpaid Tier
- **Legal Driver**: Google Gemini API Terms EEA Regional Restriction (`LEG-P0-03`).
- **Affected Files**:
  - `packages/cloud-gateway/src/cloud-firewall.ts`
  - `packages/cloud-gateway/src/provider-registry.ts`
- **Scope**: **MEDIUM** (1-2 engineering days).
- **Proposed Implementation**:
  1. Add GeoIP lookup / client region header inspection (`cf-ipcountry` or Cloudflare/AWS headers) to request context.
  2. If the user is determined to reside in an EEA member state, Switzerland, or the United Kingdom:
     - Prohibit routing to `google/gemini-*-free` or any Unpaid Gemini tier.
     - Fall back automatically to an alternative free provider (e.g., Groq, Cloudflare) or route to a configured Google Cloud Paid project.
     - Return a clear error if no paid project is configured: `ERROR_CODES.PROVIDER_REGIONAL_RESTRICTION`.
- **Acceptance Criteria**:
  - Simulated request with `cf-ipcountry: DE` (Germany) is blocked from Gemini Unpaid routes.
  - Simulated request with `cf-ipcountry: US` routes normally.
- **Test Requirements**: Unit test in `packages/cloud-gateway/test/regional-routing.test.ts`.

---

### [ENG-P1-01] UI Warning for Unpaid Model Training
- **Legal Driver**: Trade secret protection & user disclosure (`LEG-P1-03`).
- **Affected Files**:
  - `apps/desktop/src/renderer/WorkspaceShell.tsx`
  - `apps/desktop/src/renderer/ModelPicker.tsx`
- **Scope**: **SMALL** (0.5 engineering days).
- **Proposed Implementation**:
  - When the selected model route uses an unpaid tier (e.g., Gemini Unpaid), display an amber warning badge:
    `"Notice: Unpaid model tier. Prompts may be used by provider for model training."`
  - Include an info tooltip linking to CodeForge's AI Output & Privacy Disclosures.
- **Acceptance Criteria**:
  - Badge renders dynamically when an unpaid model is selected.
  - Badge is hidden when a paid or zero-data-retention model is selected.

---

### [ENG-P1-02] 18+ Minimum Age Gate Onboarding Confirmation
- **Legal Driver**: Upstream ToS flow-down from Google & OpenRouter (`LEG-P1-02`).
- **Affected Files**:
  - `apps/desktop/src/renderer/AuthScreen.tsx`
  - `apps/desktop/src/main.ts`
- **Scope**: **SMALL** (0.5 engineering days).
- **Proposed Implementation**:
  - Add a mandatory checkbox / acknowledgment on the first-run onboarding screen:
    `"I confirm that I am 18 years of age or older and agree to the Terms of Service."`
  - Save onboarding completed flag only after acknowledgment.
- **Acceptance Criteria**:
  - "Continue" button remains disabled until the age acknowledgment checkbox is checked.

---

### [ENG-P1-03] First-Run Host OS Autonomy Disclosure Dialog
- **Legal Driver**: Autonomous command execution liability disclaimer (`LEG-P1-05`).
- **Affected Files**:
  - `apps/desktop/src/renderer/AuthScreen.tsx` or new `ConsentModal.tsx`
- **Scope**: **SMALL** (0.5 engineering days).
- **Proposed Implementation**:
  - Display first-run modal explaining that CodeForge executes terminal commands directly in the host OS environment.
  - Require explicit user confirmation: `"I understand that CodeForge executes local commands and that I must review actions before approval."`

---

### [ENG-P1-04] Marketing & Documentation Claim Substantiation Redlines
- **Legal Driver**: FTC / EU consumer protection against unsubstantiated environmental & capability claims (`LEG-P1-04`).
- **Affected Files**:
  - `README.md`
  - `docs/**/*.md`
- **Scope**: **SMALL** (1 engineering day).
- **Proposed Implementation**:
  - Replace unqualified phrases like `"zero emissions"` with `"efficiency-aware routing designed to minimize redundant token consumption"`.
  - Replace `"proves correctness"` with `"runs configured verification test suites before completion"`.
  - Replace `"guaranteed free forever"` with `"routes exclusively through verified zero-cost allowances"`.

---

### [ENG-P2-01] Add License to `packages/vscode/package.json`
- **Legal Driver**: Marketplace publication requirement (`LEG-P2-01`).
- **Affected Files**: `packages/vscode/package.json`.
- **Scope**: **SMALL** (5 minutes).
- **Proposed Implementation**: Add `"license": "MIT"`. Copy canonical `LICENSE` into `packages/vscode/LICENSE`.

---

### [ENG-P2-02] Monorepo Manifest License Normalization (38 packages)
- **Legal Driver**: Monorepo hygiene & automated audit consistency (`LEG-P2-02`).
- **Affected Files**: `packages/*/package.json` (38 files).
- **Scope**: **SMALL** (Scripted, 15 minutes).
- **Proposed Implementation**: Run automated script to add `"license": "MIT"` to all 38 private workspace packages.

---

### [ENG-P2-03] 8-Bit Health Check Rate-Limit Capping & Circuit Breaker
- **Legal Driver**: Provider rate-limit compliance & scraping prevention (`LEG-P2-03`).
- **Affected Files**: `packages/eight-bit/src/health.ts`.
- **Scope**: **SMALL** (0.5 engineering days).
- **Proposed Implementation**:
  - When consecutive 401 Unauthorized or 403 Forbidden responses exceed 3 attempts, mark route as permanently `SUSPENDED`.
  - Stop the 15-minute polling loop until the user manually triggers a credential refresh.

---

### [ENG-P3-01] Automated Cloud DB Retention Pruning Job
- **Legal Driver**: Privacy data minimization (`LEG-P3-01`).
- **Affected Files**: `apps/cloud-api/src/server.ts`, `packages/cloud-db/src/index.ts`.
- **Scope**: **MEDIUM** (1 engineering day).
- **Proposed Implementation**: Run nightly cron/worker in Cloud API to purge `device_sessions` older than 30 days and delete transient logs older than 90 days.

---

### [ENG-P3-02] Google AI Studio Auth Key Guidance UI Text
- **Legal Driver**: Prevent user 401 errors from legacy API keys (`LEG-P3-03`).
- **Affected Files**: `apps/desktop/src/renderer/ProviderConfig.tsx`.
- **Scope**: **SMALL** (0.5 engineering days).
- **Proposed Implementation**: Add helper text below `GEMINI_API_KEY` input:
  *"Please use an Auth Key generated from Google AI Studio. Legacy Google Cloud Console keys without service account bindings are no longer supported by Google."*
