# R26 Phase 10 — GitHub Integration Audit

**Date:** 2026-09-22
**Surface:** `packages/server/src/remote-publication-service.ts` + `github-pr-client.ts` (delivery → PR), `packages/cloud-auth/src/github-{oauth,app,webhook,app-authorization}.ts` (cloud auth)
**Tests re-run at HEAD:** `remote-publication.test.ts` 6/6, `github-webhook.test.ts` 10/10, `github-app.test.ts` 2/2 — **18/18 green standalone**

## Publication boundary (what CodeForge is allowed to do)

`RemotePublicationService` is deliberately narrow: push exactly one certified
delivery SHA to `refs/heads/codeforge-delivery-*` and create exactly one open
PR. **No merge, approval, release, or deployment methods exist.**

Verified behaviors (all re-run green at HEAD):

- Pushes only the certified SHA — remote `ls-remote` confirms the delivery
  branch head equals `delivery.deliveryRevision`; PR created once via HTTP.
- Crash-window reconciliation: a `PROCESS_TERMINATED` publish resumes without
  a duplicate push or duplicate PR (reconcile-by-identity, not retry).
- Remote target advanced → `remote_diverged` / `REMOTE_TARGET_DIVERGED`
  **before any branch mutation**.
- Unexpected history on the delivery branch → `remote_diverged`, no
  force-push, no PR.
- `authorization_required` gate — no push without explicit `authorize()`;
  authorization binds delivery id + revision + tree + repo:target; a remote
  URL swap after authorization invalidates it (`PUBLICATION_AUTHORIZATION_STALE`).
- No publication credential → fails before any git network mutation.
- Publication records never serialize the token (asserted in test).
- `git` invoked with sanitized env + `GIT_TERMINAL_PROMPT=0` — no credential
  helpers, no interactive prompt hijack.

## Cloud-auth surface

- **OAuth:** PKCE S256, minimal scope (`read:user user:email`), email
  selection prefers verified+primary and never trusts unverified addresses.
- **Webhooks:** HMAC-SHA256 `timingSafeEqual` over raw body before parse; 1 MiB
  cap; `X-GitHub-Delivery` claimed atomically (replay cannot double-apply a
  revocation — dedup survives restart, proven in test); payloads treated as
  untrusted — only identities are read, repo state reconciles through GitHub's
  own view (`refreshInstallation`), never the payload's claims.
- **PR client errors:** auth failure / rate-limit / provider-unavailable map
  to distinct codes; 5xx → `REMOTE_PROVIDER_UNAVAILABLE`; malformed payloads
  rejected.

## What is not proven (honest boundary)

- A real github.com round-trip (live PR create against a real repo) requires
  production mutation — a declared stop condition. Evidence substitutes:
  real `git push`/`ls-remote` against a bare remote + real HTTP against a
  fake GitHub endpoint asserting request shape.
- GitHub App installation token issuance against live GitHub is covered by
  unit tests of the JWT/refresh path, not a live App installation.

## Findings

- **F-R26-G1:** `remote-publication.test.ts` happy-path tests run 27–28s
  against a **30s** timeout — under concurrent CPU load they flake (observed:
  2 timeouts while electron-builder ran). Standalone: green. Recommend
  raising `testTimeout` for this file or isolating it in CI.

## Verdict

`R26_GITHUB_AUDIT_CLEAN` — the remote boundary is minimal, certified-SHA-only,
authorization-bound, crash-reconciling, and fails closed on divergence,
missing credentials, or remote tampering.
