# CodeForge Legal Readiness — Pass 2 Adversarial Review Workspace

<!-- PASS 2 ADVERSARIAL REVIEW — NOT LEGAL ADVICE — DRAFT ONLY -->

**Pass 2 Executed**: 2026-09-11
**Pass 2 Verdict**: `CODEFORGE_LEGAL_PASS2_READY_FOR_FINAL_REVIEW`
**Pass 1 Verdict under Review**: `CODEFORGE_LEGAL_PASS1_READY_FOR_INDEPENDENT_REVIEW`

---

## Purpose

This workspace contains the independent adversarial review of the Pass-1 legal readiness
package. Pass 2 independently verified every material Pass-1 conclusion, retrieved current
primary sources, challenged all P0/P1 classifications, searched for missed issues, and
produced updated redlines and recommendation packages.

Pass 1 materials are preserved unchanged in `docs/legal/`. Pass 2 never overwrites them.

---

## Pass-2 Document Index

| Document | Purpose |
|----------|---------|
| `README.md` | This file — workspace overview |
| `source-verification-register.md` | Independent verification of every Pass-1 citation |
| `provider-contract-applicability.md` | Deep adversarial analysis of OpenRouter + Gemini terms |
| `privacy-law-applicability.md` | GDPR/CCPA applicability analysis — do not assume |
| `packaged-license-verification.md` | Independent reproduction of shipping license graph |
| `p0-p1-disposition-matrix.md` | Confirmed / narrowed / upgraded / downgraded for every issue |
| `missing-issues.md` | Issues Pass 1 missed, newly discovered |
| `policy-redline-findings.md` | Adversarial redlines on all 9 policy drafts |
| `attorney-review-delta.md` | Which attorney questions grew, shrank, or were resolved |
| `engineering-remediation-delta.md` | Ranked remediation backlog |
| `business-decisions-delta.md` | Business decisions still required, trimmed of unnecessary ones |
| `handoff-to-final-review.md` | Briefing for Pass 3 Final Reviewer |
| `pass2-adversarial-review.md` | Primary Pass-2 adversarial report |
| `pass2-adversarial-review.json` | Machine-readable audit artifact |

---

## Critical Pass-2 Corrections to Pass-1

| # | Pass-1 Claim | Pass-2 Finding | Status |
|---|---|---|---|
| 1 | 20 internal packages lack `"license"` | **39 packages** lack `"license"` field; 1 not-private | **UPGRADED (count)** |
| 2 | `codeforge-vscode` license gap not mentioned | VS Code extension, no `private` flag, no license | **NEW ISSUE** |
| 3 | OpenRouter §7(4) bars hosted cloud routing | Narrowed: BYOK desktop clearly OK; cloud proxying ambiguous | **NARROWED** |
| 4 | GDPR Art. 17 "triggered" as P0 | P0 only for cloud API EEA users; local SQLite is user-controlled | **NARROWED** |
| 5 | CCPA claimed as P0 blocker | CCPA thresholds almost certainly not met pre-commercial | **DOWNGRADED** |
| 6 | "Zero telemetry" assertion | @codeforge/telemetry is a NO-OP STUB — confirms claim but clarifies | **CONFIRMED (nuanced)** |
| 7 | 8-Bit probing legality unclear | Qualification calls are legitimate API usage; free-quota abuse risk if excessive | **NARROWED** |
| 8 | ffmpeg.dll / Chromium codec concern | Electron stub ffmpeg (no LGPL codecs); attribution files present | **CONFIRMED LOW RISK** |

---

## Evidence Standard

Every conclusion in Pass 2 is labeled with one of:
- `REPOSITORY FACT` — observed directly in source files
- `PACKAGED-ARTIFACT FACT` — observed in `win-unpacked/` release
- `CONTRACT TEXT` — exact quote from retrieved provider agreement
- `STATUTORY/REGULATORY REQUIREMENT` — statute or regulation
- `LEGAL INTERPRETATION` — requires legal judgment
- `BUSINESS DECISION` — requires owner/leadership decision
- `ENGINEERING RECOMMENDATION` — technical remediation needed
- `ATTORNEY QUESTION` — unresolved, requires outside counsel

No conclusion in Pass 2 jumps from repository fact directly to legal conclusion without
explicitly stating the required intermediate steps.
