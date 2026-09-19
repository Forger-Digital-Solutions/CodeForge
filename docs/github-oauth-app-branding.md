# GitHub OAuth App branding — owner action required

The GitHub authorization screen (github.com/login/oauth/authorize) renders a small circular
application badge next to the GitHub logo. That badge is stored on the **GitHub OAuth App
itself** — it cannot be changed from repository code, from the desktop build, or from the
Render deployment config. Today the CodeForge OAuth App shows GitHub's generated identicon
(green pixel pattern) instead of the CodeForge mark.

Everything below is an owner action in the GitHub account that owns the OAuth App
(Forger Digital Solutions). Nothing here changes client IDs, secrets, callback URLs, or
scopes — this is cosmetic branding only.

## What to upload

Use the square atomic-diamond mark:

```text
apps/desktop/assets/icon.png        (512 × 512 PNG, dark circular badge)
apps/desktop/assets/icon-256.png    (256 × 256 PNG, same mark, smaller)
```

GitHub requires a square image at least 200 × 200 px and displays it at ~40 px inside a
circle-masked badge. `icon.png` (512 × 512) is the recommended upload. The asset already
reads correctly inside a circular crop: the diamond and orbit ring are centered with dark
padding to the edges. Do **not** upload the horizontal wordmark or a screenshot — the badge
is tiny and round; only the icon survives.

## Where to set it

1. Sign in to GitHub as the owner of the `CodeForge` OAuth App (Forger Digital Solutions
   organization account, or the user account that registered the app).
2. Navigate to:

   **GitHub → Settings → Developer settings → OAuth Apps → CodeForge**

   (Organization-owned apps may instead live under
   `github.com/organizations/<org>/settings/oauth_apps` → CodeForge.)

3. Under **Application logo**, choose **Upload new logo** and select
   `apps/desktop/assets/icon.png`.
4. Save. The badge updates on the next authorization page view; no code or redeploy is
   needed.

## While you are there — verify, do not change

| Field | Expected value |
| --- | --- |
| Application name | `CodeForge` |
| Owned by | Forger Digital Solutions |
| OAuth client ID (production, verified via `/v1/auth/start`) | `Ov23liH1JnjFlJJJyQcL` |
| Authorization callback URL | `https://codeforge-cloud-va.onrender.com/v1/auth/github/callback` |
| Scopes requested by the flow | `read:user user:email` (set in `packages/cloud-auth/src/github-oauth.ts`; not part of app settings) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Render env vars (`render.yaml`, `sync: false`) — leave untouched |

If any of these differ, stop and reconcile with `docs/cloud-operator-runbook.md` before
proceeding — the desktop's loopback PKCE flow depends on the Cloud callback remaining
exactly as registered.
