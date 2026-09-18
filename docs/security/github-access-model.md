# GitHub Access Model

Exactly what CodeForge can do with your GitHub account, why, and how to take it away.

## Two separate grants

CodeForge uses **two different GitHub integrations** on purpose. Signing in never grants
repository access; publishing requires a second, repository-scoped installation.

| | Identity sign-in | Publication authority |
| --- | --- | --- |
| GitHub mechanism | **OAuth App** (server-brokered authorization-code flow with PKCE) | **GitHub App** installed by you on selected repositories |
| Scopes / permissions requested | `read:user`, `user:email` — read your public profile and the email addresses you authorize. **No repository scope.** | `contents: write`, `pull_requests: write` on the repositories you selected during installation. Nothing else (no issues, actions, admin, secrets, or organization permissions) |
| What CodeForge stores | Your GitHub numeric id, login, avatar URL, display name, and the primary verified email you authorized (`identities` table) | The installation id, account login/type, `all`/`selected` repository selection, and the numeric ids + names of authorized repositories (`github_installations`, `github_repository_authorizations`) |
| What CodeForge does **not** store | The OAuth access token (read once, discarded) | Any installation token (minted per publication, ≤1 h, held in memory, never persisted) |
| Where the secret lives | `GITHUB_CLIENT_SECRET` in the Cloud env only | `GITHUB_APP_PRIVATE_KEY` in the Cloud env only |
| Client involvement | The desktop never sees the GitHub token or the client secret; it receives only a CodeForge session | The desktop never sees the App key or an installation token; it uploads a bundle and polls status |

## Why not one broad OAuth grant?

A classic OAuth `repo` scope gives the app write access to **every** repository the user can
reach, forever, with a long-lived token that must be stored. GitHub Apps invert that: you pick
repositories, GitHub scopes permissions per-installation, tokens are minted per operation and
expire in an hour, and the App private key never leaves the server. CodeForge additionally
narrows each minted token to **one repository id** (`repository_ids: [id]`) with only the two
permissions above, after re-checking the live installation still lists that repository
(`GitHubAppClient.mintRepositoryToken`). A stale or tampered authorization row cannot widen access.

## The publication flow (`packages/cloud-auth/src/github-app*.ts`, `apps/cloud-api/src/publication-*.ts`)

1. Desktop asks the Cloud to start authorization; the Cloud mints a single-use, 10-minute `state` and returns the App installation URL with that state.
2. You install the App on GitHub and choose repositories; GitHub returns to CodeForge with `installation_id` + `state`.
3. The Cloud consumes the state atomically, verifies it belongs to *your* CodeForge user (`INSTALLATION_OWNED_BY_OTHER_USER` / `AUTHORIZATION_USER_MISMATCH` otherwise), fetches the installation and its repository list with an App JWT, and records the authorized repository ids.
4. To publish, the desktop uploads a git bundle whose SHA-256 and byte length were declared up front; the Cloud verifies both, acquires a fenced lease, re-checks the repository against the live installation, mints the one-repository token, pushes with `git` (sanitized environment, no shell), opens the PR, records the receipt, and **deletes the bundle**.
5. If the App is uninstalled or suspended, the installation and all its repository grants are marked `revoked` and publications end in `authorization_revoked`; no token can be minted.

## Callback and token security

- Identity callback: one fixed HTTPS URL (`${CODEFORGE_PUBLIC_URL}/v1/auth/github/callback`); a loopback URL is never registered with GitHub; forged/replayed state ends on a static page (ATTACK-007/008).
- App callback state: 256-bit random, single-use, bound to the CodeForge user and device session.
- App JWTs: RS256, 9-minute life, created inside `GitHubAppClient` only; GitHub responses are collapsed to stable error codes so an `Authorization` header can never be echoed.
- Webhooks: CodeForge does **not** currently consume GitHub webhooks (installation changes are observed live at authorization/publication time). If webhooks are added, signature verification (`X-Hub-Signature-256`) is mandatory.

## Revocation and disconnect

| Action | Effect |
| --- | --- |
| Sign out of CodeForge Cloud (desktop) | Device session revoked server-side; access token dead immediately; the GitHub identity link remains until account deletion |
| Revoke the CodeForge OAuth App on GitHub (Settings › Applications › Authorized OAuth Apps) | Future sign-ins require re-authorization; existing CodeForge sessions are unaffected until they expire or you sign out (CodeForge holds no GitHub token to invalidate) |
| Uninstall or suspend the CodeForge GitHub App | All publication authority ends; the Cloud marks the installation `revoked` on next contact |
| Delete your CodeForge account (`DELETE /v1/account`, Settings › Profile) | Identity, sessions, installations, authorizations, publications, and staged bundles are deleted; GitHub-side grants must still be revoked on GitHub (CodeForge cannot remove them for you) |

## Least privilege checklist (what a reviewer can verify)

- [x] Identity OAuth requests no repository scope (`buildGitHubAuthUrl` default scope `read:user user:email`).
- [x] No GitHub token column exists in any migration.
- [x] Installation tokens are requested with `repository_ids` of length 1 and exactly `contents:write`, `pull_requests:write`.
- [x] The live installation is re-read before every mint; suspended installations are refused.
- [x] Bundles are content-addressed and deleted after use; purged on account deletion and terminal failure.
- [ ] GitHub webhook consumption — not implemented (nothing to verify).
- [ ] Organization SSO/SAML enforcement — a GitHub-side setting; CodeForge simply fails to mint if the installation is blocked (REQUIRES THIRD-PARTY VERIFICATION).
