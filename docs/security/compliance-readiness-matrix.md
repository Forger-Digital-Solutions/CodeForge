# Compliance Readiness Matrix

**This is not a compliance certificate.** CodeForge holds no SOC 2, ISO 27001, PCI DSS, HIPAA,
FedRAMP, or FIPS certification/validation and has not been assessed by an accredited third
party. This matrix maps CodeForge's actual controls to the categories those frameworks and
OWASP ASVS use, so that a future assessment (and today's reviewers) can see what is prepared
versus proven. Statuses: `IMPLEMENTED`, `PARTIAL`, `NOT APPLICABLE`, `NOT IMPLEMENTED`,
`REQUIRES DEPLOYMENT VERIFICATION`, `REQUIRES LEGAL REVIEW`, `REQUIRES THIRD-PARTY AUDIT`.

## OWASP ASVS (v4.0.3 chapters)

| ASVS area | Control in CodeForge | Status | Evidence |
| --- | --- | --- | --- |
| V1 Architecture | Documented trust boundaries, threat model, data classification | IMPLEMENTED | `architecture.md`, `threat-model.md`, `data-classification.md` |
| V2 Authentication | No passwords; GitHub OAuth with PKCE, server-brokered confidential client; single-use codes | IMPLEMENTED | `session-and-api-security.md`, cloud-auth tests |
| V2.7/2.8 MFA | Delegated to GitHub (users can enforce 2FA on GitHub); no CodeForge-native MFA | NOT APPLICABLE (identity provider) | — |
| V3 Session management | Short access tokens with live-session check, rotating refresh with breach detection, HttpOnly `__Host-` cookie, server-side logout | IMPLEMENTED | ATTACK-014 |
| V3.7 Re-authentication for sensitive ops | Account deletion requires a live bearer + literal confirmation; no re-auth prompt (no password to re-prompt) | PARTIAL | `server.ts` |
| V4 Access control | Every resource scoped by token subject; cross-tenant 404; no admin API | IMPLEMENTED (app layer) / PARTIAL (no DB RLS) | `tenant-isolation.md` |
| V5 Validation, sanitization | Zod schemas, size limits, parameterized SQL, allowlisted git args, path containment | IMPLEMENTED | ATTACK-010/012 |
| V6 Stored cryptography | AES-256-GCM envelopes with versioned KEK, hashed tokens, `safeStorage` on device; no custom algorithms | IMPLEMENTED | `encryption.md`, crypto tests |
| V6.2 Key management / KMS | Env-loaded versioned key ring; KMS seam prepared | PARTIAL | `key-management-and-rotation.md` |
| V7 Error handling & logging | Generic 500s with correlation ids; redacting logger; audit trail | IMPLEMENTED | `logging-and-audit.md` |
| V8 Data protection | Classification matrix, minimization (webhook payloads, no prompt storage), retention sweep, deletion | IMPLEMENTED / PARTIAL (retention periods for billing/audit pending business decision) | `data-classification.md`, `docs/privacy/retention-and-deletion.md` |
| V9 Communication | HTTPS at the edge, HSTS emitted, DB TLS with cert validation, no insecure fallbacks | IMPLEMENTED / REQUIRES DEPLOYMENT VERIFICATION (TLS termination policy is Render's) | `encryption.md` §6 |
| V10 Malicious code | Lockfile installs, install-script allowlist, audit gate, SBOM, secret scan | IMPLEMENTED / PARTIAL (no package provenance verification) | `supply-chain.md` |
| V11 Business logic | Credit reservations, idempotent webhooks, `payment_status` gate, kill switches, spend caps | IMPLEMENTED | billing tests, ATTACK-009/010 |
| V12 Files and resources | Bounded uploads, server-derived keys, digest verification, deletion; workspace containment | IMPLEMENTED | ATTACK-012, publication tests |
| V13 API | Bearer auth, CORS allowlist, rate limit, security headers, body limits | IMPLEMENTED / PARTIAL (rate limit per process) | `session-and-api-security.md` |
| V14 Configuration | Fail-closed config loader; secrets only in env; redacted startup summary; security headers | IMPLEMENTED | `config.ts`, `secrets-management.md` |

## PCI DSS scope reduction

| Principle | CodeForge position | Status |
| --- | --- | --- |
| Do not store PAN/CVV/track data | Card entry happens only on Stripe-hosted Checkout/Portal pages; CodeForge has no card field, no card column, and receives only minimized webhook objects (ids/amounts/statuses) | IMPLEMENTED (SAQ-A-style posture) |
| Protect the payment integration | Webhook signature + tolerance, idempotency, payment-status gate, live-mode refusal, return-URL allowlist | IMPLEMENTED |
| Formal attestation | None; Stripe's own PCI status covers Stripe (REQUIRES THIRD-PARTY AUDIT for any CodeForge attestation) | NOT IMPLEMENTED (not required while no cardholder data is handled; a formal SAQ would be a business step) |
| Live processing | Stripe TEST mode only; live keys refused at boot | Business decision pending (OWNER-ACTIONS) |

## Privacy principles (GDPR / CCPA-CPRA / state laws — not a compliance claim)

| Principle | Mechanism | Status |
| --- | --- | --- |
| Lawful basis, notice | Privacy Policy draft describing actual flows | REQUIRES LEGAL REVIEW (`docs/legal/pass3/proposed-drafts/privacy-policy.md`) |
| Data minimization | No prompt storage; minimized webhook payloads; identity limited to profile + authorized email | IMPLEMENTED |
| Purpose limitation | Each data type's purpose listed in the classification matrix | IMPLEMENTED (documented) |
| Storage limitation | Retention sweep for auth artifacts; bundles deleted; USER_CONTENT/AUTH/OPERATIONAL classes purged on deletion; billing/audit periods undecided | PARTIAL |
| Right of access / portability | `GET /v1/account`, `/v1/usage` return the account's data; no bulk export endpoint | PARTIAL (`docs/privacy/privacy-rights-workflow.md`) |
| Right to erasure | `DELETE /v1/account` (hard delete + artifact purge + session revocation); backups age out per provider retention | IMPLEMENTED (with documented backup caveat) |
| Right to rectification | Profile mirrors GitHub; change on GitHub and sign in again | PARTIAL |
| Security of processing | This documentation tree | IMPLEMENTED |
| Breach notification | Playbook + decision path; counsel determines obligations | PARTIAL / REQUIRES LEGAL REVIEW |
| Processor contracts (DPA) | Draft DPA prepared; not executed | REQUIRES LEGAL REVIEW |
| Records of processing | Data classification + data-flow documents | IMPLEMENTED (documented) |
| Children | 18+ requirement in first-run acknowledgement and ToS draft | REQUIRES LEGAL REVIEW |
| Sale/sharing of personal data | None occurs; no advertising or analytics SDKs | IMPLEMENTED (verified absence) |
| Cross-border transfer | Providers and hosting are US-based services; EEA transfer mechanism not assessed | REQUIRES LEGAL REVIEW |

## NIST-aligned concepts

| Concept (SP 800-63B / 800-53 families) | Status |
| --- | --- |
| Authenticator secrecy (no plaintext secrets stored; hashed verifiers) | IMPLEMENTED |
| Session binding & termination (IA-11, AC-12) | IMPLEMENTED |
| Cryptographic module validation (FIPS 140) | NOT IMPLEMENTED (OpenSSL via Node, not FIPS-validated in this build) |
| Audit record content/retention (AU-3, AU-11) | IMPLEMENTED (content) / PARTIAL (retention period pending) |
| Least privilege (AC-6) for GitHub access | IMPLEMENTED |
| Boundary protection (SC-7) for the local control plane | IMPLEMENTED |
| Incident response plan (IR-4/IR-8) | IMPLEMENTED (document) / PARTIAL (no named contact, no alerting) |
| Contingency/backup (CP-9/CP-10) | PARTIAL (provider-managed; no drill performed) |
| Supply chain (SR-3/SR-4) | PARTIAL |
| Configuration baseline (CM-6) | IMPLEMENTED (fail-closed config) |

## Formal certifications

| Certification | Status |
| --- | --- |
| SOC 2 Type I/II | NOT OBTAINED — REQUIRES THIRD-PARTY AUDIT |
| ISO/IEC 27001 | NOT OBTAINED — REQUIRES THIRD-PARTY AUDIT |
| PCI DSS attestation | NOT OBTAINED — not required for the current no-cardholder-data posture; REQUIRES THIRD-PARTY AUDIT if pursued |
| HIPAA | NOT APPLICABLE / NOT OBTAINED — CodeForge is not designed for PHI |
| FedRAMP | NOT OBTAINED |
| FIPS 140 validation | NOT OBTAINED |
