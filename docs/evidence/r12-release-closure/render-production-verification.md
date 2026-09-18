# Render production verification — R12

## Current observed state

Observed in the owner’s Render dashboard on 2026-09-17/18 EDT:

| Resource | State | Evidence |
|---|---|---|
| `codeforge-cloud-va` (`srv-dam6f83m8hqs73clo5ig`) | Virginia, live, `0.5c-512mb` | Compute page and latest deploy |
| Latest deploy `dep-dama02bm8hqs73d2a40g` | `Deploy succeeded \| Live` | Trigger: `Compute plan updated`; 12.0s deploy |
| `codeforge-cloud-va.onrender.com` | Primary URL live | Deploy log: service live and available at primary URL |
| Virginia PostgreSQL 16 | Available, retained | Required production dependency; not suspended |
| `codeforge-cloud-staging-va` | Suspended by owner request | No longer an active production resource |
| Oregon `codeforge-cloud` and `codeforge-cloud-staging` | Suspended by owner request | Rollback resources retained, not deleted |

The deploy log also reported `openrouter: healthy (25 verified-free)` and `groq: healthy (8 verified-free)`, with `hostedFree=true`, `stripe=disabled`, and `dbTls=true` in the production configuration line. No billing or service mutation was performed by this closure pass after the owner’s compute change.

## Carried-forward R11 evidence

R11 proved 21/21 credential-free probes for Virginia production and staging, Hosted Free Groq inference, auth enforcement, and validated external PostgreSQL TLS. It also recorded that the custom domain `cloud.forgerdigitalsolutions.com` still routed to Oregon and that Render’s internal Postgres certificate posture did not satisfy CodeForge’s certificate-validation policy.

## Release classification

- Virginia production: `PASS` for live deployment and current compute selection.
- Virginia staging: `BLOCKED_OWNER_DECISION` for a new runtime probe because it was intentionally suspended; the R11 probe remains historical evidence.
- Custom domain: `BLOCKED_OWNER_DECISION`; DNS cutover was not performed.
- Oregon: retained as suspended rollback resources; no deletion was attempted.
- Full current MCP monitoring: `INFRASTRUCTURE_BLOCKED` until the owner confirms the Render MCP workspace selection. The dashboard evidence above is direct read-only UI evidence and is not replaced by an unverified API claim.
