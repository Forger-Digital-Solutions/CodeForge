# R12 targeted security review

## Results

| Area | Evidence / result |
|---|---|
| Secret redaction | New tests cover provider keys, bearer tokens, OAuth tokens, synthetic placeholders, generated patches, and tool output. Credential-like values are redacted without weakening synthetic-placeholder handling. |
| Agent authority | Context prompts now carry an immutable authority-boundary contract; mission-planner and replanner tool ceilings are read-only. |
| Completion authority | R12 protected acceptance supplies evidence but does not replace ForgeVerify or the completion gate. |
| TLS | Production uses the externally validated TLS path; internal Render Postgres TLS remains partial as documented by R11. |
| OAuth/session | R11 PKCE, logout invalidation, restart, and refresh-after-logout evidence remains valid; second-account switching is externally blocked. |
| Electron | R11 verified sandbox, context isolation, disabled node integration, web security, preload bearer boundary, CSP, lifecycle, and data preservation. |
| Dependencies | R11 recorded zero production vulnerabilities; R12 reruns the audit as part of final validation. |
| Cryptography claims | No unsupported “512-bit encryption” claim was added. Claims remain tied to actual TLS, token, storage, and OS/provider boundaries. |

## Scope limits

This report does not claim a new owner-account E2E result, a new production database migration, a DNS cutover, or trusted Windows signing. Those remain explicitly classified in the final gate matrix.
