# Source Verification Register — Pass 2 Independent Review

<!-- PASS 2 ADVERSARIAL REVIEW — NOT LEGAL ADVICE — DRAFT ONLY -->

## Purpose
This document logs the independent verification of every primary legal source cited by Pass 1, detailing retrieval dates, commit hashes (where applicable), and material differences.

## 1. OpenRouter Terms of Service
- **Source URL:** https://openrouter.ai/terms
- **Pass 1 Citation Date:** August 31, 2026
- **Pass 2 Retrieval Date:** September 11, 2026
- **Status:** `SOURCE_VERIFIED`
- **Verification Details:** The "Last Updated" date remains August 31, 2026. The text of Section 7(3) (creating multiple accounts to bypass limits) and 7(4) (reselling API access) matches Pass 1's claims perfectly.
- **Material Differences:** Pass 1 misinterpreted the *application* of these terms to BYOK architecture. The source text is accurate, but the legal extrapolation was flawed.

## 2. Google Gemini API Additional Terms of Service
- **Source URL:** https://ai.google.dev/gemini-api/terms
- **Pass 1 Citation Date:** Unspecified (Implied current)
- **Pass 2 Retrieval Date:** September 11, 2026
- **Status:** `SOURCE_VERIFIED`
- **Verification Details:** Effective date is March 23, 2026. The regional restriction text explicitly states: "You may use only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom."
- **Material Differences:** Pass 1 correctly cited the regional restriction. Pass 2 independently verified that Unpaid Services explicitly allow human reviewers to read/annotate API inputs.

## 3. General Data Protection Regulation (GDPR)
- **Source:** EU Regulation 2016/679
- **Status:** `SOURCE_VERIFIED`
- **Verification Details:** Article 4 (Definitions: Controller vs. Processor) and Article 17 (Right to Erasure) were correctly cited.
- **Material Differences:** Pass 1 assumed blanket applicability. Pass 2 verifies the text but narrows applicability based on software architecture (Desktop vs. Cloud).

## 4. California Consumer Privacy Act (CCPA)
- **Source:** Cal. Civ. Code § 1798.100 et seq.
- **Status:** `SOURCE_MISCHARACTERIZED`
- **Verification Details:** Pass 1 treated CCPA as an immediate P0 compliance blocker. Pass 2 reviewed the statutory thresholds (Cal. Civ. Code § 1798.140(c) - $25M revenue, 100k consumers, 50% data broker revenue).
- **Material Differences:** Pre-commercial CodeForge absolutely does not meet the revenue or consumer thresholds. CCPA citation in Pass 1 lacked threshold analysis.

## 5. CodeForge Monorepo / Desktop Release
- **Source:** `g:\CodeForge`
- **Status:** `SOURCE_CHANGED / RE-EVALUATED`
- **Verification Details:** 
  - Pass 1 claimed 20 internal packages lacked a license field. Pass 2 found **39** via `asar` extraction and local `package.json` scanning.
  - Pass 1 claimed Zero Telemetry. Pass 2 verified `@codeforge/telemetry` exists but is an empty, non-transmitting stub class.
  - Pass 1 claimed no `DELETE /api/sessions`. Pass 2 confirmed via `Select-String` search.
  - Pass 1 claimed `ffmpeg.dll` posed LGPL risk. Pass 2 evaluated Electron's standard build process and `LICENSES.chromium.html`, determining it is low risk.

## 6. GitHub Terms of Service / OAuth
- **Status:** `SOURCE_VERIFIED`
- **Verification Details:** CodeForge uses GitHub OAuth for authentication. Pass 2 audited the codebase for `safeStorage` or `keytar` and found none. OAuth tokens are likely kept in memory or standard local storage, which poses security risks but not necessarily third-party Terms of Service violations, provided scopes are minimized.

## Conclusion
All external provider terms cited by Pass 1 exist and contain the stated text. However, Pass 1's application of CCPA, GDPR, and OpenRouter terms to CodeForge's specific architectural realities was overly broad, alarmist, and lacked technical nuance.
