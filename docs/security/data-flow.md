# Where Your Code and Prompts Actually Go

The honest data-flow map for CodeForge (Phase 15). This supersedes the technical facts in the
Pass-1 legal inventory (`docs/legal/data-flow-inventory.md`, September 10) wherever they
differ; that document predates account deletion, the retention sweep, the sealed verifier, and
the current schema.

## The short version

- Your repository stays on your machine. CodeForge does not clone, mirror, or sync it to CodeForge servers.
- When the agent asks a model something, the **prompt and the code context it selected** are sent to the model provider that serves the route — directly from your machine for BYOK/direct providers, or through CodeForge Cloud for Hosted Free/Paid routes. CodeForge Cloud streams that request through and **does not store the prompt**.
- If you use **Publish**, the certified commits are packaged as a git bundle and uploaded to CodeForge Cloud, which pushes them to GitHub with a one-repository token and **deletes the bundle**.
- Nothing is used to train CodeForge models. CodeForge trains no models on user content. Whether a *provider* trains on what it receives depends on that provider and tier; the privacy routing mode lets you exclude tiers whose terms permit training/retention.
- There is no product telemetry, analytics, or crash reporting.

## Flows

### 1. Local work (always)

| Data | Destination | Persistence | Notes |
| --- | --- | --- | --- |
| Repository files, edits, command output | Your disk; the local control plane in the Electron process | Task history in `userData/codeforge.db` (SQLite), tool output redacted before it is written | Workspace-bounded; never leaves the machine on its own |
| Context packing (files selected for a model request) | In memory → the model request | Not stored separately | `.env*`, `credentials.*`, `secrets.*`, key files, `id_rsa` are excluded by path; secrets in other files are pattern-redacted |
| Repository intelligence index | `LOCALAPPDATA`/`XDG_CACHE_HOME` cache | Until cleared | Local only |

### 2. Model requests

| Route family | Path | What the provider receives | What CodeForge Cloud receives | Retention |
| --- | --- | --- | --- | --- |
| BYOK / direct (your key) | Desktop → provider HTTPS | Prompt + selected context + tool results, under **your** key | Nothing (the Cloud is not in the path) | Provider's policy for your account/tier — REQUIRES THIRD-PARTY VERIFICATION per provider |
| Hosted Free (ForgeAuto via CodeForge Cloud) | Desktop → `POST /v1/hosted/inference` → provider | Same content, under CodeForge's server-owned key | The request **in transit only**; persists `usage_events` (provider, model, token counts, cost, latency, status) and `hosted_requests` (ids, credits, status) — **no prompt text, no output text** | Provider retention per its terms for CodeForge's account; some free tiers (e.g. Gemini unpaid) permit training/human review — the STRICT privacy mode excludes them |
| Paid Auto | Same as Hosted Free | Same | Same | Same; Stripe TEST mode only today |
| User-connected free candidates (e.g. Ollama Cloud, rollout-gated) | Desktop → provider with your own account credential | Same | Nothing | Provider's policy |

The provider never receives your CodeForge identity, your GitHub identity, or your other
providers' keys. CodeForge Cloud never receives BYOK keys.

### 3. Sign-in (CodeForge Cloud, optional)

| Data | Destination | Stored | Notes |
| --- | --- | --- | --- |
| GitHub authorization | Your browser → GitHub → Cloud callback | Cloud: GitHub numeric id, login, avatar URL, display name, authorized primary verified email | Scope `read:user user:email`; the GitHub access token is used once and discarded |
| Session | Desktop ↔ Cloud | Cloud: SHA-256 hash of the refresh token, device name, IP, user agent, timestamps; desktop: sealed tokens | Access token 1 h; refresh 30 d rotating |
| Account settings | Desktop → Cloud | Privacy routing mode, spend limit | — |

### 4. Publish (CodeForge Cloud + GitHub App, optional)

| Step | Data | Destination | Retention |
| --- | --- | --- | --- |
| Authorize | GitHub App installation id, account login/type, selected repository ids/names | Cloud DB | Until you revoke/uninstall or delete the account |
| Upload | Git bundle of the certified commits (≤256 MiB) + declared SHA-256/length + target branch/SHAs | Cloud artifact directory (server-derived UUID key) | Deleted immediately after the push and PR succeed; swept hourly after a terminal failure; purged on account deletion |
| Execute | Bundle bytes → `git push` with a one-repository, one-hour installation token | GitHub (your repository) | GitHub's retention (your repository) |
| Receipt | Publication id, commit/tree SHAs, PR number/URL, timestamps, error codes | Cloud DB | Until account deletion |

### 5. Billing (optional, Stripe TEST mode today)

| Data | Destination | Stored by CodeForge |
| --- | --- | --- |
| Card details | **Stripe-hosted** Checkout/Portal pages only | Never |
| Checkout/portal request | Cloud → Stripe API (user id as `client_reference_id`, price id chosen server-side) | Session id/URL returned to the desktop |
| Webhooks | Stripe → Cloud | Event id, type, status, minimized object (ids, amounts, statuses; no names/emails/addresses); subscription/plan/ledger rows |

### 6. Hosted workflows (Cloud API capability; not used by the shipping desktop today)

Task text (≤20 000 chars) and worker outputs (≤32 KiB) are stored in the Cloud database for the
workflow's life and deleted with the account. Documented because the routes exist and are
tested, not because the product currently exercises them.

## What never happens

- No repository is cloned or indexed on CodeForge servers.
- No prompt, completion, or code context is stored by CodeForge Cloud.
- No user content is used to train a CodeForge model.
- No telemetry, analytics, session replay, or crash report is sent anywhere.
- No BYOK key is uploaded; no platform key is downloaded.

## Where it is enforced / verified

Context exclusion: `packages/context/src/pack.ts`. Redaction: `packages/server/src/agent-runtime.ts`, `packages/secrets`. Hosted inference persistence: `packages/cloud-gateway/src/gateway-service.ts` (usage rows only). Bundle lifecycle: `apps/cloud-api/src/publication-service.ts`, `artifact-store.ts`. Webhook minimization: `packages/cloud-billing/src/stripe-service.ts` (`minimizeWebhookObject`). Telemetry absence: repository grep in the R1 certification (no crash reporter/analytics SDK is installed; `packages/telemetry` is an unused stub).
