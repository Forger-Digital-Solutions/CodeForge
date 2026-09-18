# Backups and Recovery

What is backed up, by whom, how it is protected, and how sealed data is restored (Phase 30).

## Inventory

| Data | Backed up by | Encryption | Access | Retention | Restore |
| --- | --- | --- | --- | --- | --- |
| Cloud PostgreSQL (accounts, sessions as hashes, sealed PKCE verifiers, billing/usage metadata, publication metadata, audit trail, hosted-workflow sessions) | The database provider (Supabase or Neon — chosen at deployment; `render.yaml` provisions no database) | Provider-managed storage encryption and backup encryption — **REQUIRES THIRD-PARTY VERIFICATION**; CodeForge adds no application-layer encryption except the sealed verifier | Provider dashboard credentials (owner) | Provider plan default (typically 7 days point-in-time on managed tiers) — **REQUIRES DEPLOYMENT CONFIGURATION** to confirm and document | Provider restore → redeploy Cloud with the same env (§"Restoring sealed rows") |
| Cloud env (all CRITICAL SECRETS) | **Not backed up by CodeForge.** Render holds them; the owner must keep an escrow copy in a password manager/secret manager | Render secret storage; owner's escrow | Owner | Until rotated | Re-enter in Render |
| Publication bundles (`<artifactDir>/<uuid>.bundle`) | Not backed up (transient by design; deleted after push) | Render disk | Cloud process | Until completion/terminal failure | Re-upload from the desktop (the desktop still has the certified commit) |
| Desktop `settings.json` (sealed BYOK keys, sealed Cloud tokens, preferences) | The user's own machine backup, if any | `safeStorage` — restorable only on the same OS user profile; DPAPI/Keychain blobs do not decrypt on another machine/user | User | User-controlled | Re-enter keys; sign in again |
| Desktop `codeforge.db` (task history, verification evidence) | User's machine backup | Redacted contents; OS permissions | User | User-controlled | Copy back into `userData` |
| Repositories / worktrees | Git (the user's remotes) | — | User | — | `git` |
| Source code of CodeForge | GitHub | — | — | — | clone |

## Restoring sealed rows

Sealed values (`cfe1.<kekVersion>.…`) are decryptable only with the KEK version they name.
Restore procedure:

1. Restore the database from the provider snapshot.
2. Deploy the Cloud with a `CODEFORGE_DATA_ENCRYPTION_KEYS` ring that **contains every KEK version referenced by rows in the snapshot** (`SELECT DISTINCT split_part(github_code_verifier, '.', 2) FROM oauth_transactions` shows the versions). The active version may be newer.
3. Rows whose version is missing fail closed (`ENVELOPE_KEY_UNAVAILABLE`, audited as `crypto.decrypt.failed`); with the current schema that only means an in-flight sign-in restarts.
4. Verify with a staging sign-in and `describeConfig` (`knownKeys=[…]` must include the snapshot's versions).

This procedure is exercised by ATTACK-016 in `tests/security/attack-acceptance.test.ts`: rows
are copied into a fresh database, the login completes with the same ring, and fails with a
different ring — proving that a backup is useless to a thief without the ring and useful to the
operator with it.

## Key escrow rule

Retired KEK versions must be kept in the owner's secret manager until every backup that could
contain rows sealed under them has aged out of the provider's retention window. Today's sealed
rows live ten minutes, so this rule has no practical cost yet; it becomes essential the day a
long-lived secret is sealed.

## Restore drill (staging)

1. Take a provider snapshot of staging.
2. Restore it to a fresh database.
3. Point a staging Cloud instance at it with the production-equivalent ring.
4. Run: `npm run cloud:pg:validate -- --url <restored>` (schema/migrations present),
   `npm run cloud:remote:probe -- --url <staging>` (health, meta, models), a manual sign-in.
5. Record the drill date and outcome in `docs/evidence/security-r1/` (none has been performed yet — **REQUIRES DEPLOYMENT CONFIGURATION**, listed in OWNER-ACTIONS).

## Deletion and backups (truthful statement for the privacy documents)

Account deletion hard-deletes rows in the live database. Provider snapshots taken before the
deletion still contain those rows until the snapshot ages out of the provider's retention window.
CodeForge cannot delete individual rows from a provider snapshot. The privacy documentation
states this rather than promising instant erasure from backups.
