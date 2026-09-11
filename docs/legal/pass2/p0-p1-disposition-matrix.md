# P0/P1 Disposition Matrix — Pass 2 Independent Review

<!-- PASS 2 ADVERSARIAL REVIEW — NOT LEGAL ADVICE — DRAFT ONLY -->

## Disposition Legend
- **CONFIRMED**: Pass 1 conclusion is accurate and fully supported by Pass 2 evidence.
- **NARROWED**: Pass 1 conclusion is partially accurate, but scoped too broadly. Severity may remain high, but the attack surface is smaller.
- **DOWNGRADED**: Pass 1 overstated the risk. Reclassified to P2/P3.
- **DISPROVED**: Pass 1 conclusion is factually or legally incorrect.
- **UPGRADED**: Pass 1 understated the risk or scope.
- **NEW**: Identified by Pass 2.

## Executive Summary of Changes
Pass 1 proposed 3 existential P0s and 4 critical P1s. Pass 2 successfully disproved or narrowed the majority of these, reducing the immediate commercial launch blockers while uncovering a critical new authentication issue.

---

## The Matrix

| ID | Issue Area | Pass 1 Severity | Pass 1 Claim | Pass 2 Disposition | Pass 2 Final Severity | Justification |
|---|---|---|---|---|---|---|
| **L-01** | **OpenRouter Resale** | P0 | CodeForge hosting OR proxy violates ToS 7(4) prohibition on reselling APIs. | **NARROWED** | **P1** | BYOK desktop is fully compliant (no proxy). Hosted Cloud Proxy *does* aggregate users, risking ToS violation if CodeForge monetizes the routing layer. |
| **L-02** | **Gemini Regional Ban** | P0 | Free Gemini use in EEA violates Google ToS. Consent does not cure. | **CONFIRMED** | **P0** (Cloud) / **P3** (Desktop) | Google explicitly bans Unpaid APIs for EEA users. CodeForge Cloud API must geoblock EEA or route to Paid. Desktop BYOK shifts liability to the user. |
| **L-03** | **GDPR Art. 17 Erasure** | P0 | No deletion routes exist; GDPR requires erasure for all sessions. | **NARROWED** | **P0** (Cloud) / **P3** (Desktop) | Local SQLite sessions are user-controlled; GDPR Art 17 doesn't apply to CodeForge. Cloud PostgreSQL accounts/sessions DO trigger Art 17. |
| **L-04** | **CCPA Compliance** | P1 | CCPA applies; requires deletion mechanisms. | **DOWNGRADED** | **P3** | Pre-commercial CodeForge does not meet the $25M revenue or 100k consumer thresholds. CCPA is legally inapplicable at launch. |
| **L-05** | **Root `LICENSE`** | P1 | Codebase lacks a root open-source license. | **CONFIRMED** | **P0** | Business must declare if CodeForge is proprietary or MIT before public release. Fundamental IP requirement. |
| **L-06** | **Missing pkg Licenses**| P1 | 20 internal packages lack license field. | **UPGRADED** | **P2** | Count was wrong (39 missing). Private packages are low risk, but `codeforge-vscode` is public and missing a license. |
| **L-07** | **Copyleft Contamination**| P1 | No copyleft found, but manual review needed. | **CONFIRMED** | **Resolved** | Automated scan confirms zero GPL/AGPL strings in shipping `app.asar`. |
| **L-08** | **Stripe Test Mode** | P1 | Hardcoded `sk_test_` keys present. | **DOWNGRADED** | **P2** | Not a legal risk, just a commercial readiness blocker. Code is safely sandboxed to test mode. |
| **N-01** | **Gemini API Key Deprecation** | *N/A* | *Missed by Pass 1.* | **NEW** | **P1** | Google deprecated standard API keys in June 2026. BYOK integration using string keys will fail for new users. |
| **N-02** | **OAuth Token Storage** | *N/A* | *Missed by Pass 1.* | **NEW** | **P2** | GitHub tokens appear to be stored unencrypted (no `safeStorage` calls found). Major local security liability. |

## Path to "Ready for Release"
To achieve commercial release readiness, engineering and business leadership must resolve the resulting P0s and P1s:
1. **(P0) Declare root LICENSE.**
2. **(P0) Implement `DELETE /api/account`** with DB cascade for Cloud API users.
3. **(P1) Fix Gemini Auth** to support Google's new service-account key formats.
4. **(P1) Resolve OpenRouter Proxy** legality if CodeForge intends to host the routing layer centrally.
5. **(P1) Geoblock EEA users** from the Unpaid Gemini tier in the Cloud API.
