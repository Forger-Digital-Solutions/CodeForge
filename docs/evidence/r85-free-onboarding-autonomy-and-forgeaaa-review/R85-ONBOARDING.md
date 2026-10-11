# R85 zero-setup onboarding verification

Scope: install → GitHub sign-in → open project → describe task → CodeForge works, with **no user API key**.

## Proven locally (57/57 tests, `onboarding-tests.json`)

- PKCE desktop flow: verifier/challenge generated client-side; one-time exchange code; reusable credentials never reach the loopback listener (`cloud-auth-flow.test.ts`).
- Cloud contract gate: stale Cloud deployment is rejected before OAuth begins with an operator-actionable configuration error (`cloud-auth-flow.test.ts`).
- Packaged endpoint gate: production channel rejects missing/mismatched/loopback endpoints; loopback permitted only in explicit smoke mode (`packaged-auth-endpoint.test.ts`).
- Onboarding state: `completed:true` with an `apiKey` field present is invalid — the no-key path is enforced (`onboarding.test.ts`).
- Auth error surface: `describeCloudAuthFailure` preserves operator-actionable reasons without swallowing failures (`auth-error.test.ts`).
- Offline account handling and cloud-auth service package (19 suites total).
- `AuthScreen.tsx` copy: "Start free with CodeForge-managed AI models. No API key required." — consistent with hosted-entitlement design; age/host-execution acknowledgement present.

## Structural assessment

- `runCodeForgeCloudAuth` accepts `cloudApiUrl` — production endpoint embedded at packaging; development loopback gated to smoke mode.
- Free supply reaches the client through the hosted entitlement + packaged anonymous routes (`kilo-free-direct`, `blockrun-free-direct`, `ai-horde`) — the same routes exercised by the R85 live campaigns; no setup step exists in the UI or config path.
- Sign-in/entitlement failures fail closed (compatibility error before OAuth; no credential persistence at loopback).

## NOT proven — honest gap

- **Fresh installed GitHub-authenticated end-to-end run**: requires (a) a deployed `apps/cloud-api` instance with a configured GitHub OAuth app (`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`) and (b) a real GitHub account sign-in through the browser. Neither exists in this environment. Static + unit coverage verifies the transport contract but a live OAuth round-trip was not executed.
- Packaged-installer evidence (signed installer, first-run flow) — no installer build was produced this milestone.
- Therefore: zero-setup onboarding is **architecturally verified and unit-verified**, not end-to-end verified. This remains a milestone blocker for `CODEFORGE_R85_VERIFIED` unless executed against a deployed Cloud.
