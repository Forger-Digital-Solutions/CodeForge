# Incident Response

Operational playbooks for CodeForge security incidents. Written for whoever is on call at
Forger Digital Solutions (FDS); no incident tooling beyond the repository, Render, the database
provider, GitHub, Stripe, and the provider dashboards is assumed.

## Severity model

| Severity | Definition | Examples | Initial response target |
| --- | --- | --- | --- |
| **SEV-1** | Confirmed compromise of a CRITICAL SECRET, cross-tenant data exposure, or active abuse spending money | Leaked `GITHUB_APP_PRIVATE_KEY`; database dump exfiltrated; user A reading user B's data; credit-grant forgery in production | Contain within 1 hour of confirmation; owner paged immediately |
| **SEV-2** | Likely compromise or a vulnerability with a known exploit path but no confirmed abuse | Provider key visible in a log line; unpatched high/critical dependency advisory in a reachable path; sign-in bypass reported by a researcher | Contain within 24 hours |
| **SEV-3** | Weakness without a demonstrated exploit path | Missing header, over-broad claim in docs, non-exploitable dependency advisory | Fix in the next release |
| **SEV-4** | Informational | Scanner noise, policy drift | Track |

## Roles

| Role | Who | Responsibility |
| --- | --- | --- |
| Incident owner | The FDS maintainer on call (`[SECURITY CONTACT — OWNER INPUT REQUIRED]`, see [OWNER-ACTIONS.md](./OWNER-ACTIONS.md)) | Declares severity, runs the playbook, decides on notification, writes the postmortem |
| Deputy | Any other maintainer | Evidence preservation, communication drafts, verification |
| Legal reviewer | Outside counsel (`[LEGAL CONTACT — OWNER INPUT REQUIRED]`) | Notification obligations, regulator/contract questions |

## Universal first steps (any severity ≥ SEV-2)

1. **Preserve evidence before changing anything**: export `security_audit_events` and `abuse_events` for the window (`SELECT * FROM security_audit_events WHERE occurred_at BETWEEN … ORDER BY occurred_at`), save Render logs for the service, note the deployed commit (`describeConfig` output line in the boot log), snapshot the Stripe event log and GitHub App/OAuth App audit pages. Store under an incident folder outside the repository.
2. **Scope**: which class of asset ([data-classification.md](./data-classification.md)) is involved, since when, which tenants.
3. **Contain** using the matching playbook below.
4. **Eradicate**: rotate, patch, redeploy, re-run the security gate (`npm run security:gate`, `npm run security:tests`).
5. **Recover**: verify with the acceptance suite and a manual sign-in/inference/publication check on staging.
6. **Notify** (decision path in §"Notification").
7. **Postmortem** within 5 business days (template at the end).

## Playbooks

### P1 — Secret compromise (any CRITICAL SECRET in the Cloud env)

Applies to provider keys, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `JWT_SECRET`,
`CODEFORGE_DATA_ENCRYPTION_KEYS`, Stripe keys, `DATABASE_URL`.

1. Generate the replacement at the issuer **first** (provider console / GitHub App settings / Stripe / database provider), so the old value can be revoked without an outage.
2. Set the new value in Render (secret env var), redeploy, confirm boot (`describeConfig` line; `/health/ready`).
3. Revoke the old value at the issuer. For `JWT_SECRET`, every access token dies at redeploy (clients refresh silently). For the KEK ring, follow the *emergency* variant: stage `2:NEW,1:OLD`, redeploy, wait 10 minutes for in-flight sign-ins to expire, then remove `1:OLD` and redeploy — in-flight logins simply restart.
4. Search the evidence for use of the leaked secret: provider usage dashboards (unexpected spend), Stripe event log (unexpected sessions), GitHub App installation activity, `security_audit_events` for `auth.*`/`billing.*` anomalies.
5. If the leak reached a git commit: rotate regardless of whether the commit was public, purge with `git filter-repo`, force-push only after rotation, and add the pattern to the scanner's self-test if it was missed.

### P2 — GitHub token / App compromise

- **OAuth App client secret**: P1 steps; additionally review the OAuth App's authorized users list on GitHub for unexpected authorizations (an attacker with the secret could complete code exchanges for sessions they phished).
- **GitHub App private key**: P1 steps; then on GitHub review recent installation-token activity; an attacker could have minted repo-scoped tokens for installed repositories — inspect those repositories' recent pushes/PRs; the App's own audit log shows token mints.
- **User-side GitHub token**: CodeForge holds none. If a user reports account compromise, revoke their CodeForge sessions (`revokeAllUserDeviceSessions`) and advise revoking the OAuth App and App installation on GitHub.

### P3 — Provider key compromise (platform key)

1. Set `CODEFORGE_HOSTED_INFERENCE_ENABLED=false` if spend is actively abnormal (fail-closed kill switch), redeploy.
2. Rotate at the provider; update env; re-enable.
3. Compare provider dashboard spend against `usage_events`/`hosted_requests` for the window; any spend without a matching hosted request is attacker spend.
4. Confirm `CODEFORGE_GLOBAL_DAILY_SPEND_LIMIT_USD` and `CODEFORGE_MAX_REQUEST_COST_USD` are set conservatively.

### P4 — Database compromise (dump or unauthorized access)

1. Rotate `DATABASE_URL` credentials at the provider; redeploy.
2. Assume every hash is offline-attackable: they are 256-bit random tokens, so no credential is recoverable, but **revoke all device and browser sessions anyway** (`UPDATE device_sessions SET revoked_at = now(), revoked_reason = 'breach' WHERE revoked_at IS NULL;` and the same for `browser_sessions`) so any token the attacker may have captured from elsewhere is dead.
3. The sealed PKCE verifiers are useless without the KEK ring; if the ring is also suspected, run P1 for the ring.
4. PII exposure (GitHub login/email/avatar, IPs, user agents, billing metadata, hosted task text) triggers the notification decision path.
5. Check backups: if the dump came from a backup, involve the provider's support and rotate backup access.

### P5 — Payment incident

- **Forged/replayed webhook suspicion**: verify `billing.webhook.signature_invalid` counts in the audit log; confirm `STRIPE_WEBHOOK_SECRET` matches the Stripe endpoint; rotate the endpoint secret if in doubt. Reconcile `credit_ledger` grants against Stripe's event list — every grant must cite a real `stripeEventId`.
- **Unauthorized grant**: revert with a compensating `appendLedgerEvent` (negative amount, description citing the incident id); sync entitlements to the correct plan.
- **Stripe key compromise**: P1; then review Stripe's dashboard for unexpected sessions/refunds. Live mode is refused at boot, so blast radius today is test-mode only.

### P6 — Cross-tenant exposure

1. Reproduce with two test accounts on staging; capture the request/response.
2. Hot-fix the ownership check; add the case to `tests/security/attack-acceptance.test.ts` (ATTACK-003/011 shape) before deploying.
3. Determine affected tenants from the audit log (`tenant.access.denied` only records refusals; for successes, query the resource table's access timestamps and the deployment window).
4. Notification decision path.

### P7 — Model / tool abuse (malicious repository or model drives the agent)

1. The affected user stops the run; export the local session (`Settings › Open data folder`) for analysis.
2. Determine whether any command executed outside the workspace boundary or read a credential: check for sanitized-env bypass (a spawn site not using `getSanitizedEnvForChild`) — that would be a code defect, SEV-1.
3. Add the payload to `packages/server/test/hardening-adversarial.test.ts`.
4. If a platform component (provider adapter, ForgeVerify) can be manipulated by model output, treat as a vulnerability (SEV-2) and patch.

### P8 — Local control plane / Electron compromise report

1. Verify the report against the packaged build (`npm run smoke`) and the baseline tests.
2. If a renderer can reach Node, read the bearer, or drive the API without it: SEV-1 for the desktop; ship a fixed release and note the affected versions in the GitHub Release and `SECURITY.md`.

### P9 — Dependency advisory (high/critical)

1. `npm run security:audit` shows the blocking advisory; determine reachability (is the vulnerable code path used?).
2. Patch (`npm audit fix` or targeted upgrade), run the full test suite, redeploy/release.
3. If a fix is unavailable, add a **dated, expiring** entry to `scripts/security/dependency-audit-allowlist.json` with the reachability analysis, and track it.

## Credential rotation summary (emergency order)

1. Kill switches (`CODEFORGE_HOSTED_INFERENCE_ENABLED=false`) if money is moving.
2. Provider keys → GitHub App key → OAuth client secret → Stripe → `JWT_SECRET` → KEK ring (staged) → `DATABASE_URL`.
3. Revoke sessions if user tokens may be affected.
4. Redeploy after each batch; confirm `/health/ready` and a staging sign-in.

## Notification decision path

| Question | If yes |
| --- | --- |
| Was personal data (GitHub identity, email, IP, billing metadata, hosted task text) exposed to an unauthorized party? | Counsel determines statutory notification duties (US state breach laws, GDPR Art. 33/34 where applicable) — REQUIRES LEGAL COUNSEL. Prepare a user notice draft regardless. |
| Was a user's GitHub-side resource touched (push, PR) by an attacker via CodeForge? | Notify the affected user directly with the repository, ref, and time; recommend reviewing the PR/commits and revoking the App installation until resolved. |
| Was a provider key abused? | Notify the provider (their key-abuse channel); include timestamps and request usage logs. |
| Was Stripe affected? | Notify Stripe support; keep Stripe's own event log as the system of record. |
| Did a researcher report it? | Acknowledge, keep them informed, credit in the advisory (see [SECURITY.md](../../SECURITY.md)). |

Public statements: only after containment, only facts, no speculation, no claims of "no data
accessed" unless the evidence proves it.

## Postmortem template

```text
Incident ID / severity / dates (detected, contained, resolved)
Summary (two sentences, no blame)
Timeline (UTC)
Root cause (technical), contributing factors
What worked / what did not
Data and tenants affected (classes from data-classification.md)
Actions taken (rotations, revocations, patches, notifications)
Follow-ups (owner, due date): tests added, docs updated, OWNER-ACTIONS entries
```

## Readiness checklist (what exists today)

- [x] Security audit trail (`security_audit_events`, redacted stdout lines)
- [x] Fail-closed kill switches and spend caps
- [x] Staged, tested key rotation; documented emergency order
- [x] Session revocation primitives (single device, all devices)
- [x] Acceptance suite to verify fixes (ATTACK-001…016)
- [ ] Named security contact and on-call rotation — OWNER-ACTIONS
- [ ] Alerting on audit-event thresholds (e.g. `billing.webhook.signature_invalid` spikes) — not implemented; Render log alerts are a deployment configuration
- [ ] Legal notification templates approved by counsel — REQUIRES LEGAL COUNSEL
