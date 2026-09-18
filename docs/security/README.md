# CodeForge Security Documentation

This tree is the engineering-grade description of how CodeForge protects credentials, code, and
accounts. It is written for three audiences at once — CodeForge engineers, external security
reviewers, and users who want to know what actually happens to their data — and it describes only
controls that exist in this repository. Where a control is planned, deployment-dependent, or
requires a third party, it says so.

## Status vocabulary

Every statement of a control in these documents carries one of these labels:

| Label | Meaning |
| --- | --- |
| **IMPLEMENTED** | The code exists in this repository. |
| **TESTED** | An automated test in this repository exercises the control (path is cited). |
| **VERIFIED IN THIS REPOSITORY** | The R1 campaign ran the test/scan and recorded the result under `docs/evidence/security-r1/`. |
| **ARCHITECTURALLY PREPARED** | The seam exists (interface, config, migration) but the production backing is not yet wired. |
| **REQUIRES DEPLOYMENT CONFIGURATION** | Correct behavior depends on an operator setting (env var, DNS, platform option). Listed in owner actions (not present in this checkout). |
| **REQUIRES THIRD-PARTY VERIFICATION** | Depends on a vendor's own guarantees (Stripe, Supabase/Neon, Render, GitHub, model providers) that CodeForge cannot verify from code. |
| **REQUIRES LEGAL COUNSEL** | A legal or policy determination CodeForge engineers must not make. |
| **REQUIRES FORMAL COMPLIANCE ASSESSMENT** | A certification (SOC 2, ISO 27001, PCI DSS, …) that only an accredited assessor can grant. CodeForge holds none today. |

CodeForge is **not** SOC 2, ISO 27001, PCI DSS, HIPAA, FedRAMP, or FIPS certified/validated, and
makes no "GDPR compliant"/"CCPA compliant" claim. See the
the release report's documented compliance blockers for what is prepared versus proven.

## Documents

| Document | What it covers |
| --- | --- |
| [architecture.md](./architecture.md) | Trust boundaries, control plane vs. agent execution plane, request paths. |
| [threat-model.md](./threat-model.md) | Assets, actors, attack surfaces, mitigations, residual risk, data-flow diagrams. |
| [data-classification.md](./data-classification.md) | The classification matrix: every data type, where it lives, how it is protected, who can read it, how long it lives. |
| the legal data-flow inventory at [data-flow-inventory.md](../legal/data-flow-inventory.md) | Where repository content and prompts actually go (device → Cloud → providers → GitHub). |
| [encryption.md](./encryption.md) | Exact cryptographic design: AES-256-GCM envelopes, key wrapping, AAD binding, hashing of tokens, TLS. |
| [key-management-and-rotation.md](./key-management-and-rotation.md) | Key ring format, staged rotation, emergency rotation, what is and is not a KMS. |
| [secrets-management.md](./secrets-management.md) | Inventory of every secret CodeForge holds, where it may live, and where it may never appear. |
| [session-and-api-security.md](./session-and-api-security.md) | Tokens, cookies, session liveness, CORS/CSRF, headers, rate limits, error handling. |
| [github-access-model.md](./github-access-model.md) | Exactly what GitHub access CodeForge asks for and why (identity OAuth vs. per-repository GitHub App). |
| [provider-security.md](./provider-security.md) | Managed (platform) provider credentials, BYOK isolation, and what a model can and cannot see. |
| [electron-security.md](./electron-security.md) | Desktop process model, IPC validation, navigation policy, CSP, local secret storage. |
| [tenant-isolation.md](./tenant-isolation.md) | How user A is kept from user B, with the tests that prove it. |
| the redaction controls in [secrets-management.md](./secrets-management.md) | Redaction at the logging boundary and the security audit trail. |
| the key-recovery rules in [encryption.md](./encryption.md) | What is backed up, by whom, encryption status, restore procedure for encrypted rows. |
| the repository dependency and security evidence | Dependencies, lockfile integrity, install scripts, CI, SBOM, vulnerability gate. |
| the rotation and residual-risk sections of [threat-model.md](./threat-model.md) | Severity model, playbooks for each compromise class, rotation, notification, postmortem. |
| the automated security suites and evidence under `tests/security/` | The regression gate, every security suite, and the ATTACK-001…016 acceptance evidence. |
| the compliance blockers recorded in the final campaign report | Control-by-control status against OWASP ASVS, PCI scope reduction, and privacy principles. |
| owner actions (not present in this checkout) | External actions only the operator/owner can take, with blocking status. |
| the Cloud API security contact configuration (not present in this checkout) | RFC 9116 template served by the Cloud API once a contact is configured. |

Privacy documentation lives in the legal data-flow inventory at [`docs/legal/data-flow-inventory.md`](../legal/data-flow-inventory.md); legal drafts in
[`docs/legal/`](../legal/README.md); the public vulnerability policy is the repository
[SECURITY.md](../../SECURITY.md); the R1 certification is
[CODEFORGE-FULL-SYSTEM-RC-CERTIFICATION.md](../../CODEFORGE-FULL-SYSTEM-RC-CERTIFICATION.md).

## The ten properties R1 set out to prove

| Property | Status | Where proven |
| --- | --- | --- |
| A — Database theft alone does not reveal stored BYOK/API/OAuth secrets | VERIFIED (no reversible user secret is stored server-side; the one reversible value is AES-256-GCM sealed) | `tests/security/attack-acceptance.test.ts` ATTACK-001 |
| B — Application logs do not contain secrets | TESTED (redacting logger + audit sanitizer) | `packages/secrets/test/security-primitives.test.ts`, ATTACK-006 |
| C — A model cannot obtain its provider key through context/tool output | TESTED (server-side injection; no route returns a key; tool output redacted) | ATTACK-004, `packages/server/test/hardening-adversarial.test.ts` |
| D — An agent shell cannot dump control-plane secrets | TESTED (sanitized child environment on every spawn site) | ATTACK-005 |
| E — User A cannot access user B's resources | TESTED (owner-scoped queries, cross-user 404s, sealed-secret rebinding fails) | ATTACK-003, `apps/cloud-api/test/publication-http.e2e.test.ts` |
| F — Renderer compromise does not yield Node/control-plane access | TESTED (sandbox + contextIsolation + validated IPC + bearer withheld from renderer) | `apps/desktop/test/electron-security-baseline.test.ts` |
| G — Card numbers/CVV are never collected or stored | VERIFIED (Stripe-hosted Checkout/Portal only; no card fields exist in CodeForge) | `docs/security/compliance-readiness-matrix.md`, `packages/cloud-billing` |
| H — OAuth credentials can be revoked/disconnected | TESTED (logout revokes sessions immediately; GitHub App installations are revocable on GitHub and reflected) | ATTACK-014 |
| I — Stored credentials can be rotated/migrated without data loss | TESTED (staged key rotation; legacy plaintext migration) | ATTACK-015, `packages/crypto/test/envelope.test.ts` |
| J — Public claims match the implementation | VERIFIED (claim gate in CI) | `scripts/security/public-claims-scan.mjs` |
