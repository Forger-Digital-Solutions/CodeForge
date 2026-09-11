# Engineering Remediation Delta — Pass 2 Independent Review

<!-- PASS 2 ADVERSARIAL REVIEW — NOT LEGAL ADVICE — DRAFT ONLY -->

## Overview
This document translates the legal and commercial risks identified in Pass 2 into concrete engineering tasks. It replaces the Pass 1 remediation list.

## Critical (P0) — Launch Blockers

| ID | Component | Task Description | Legal/Business Driver |
|---|---|---|---|
| **ENG-P0-01** | `apps/cloud-api` | **Implement Cloud Account Deletion.** Create `DELETE /api/account` endpoint. | GDPR Art. 17 compliance for Cloud EEA users. |
| **ENG-P0-02** | `packages/cloud-db` | **Implement Cascading Deletion.** Update PostgreSQL migrations to ensure `ON DELETE CASCADE` for all session and billing records tied to an account. | GDPR Art. 17 completeness. |
| **ENG-P0-03** | Repository Root | **Inject Root LICENSE.** Commit the chosen open-source or proprietary `LICENSE` file to the repo root. | Foundational IP requirement. |

## High (P1) — Fast Follow / High Commercial Risk

| ID | Component | Task Description | Legal/Business Driver |
|---|---|---|---|
| **ENG-P1-01** | `packages/model-registry` | **Update Gemini Authentication.** Migrate from legacy API key strings to Google Cloud Service Account JSON / OAuth2 auth keys. | Google deprecated standard API keys; current BYOK flow will break for new users. |
| **ENG-P1-02** | `packages/model-registry` | **Geoblock EEA from Unpaid Gemini.** In the Cloud API routing layer, detect EEA IPs and prevent routing to Gemini Unpaid tiers. | Google Terms of Service explicit prohibition. |
| **ENG-P1-03** | `packages/vscode` | **Add License to VS Code Extension.** Add explicit `"license"` field to `packages/vscode/package.json`. | Microsoft Marketplace requirements and user IP clarity. |

## Medium (P2) — Security & Polish

| ID | Component | Task Description | Legal/Business Driver |
|---|---|---|---|
| **ENG-P2-01** | `apps/desktop` | **Encrypt Local OAuth Tokens.** Implement Electron `safeStorage` (or `keytar`) for storing GitHub OAuth tokens locally. | Security liability reduction. Currently tokens appear unencrypted. |
| **ENG-P2-02** | `packages/*` | **Normalize Internal Package Licenses.** Add `"license": "MIT"` (or chosen license) to the 38 private packages. | Resolve automated audit warnings. |
| **ENG-P2-03** | `packages/eight-bit` | **Cap Health Check Retries.** Update `health.ts` to implement a permanent "SUSPENDED" state for API keys that repeatedly return 401, halting the 15-minute polling loop. | Prevent IP bans from providers for aggressive polling. |
| **ENG-P2-04** | `apps/desktop` | **UI Disclaimer for Free Models.** Add clear UI badge/warning when routing to Unpaid Gemini indicating "Data may be used for training by Google." | Shift liability for proprietary data leakage to the user. |

## Deprecated from Pass 1

- **[DEPRECATED]** Build CCPA DSR workflows. (Not legally required; pre-commercial thresholds not met).
- **[DEPRECATED]** Remove `ffmpeg.dll`. (Verified as Electron stub; safe to ship).
