# CodeForge FAQ

Straight answers about security, privacy, the AI agent, and models. Every answer here matches
the code in this repository as of the Security / Legal / Trust R1 campaign (2026-09-18); the
engineering detail behind each answer is linked.

## Security

**Is CodeForge encrypted?**
Network traffic uses HTTPS (and TLS with certificate validation between CodeForge Cloud and its
database). Credentials stored on your device are sealed with operating-system-backed encryption
(Electron `safeStorage`: DPAPI on Windows, Keychain on macOS, Secret Service on Linux where
available). The one reversible secret CodeForge Cloud stores — a ten-minute sign-in verifier —
is encrypted with AES-256-GCM under a versioned server-side key. Session credentials are stored as
one-way hashes. CodeForge is **not** end-to-end encrypted: the Cloud relay and the model provider
process your prompts in plaintext to do their job. Details: `docs/security/encryption.md`.

**Does CodeForge store my API keys?**
Only on your device, sealed as above, and only for providers you connect yourself (BYOK).
CodeForge Cloud has no table and no API for user keys. Delete a key in Settings › Providers and it
is gone from the device; revoke it at the provider to be certain.

**Can CodeForge see my BYOK key?**
The desktop's trusted process decrypts it when it makes a request to that provider; the user
interface only ever sees a "connected" status, and the Cloud never sees it at all.

**Does the AI model receive my API key?**
No. Keys are added to the HTTP request by the trusted process at the moment of sending. The model
sees the prompt, the code context, and tool results — never `Authorization` headers, platform
keys, or the local control-plane bearer. Tool output is passed through a secret redactor before
the model reads it, and agent subprocesses run with a credential-free environment. Tests:
`tests/security/attack-acceptance.test.ts` (ATTACK-004, ATTACK-005).

**Does CodeForge store my payment-card number?**
No. Card details are entered only on Stripe-hosted pages. CodeForge stores Stripe customer and
subscription identifiers, plan status, and minimized payment-event records (ids, amounts,
statuses). Billing is currently in Stripe test mode.

**How is GitHub access protected?**
Sign-in asks GitHub for your profile and email only (`read:user user:email`) and never stores the
GitHub token. Repository writes require installing the CodeForge GitHub App on repositories you
choose; each publication uses a token limited to one repository that expires in about an hour.
Details: `docs/security/github-access-model.md`.

**Can CodeForge access all of my repositories?**
Not through sign-in. Only the repositories you select when installing the GitHub App can be
published to, and only with `contents` and `pull_requests` write permission. If you chose "all
repositories" on GitHub, CodeForge still mints tokens one repository at a time and only for
repositories it recorded as authorized.

**What happens when I disconnect GitHub?**
Signing out of CodeForge Cloud revokes your session immediately. Revoking the OAuth App or
uninstalling the GitHub App on GitHub ends future sign-ins or publications respectively. CodeForge
holds no GitHub token to invalidate.

**What happens when I delete my account?**
Everything tied to the account in the live database is deleted in one transaction — identity,
sessions, settings, usage, ledger, entitlements, GitHub App authorizations, publication records
and staged bundles — every active session is revoked, and you receive a receipt with categories
and counts. Security audit events keep the event but lose your account id; billing records are
kept per the retention decision pending from the owner. Database snapshots age out per the
provider's retention window. Grants on GitHub and data at Stripe or model providers are outside
CodeForge's deletion. Details: `docs/privacy/retention-and-deletion.md`.

**Is my local machine safe from what the agent does?**
The agent works inside the workspace you opened (path traversal and symlink escapes are refused),
risky commands need your approval, and subprocesses never see your credentials. Approved
commands run with your operating-system privileges — review what you approve. CodeForge does not
sandbox your machine beyond that boundary.

**Is CodeForge SOC 2 / ISO 27001 / PCI / HIPAA / GDPR certified?**
No. CodeForge holds no third-party certification and makes no regulatory-compliance claim. The
controls it does have, and their status, are mapped in
`docs/security/compliance-readiness-matrix.md`.

## Privacy

**Does my source code leave my computer?**
Yes, when a task needs a model: the prompt and the code context the agent selected are sent to
the provider serving the route — directly for BYOK, or relayed through CodeForge Cloud for
Hosted Free. CodeForge Cloud does not store it. If you publish, the certified commits are uploaded
as a git bundle and deleted after the push. Nothing else leaves. Details:
`docs/security/data-flow.md`.

**Which AI providers may receive code?**
Whichever serves your route: for Hosted Free, a provider in CodeForge's verified free pool (today
OpenRouter and Groq, plus Gemini, Z.AI, and Cloudflare Workers AI when configured); for BYOK, the
provider you connected. The list and each provider's retention position:
`docs/privacy/third-party-processing.md`.

**Is my code used to train CodeForge?**
No. CodeForge trains no models. Whether a *provider* trains on what it receives depends on the
provider and tier — some free tiers (for example Google's unpaid Gemini API) permit it. The Strict
privacy routing mode excludes such tiers from ForgeAuto.

**How long is my data retained?**
Local data: until you clear it. Sign-in artifacts: minutes to 30 days, purged automatically. Cloud
account data: until you delete the account. Audit and billing records: pending an owner decision.
Backups: the provider's retention window.

**Can I delete or export my data?**
Delete: Settings › Profile › Delete account. Export: your account and usage are visible in the app
and via `GET /v1/account` / `GET /v1/usage`; a full JSON export is fulfilled manually on request
until an export endpoint exists. Procedure: `docs/privacy/privacy-rights-workflow.md`.

**Does CodeForge collect telemetry or use cookies?**
No product telemetry, analytics, session replay, or crash reporting exists. The only cookie is
the strictly necessary sign-in session cookie on the website flow. Details:
`docs/privacy/cookies-and-tracking.md`.

## AI / Agent

**Can CodeForge make mistakes?**
Yes. Generated code can contain bugs, insecure patterns, invented APIs, and dependencies whose
licences you must check. ForgeVerify and reviewers reduce the risk but cannot guarantee
correctness. Review changes before you rely on or deploy them.

**Does it execute code automatically?**
Within the execution mode and approvals you configure. Commands classified as risky wait for your
approval; the agent cannot mark a run complete without ForgeVerify evidence.

**What permissions does an agent receive?**
Read/write inside the opened workspace; the ability to run commands you approve with your OS
privileges; network access only through the commands you approve and the model routes you chose.
It receives no CodeForge credential, no provider key, and no control-plane bearer.

**Can it access CodeForge's platform secrets?**
No. Platform keys live only in CodeForge Cloud's environment; they are not on your machine, not
in the workspace, not in the agent's environment, and never in a response to your device. Tested
by ATTACK-004/005.

## Models and route families

**What is the difference between ForgeAuto, Paid Auto, BYOK, and GEMS?**
*ForgeAuto / Managed Free* routes through zero-cost routes that ForgeZero verified, using
CodeForge's own credentials via CodeForge Cloud, within your monthly allowance. *Paid Auto* is a
separate route family using CodeForge's paid credentials; it is disabled unless explicitly enabled
and billing is test-mode only today. *Individually selected paid models* and *BYOK* use your own
provider account directly from your machine. *GEMS Auto* is a future family; it is not executable
today. No family silently falls back to another, and no family shares another's credentials.

**Will ForgeAuto ever spend my money?**
ForgeAuto uses CodeForge's credentials, never yours, and only on routes verified as zero-cost;
if free status cannot be verified it declines to route. BYOK routes use your provider account
under that provider's pricing.

**Why is a model unavailable?**
Free capacity depends on providers' allowances, rate limits, and terms; CodeForge fails closed
rather than incur unverified cost, and operator safety limits (per-request ceilings, a global
daily spend cap, kill switches) can take a route offline.
