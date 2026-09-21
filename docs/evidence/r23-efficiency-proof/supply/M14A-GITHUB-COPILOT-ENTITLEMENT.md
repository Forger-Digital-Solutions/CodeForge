# M14A — GitHub Copilot entitlement discovery (investigation)

Status: SURFACE CONFIRMED — official SDK exists; definition updated; no adapter built;
managed-relay terms still unreviewed.

## Prior determination (stale)

`provider-definitions.ts` marked `github-copilot` `terms.status: NOT_ALLOWED` —
"No supported third-party client integration; endpoint is a private VS Code surface"
(checked 2026-09-15). That was true of the private `api.githubcopilot.com` chat surface.
It is not true of the Copilot SDK.

## Current supported surface (verified 2026-09-21)

`@github/copilot-sdk` v1.0.14 on npm (repo: `github.com/github/copilot-sdk`), actively
published. Official docs confirm every mechanism the R23 brief requires:

| Brief requirement | SDK surface |
|---|---|
| GitHub OAuth → user identity | `docs/setup/github-oauth.md`: OAuth App or GitHub App token, `new CopilotClient({ gitHubToken })`, billed to **each user's own subscription** |
| Entitlement/quota discovery | `account.getQuota` RPC → `quotaSnapshots` keyed by `premium_interactions`, `chat`, `completions` (`entitlement`, `usedRequests`, `remainingPercentage`) |
| Model discovery + pricing | `models.list` RPC → per-model AI credit cost |
| Usage receipts | `assistant.usage` events: per-call `inputTokens`, `outputTokens`, premium-request `cost` multiplier; `session.usage.getMetrics` for accumulated totals (marked experimental) |
| Multi-tenant SaaS | `docs/setup/multi-tenancy.md`: per-session `gitHubToken`, `mode: "empty"` baseline, `RuntimeConnection.forUri` shared runtime — explicitly designed for SaaS |

This is exactly the brief's flow: CodeForge GitHub OAuth → user identity → `account.getQuota`
→ available models → usage → 8-Bit `USER_ENTITLEMENT_SUPPLY` → ForgeAuto. Alice's quota can
never serve Bob — the token, quota, and billing all belong to the authenticating user.

## Important shape caveat

The SDK is an **agent runtime** (it spawns/connects to the Copilot CLI process with its own
tool loop), not a raw chat-completions endpoint. CodeForge integration options:

- (a) Model-route adapter: session with `mode:"empty"` + no tools, send→response as one call.
- (b) Delegated-agent surface for recovery/difficult tasks.

Either way it is not a drop-in OpenAI-compatible route — adapter work is required.

## Known gaps / risks (from live evidence)

- Discussion `github/copilot-sdk#1532`: `account.getQuota` coverage of the newer
  **AI Credits** billing model is incomplete for whole-account views; session-level metrics
  are the reliable path today. Entitlement discovery must degrade to `UNKNOWN` rather than
  assume remaining quota.
- Premium-request **overage billing** is account-dependent (paid plans can bill overage;
  Free hard-stops). The free-only guard needs the account's plan/overage state before
  `freeOnlyAdmissionProven` can be set — `planDetection: "api"` via getQuota, plus a
  conservative default of not-proven.
- Managed multi-user relay terms (`terms.status`) remain `LEGAL_REVIEW_REQUIRED` — the SDK
  authorizes third-party *user-delegated* use; pooling/relaying is a separate question.

## Changes made

`provider-definitions.ts` `github-copilot` now records reality:

- `terms.status`: `NOT_ALLOWED` → `LEGAL_REVIEW_REQUIRED` (note cites the SDK distinction)
- `freeAccess.class`: `FREE_PRODUCT_ONLY` → `FREE_ACCOUNT_ENTITLEMENT`,
  `spillover: ACCOUNT_DEPENDENT`, `planDetection: "api"`
- `authClasses`: `["OAUTH_NATIVE"]` (the user's existing GitHub OAuth token is the credential)
- `userConnectedFree` profile added behind `githubCopilotUserEntitlement` flag,
  `termsClassification: USER_CONNECTED_FREE_PERMISSION_REQUIRED`
- `implemented: false` — no adapter; nothing routes.

## Owner/legal actions remaining

1. Legal review of Copilot SDK terms + Copilot plan terms for the intended usage class
   (user-delegated entitlement inside a third-party agent product).
2. If cleared: implement the SDK adapter (`session.usage` → ForgeZero usage receipts,
   `account.getQuota` → `OllamaFreeUsageObservation`-style per-user capacity observation),
   entitlement discovery, and exhaustion failover tests.
3. `githubCopilotUserEntitlement` flag stays off until both are done.
