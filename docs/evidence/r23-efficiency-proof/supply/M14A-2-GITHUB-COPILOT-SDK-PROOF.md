# M14A-2 — GitHub Copilot entitlement: official surface, minimal isolated proof, supply class

Status (2026-09-21 10:48Z): **SDK PROVEN READ-ONLY** on this machine — entitlement discovery works through
the official SDK with a per-user token; inference was **not** exercised (no token on this machine carries the
required permission, and none was created). Supply class: **User-Connected Entitlement** — never Managed Free.
Evidence: `copilot-sdk-entitlement-probe-2026-09-21.json` (redacted SDK output).

## 1. Retired path — GitHub Models API

`models.github.ai/catalog/models` returned **HTTP 410 `github_models_retirement_brownout`** (M14A addendum).
8-Bit now classifies HTTP 410 as `MODEL_RETIRED` (`remove_and_refresh`) — a brownout must never be retried into
a dead surface. GitHub Models is not a supply source and must not be re-added.

## 2. Current official surface — `@github/copilot-sdk`

| Fact | Value (verified) |
|---|---|
| Package | `@github/copilot-sdk` **1.0.14** (`latest`; `1.0.15-preview.0` prerelease) — MIT wrapper |
| Runtime | optional platform package `@github/copilot-sdk-win32-x64` (115 MB native runtime, **in-process via FFI**, no CLI subprocess); its license is `SEE LICENSE IN LICENSE.md` (GitHub's own terms, not MIT) |
| Client boot on Windows | `CopilotClient.start()` **48–84 ms**, `ping` OK |
| Auth | `new CopilotClient({ gitHubToken, useLoggedInUser: false })` — OAuth App token, GitHub App user token, or fine-grained PAT; env fallbacks `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` |
| Plan requirement | "A GitHub Copilot subscription is required to use the GitHub Copilot SDK, unless you are using BYOK"; Copilot Free is a subscription tier with limited quota |
| Billing | "Copilot requests are made on behalf of each authenticated user, using their Copilot subscription"; "Each user needs an active Copilot subscription" |
| Multi-tenant | official guides: "Run the SDK on servers", "Handle many concurrent users", per-session `gitHubToken` |
| Entitlement API | `client.rpc.account.getQuota({})` → `quotaSnapshots{chat, completions, premium_interactions}` each with `entitlementRequests`, `usedRequests`, `remainingPercentage`, `overage`, `overageAllowedWithExhaustedQuota`, `usageAllowedWithExhaustedQuota`, `resetDate` (marked `@experimental`) |
| Model API | `client.listModels()` → `ModelInfo{id, billing, policy, capabilities.limits, capabilities.supports.tool_calls}` |
| Usage receipts | `assistant.usage` session events (input/output tokens, premium-request cost multiplier) — not exercised here |

## 3. Minimal isolated proof (scratchpad, outside the repo; no dependency added to CodeForge)

Token: an existing **fine-grained PAT that has no Copilot permission**. Result:

- `account.getQuota` **succeeded**: `chat 200 entitled / 102 used (49% left)`, `completions 2000 / 0`,
  `premium_interactions 0 / 0`, all with `overageAllowedWithExhaustedQuota: false` and
  `usageAllowedWithExhaustedQuota: false` → this account **hard-stops** at quota; no billing spillover exists.
- `models.list` **failed closed** with the exact provider text:
  `checking third-party user token: unauthorized: Personal Access Token does not have "Copilot Requests" permission`.
  → **"Copilot Requests" is the permission a Connect flow must request.** Entitlement is readable without it;
  inference is not.
- No prompt was sent. No inference, no premium request, no charge.

The `gh` CLI's OAuth token on this machine (scopes `gist read:org repo workflow`) was not used: it has no Copilot
grant either, and the proof already answers the question without touching the keyring.

## 4. Feasibility

- **Desktop:** feasible. The runtime is an in-process native library loaded by Node (Electron main process);
  no extra install for the user; 115 MB platform package is a packaging decision (optional download vs bundled).
- **Server (cloud-api):** feasible and officially documented; one runtime per host, per-session user token.
- **Rate limits:** per-user, by subscription; the quota snapshot is the only quota signal (no headers). Poll it
  at connect time and after every N calls; degrade to `UNKNOWN` (route ineligible) when the RPC errors.

## 5. Interaction with CodeForge's GitHub login (must not change)

- Login today: OAuth App, PKCE + `state`, scope **`read:user user:email`** (`packages/cloud-auth`). Keep it.
- Copilot is a **separate, incremental "Connect GitHub Copilot" authorization** stored as a distinct
  connected-provider credential (encrypted at rest, per user, revocable; disconnect deletes it). The SDK docs
  recommend a GitHub App for new integrations; CodeForge already runs a GitHub App
  (`packages/cloud-auth/src/github-app.ts`) — the Copilot permission belongs on that app's user-to-server
  token, never on the identity login. Repository permissions stay their own grant.
- Never pool: a session may only ever carry the token of the user it serves (Alice's quota never serves Bob).

## 6. Supply-class recommendation

`USER_CONNECTED_ENTITLEMENT` (subscription-backed; includes Copilot Free). **Not Managed Free** — CodeForge
operates no quota here and pays nothing; the user's plan does. ForgeZero admission rule for the free path:

1. `getQuota` succeeded within the last N minutes and the relevant bucket has `usedRequests < entitlementRequests`
   with margin; else ineligible (`UNKNOWN` → fail closed).
2. `overageAllowedWithExhaustedQuota === true` (paid plans with overage budgets) → **refuse by default**; only an
   explicit per-user opt-in may allow spending into overage, and that path belongs to a paid supply class.
3. Model list filtered to `policy.state === "enabled"` and `capabilities.supports.tool_calls`.

## 7. What remains blocked (owner / legal)

1. **Legal review** — the SDK wrapper is MIT, the runtime binary and Copilot product terms are GitHub's; the
   documented use case (third-party apps, multi-tenant servers, per-user billing) matches CodeForge's, but the
   sign-off is the owner's, not the campaign's. `terms.status` stays `LEGAL_REVIEW_REQUIRED`.
2. **A token with "Copilot Requests"** (GitHub App user token or fine-grained PAT) to run the single-prompt
   proof: usage receipts (`assistant.usage`) → ForgeZero receipts, tool-call round-trip, quota decrement check.
3. Product decision: Settings → Connected providers → "GitHub Copilot" (state: `Account connection required`).

Nothing above is a workaround: every call used the official SDK with the user's own token.

## 8. M14A-3 — supply-side scaffolding landed (2026-09-21 ~14:55Z, no inference)

`packages/forge-zero/src/copilot-user-connected.ts` now implements the entitlement domain without touching
any inference path:

- `CopilotFreeConnection` / `COPILOT_PROVIDER_ID` (`github-copilot`) — `USER_CONNECTED_FREE`, `PER_USER_POOL`,
  `USER_ACCOUNT` scope, per-user pool id via `copilotPoolId` (account identity hashed, never raw).
- `evaluateCopilotFreeOnlyAdmission` — READY only with a proven hard stop: any bucket with
  `overageAllowedWithExhaustedQuota` or `usageAllowedWithExhaustedQuota` true → `PAID_CROSSOVER_BLOCKED`;
  missing bucket → `UNKNOWN_BALANCE`; stale `getQuota` observation (>15 min) → `STALE_QUOTA`; remainder
  under estimate → `EXHAUSTED`. `copilotHardStopProven` requires every observed bucket's post-quota flags
  explicitly false.
- `buildCopilotUserCapacityPool` — chat bucket → `requests` window, premiumInteractions → `provider_units`
  (zero premium never starves chat; completions is the inline-product surface, not agentic capacity).
- `buildCopilotUserRoute` — **ineligible by default**: `lifecycle: POLICY_REVIEW`,
  `managedMultiUserAllowed: false`, `explicitZeroPrice: false` (entitlement, not a $0 price),
  `paidFallbackDisabled: true`. Eligibility requires terms cleared + APPROVED + `freeOnlyAdmissionProven`.
- `CopilotUserConnectedFreeFleet` — projects only `policyEnabled && supportsToolCalls` models, per-user
  isolation, disconnect removes the user entirely.

Tests: `packages/forge-zero/test/copilot-user-connected.test.ts` — 11 tests green, built on the real account
fixture (chat 200/102, premium 0/0, hard-stop flags false). Still not implemented: the inference adapter
(Copilot SDK session → provider interface), token acquisition UX, `assistant.usage` → receipts. Those need
§7 items 1–3.
